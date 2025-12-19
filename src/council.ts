/**
 * Council bootstrap and lifecycle management
 */

import { monotonicUlid } from "@std/ulid";
import { CandidatePool } from "./candidate-pool.ts";
import type { Candidate, CouncilDB, CouncilState, Member } from "./db.ts";
import type { LLMProvider } from "./llm.ts";
import { buildCouncilIntro } from "./persona.ts";
import { defaultLogger, type Logger } from "./utils/logger.ts";

const COUNCIL_SIZE = 8;
const INITIAL_POOL_SIZE = 20;
const MIN_COUNCIL_SIZE = 3;
const POOL_RECOVERY_INTERVAL_MS = 5000;

export class Council {
  private candidatePool: CandidatePool;
  private logger: Logger;
  private operationInProgress = false;
  private isRecoveryRunning = false;
  private currentSleepTimer: number | null = null;

  constructor(
    private db: CouncilDB,
    private llm: LLMProvider,
    logger: Logger = defaultLogger,
  ) {
    this.logger = logger;
    this.candidatePool = new CandidatePool(db, llm, logger);
  }

  /**
   * Check if the council has minimum required members for voting
   */
  async hasMinimumMembers(): Promise<boolean> {
    const state = await this.db.getCouncilState();
    return state.memberIds.length >= MIN_COUNCIL_SIZE;
  }

  /**
   * Get current member count
   */
  async getMemberCount(): Promise<number> {
    const state = await this.db.getCouncilState();
    return state.memberIds.length;
  }

  /**
   * Mark an operation as in progress (blocks recovery)
   */
  setOperationInProgress(inProgress: boolean): void {
    this.operationInProgress = inProgress;
  }

  /**
   * Check if an operation is currently in progress
   */
  isOperationInProgress(): boolean {
    return this.operationInProgress;
  }

  /**
   * Start periodic pool recovery checks
   * Runs recursively with a delay between checks
   */
  async startPeriodicRecovery(): Promise<void> {
    if (this.isRecoveryRunning) {
      return; // Already running
    }

    this.isRecoveryRunning = true;
    this.logger.operation(
      "[RECOVERY] Starting periodic pool recovery loop",
    );

    // Start the recursive loop
    return await this.runRecoveryLoop();
  }

  /**
   * Stop periodic pool recovery
   */
  stopPeriodicRecovery(): void {
    if (this.isRecoveryRunning) {
      this.isRecoveryRunning = false;
      if (this.currentSleepTimer !== null) {
        clearTimeout(this.currentSleepTimer);
        this.currentSleepTimer = null;
      }
      this.logger.operation("[RECOVERY] Stopping periodic pool recovery loop");
    }
  }

  /**
   * Recursive recovery loop
   */
  private async runRecoveryLoop(): Promise<void> {
    if (!this.isRecoveryRunning) return;

    const startTime = Date.now();

    // Run the check
    await this.runRecoveryCheck();

    if (!this.isRecoveryRunning) return;

    // Calculate delay
    const duration = Date.now() - startTime;
    const delay = Math.max(0, POOL_RECOVERY_INTERVAL_MS - duration);

    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, delay);

        // If we stop, we should ideally clear this timeout, but we don't have a reference to it outside.
        // Instead, we can check isRecoveryRunning inside the callback?
        // No, the promise needs to resolve for the loop to continue (and then check flag).
        // But for tests, we need to ensure no pending timers.

        // Let's store the timer ID so stopPeriodicRecovery can clear it.
        // But this is a local variable.
        // We can use a class property for the current sleep timer.
        this.currentSleepTimer = timer;
      });
      this.currentSleepTimer = null;
    }

    // Recursive call for next round
    if (this.isRecoveryRunning) {
      await this.runRecoveryLoop();
    }
  }

  /**
   * Run a single recovery check
   * Skipped if an operation is in progress
   */
  private async runRecoveryCheck(): Promise<void> {
    if (this.operationInProgress) {
      this.logger.operation(
        "[RECOVERY] Skipping recovery check - operation in progress",
      );
      return;
    }

    try {
      const state = await this.db.getCouncilState();

      {
        const { items: members } = await this.db.getAllMembers();
        state.memberIds = members.map((m) => m.id);
      }

      {
        const { items: candidates } = await this.db.getAllCandidates();
        state.candidateIds = candidates.map((c) => c.id);
      }

      // Ensure target pool size is set
      state.targetPoolSize ||= INITIAL_POOL_SIZE;

      // If council is not full, try to create one candidate per check
      // This spreads the load across multiple recovery cycles
      if (state.memberIds.length < COUNCIL_SIZE) {
        const needed = COUNCIL_SIZE - state.memberIds.length;

        if (state.candidateIds.length < needed) {
          // Create one candidate per recovery cycle to spread load
          this.logger.operation(
            `[RECOVERY] Creating candidate (${
              state.candidateIds.length + 1
            }/${needed} needed for council)",`,
          );
          await this.candidatePool.createCandidate(state);
          await this.db.saveCouncilState(state);
          return; // Exit early, will continue in next cycle
        }

        // Enough candidates exist, promote to fill council
        await this.initializeCouncil(state);
      }

      // Replenish candidate pool one at a time
      if (state.candidateIds.length < state.targetPoolSize) {
        this.logger.operation(
          `[RECOVERY] Replenishing pool (${state.candidateIds.length}/${state.targetPoolSize})",`,
        );
        await this.candidatePool.createCandidate(state);
      }

      await this.db.saveCouncilState(state);
    } catch (error) {
      this.logger.operation(
        `[RECOVERY] Error during recovery check: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Initialize council by selecting from candidates
   */
  private async initializeCouncil(state: CouncilState): Promise<void> {
    const needed = COUNCIL_SIZE - state.memberIds.length;

    // Shuffle candidates and select
    const shuffled = [...state.candidateIds].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(needed, shuffled.length));

    for (const candidateId of selected) {
      const candidate = await this.db.getCandidate(candidateId);
      if (!candidate) continue;

      // Convert to member
      const member: Member = {
        id: monotonicUlid(),
        persona: candidate.persona,
        createdAt: candidate.createdAt,
        promotedAt: Date.now(),
        chatHistory: [
          {
            role: "system",
            content: buildCouncilIntro(),
            timestamp: Date.now(),
          },
          ...candidate.chatHistory.slice(-5),
        ],
      };

      this.logger.operation(
        `[PROMOTE] Candidate "${candidate.persona.name}" (${candidateId}) promoted to council member during bootstrap`,
      );

      await this.db.saveMember(member);
      await this.db.deleteCandidate(candidateId);

      state.memberIds.push(member.id);
      state.candidateIds = state.candidateIds.filter((id) =>
        id !== candidateId
      );
    }
  }

  /**
   * Get current council state summary
   */
  async getStatus(): Promise<{
    members: Member[];
    candidates: Candidate[];
    state: CouncilState;
  }> {
    const state = await this.db.getCouncilState();
    const [members, candidates] = await Promise.all([
      this.db.getMembersByIds(state.memberIds),
      this.db.getCandidatesByIds(state.candidateIds),
    ]);

    return { members, candidates, state };
  }

  /**
   * Get candidate pool manager
   */
  getCandidatePool(): CandidatePool {
    return this.candidatePool;
  }
}
