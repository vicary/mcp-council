/**
 * Council bootstrap and lifecycle management
 */

import { CandidatePool } from "./candidate-pool.ts";
import type { Candidate, CouncilDB, CouncilState, Member } from "./db.ts";
import type { LLMProvider } from "./llm.ts";
import { buildCouncilIntro } from "./persona.ts";
import { generateMemberId } from "./utils/id.ts";
import { defaultLogger, type Logger } from "./utils/logger.ts";

const COUNCIL_SIZE = 8;
const INITIAL_POOL_SIZE = 20;

export class Council {
  private candidatePool: CandidatePool;
  private logger: Logger;

  constructor(
    private db: CouncilDB,
    private llm: LLMProvider,
    logger: Logger = defaultLogger,
  ) {
    this.logger = logger;
    this.candidatePool = new CandidatePool(db, llm, logger);
  }

  /**
   * Bootstrap the council on startup
   */
  async bootstrap(): Promise<void> {
    const state = await this.db.getCouncilState();

    // Restore existing members and candidates from DB
    const existingMembers = await this.db.getAllMembers();
    const existingCandidates = await this.db.getAllCandidates();

    // Sync state with actual DB contents
    state.memberIds = existingMembers.map((m) => m.id);
    state.candidateIds = existingCandidates.map((c) => c.id);

    // Ensure target pool size is set
    if (state.targetPoolSize === 0) {
      state.targetPoolSize = INITIAL_POOL_SIZE;
    }

    // If council is not full, first ensure we have enough candidates, then promote
    if (state.memberIds.length < COUNCIL_SIZE) {
      // Step 1: Create candidates until we have enough to fill the council
      const needed = COUNCIL_SIZE - state.memberIds.length;
      while (state.candidateIds.length < needed) {
        await this.candidatePool.createCandidate(state);
        // Re-read state from DB to get the newly created candidate IDs
        const freshState = await this.db.getCouncilState();
        state.candidateIds = freshState.candidateIds;
      }

      // Step 2: Now promote candidates to fill the council
      await this.initializeCouncil(state);
    }

    // Finally, replenish the candidate pool to target size
    await this.candidatePool.replenishPool(state);

    await this.db.saveCouncilState(state);
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
        id: generateMemberId(),
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
    const members: Member[] = [];
    const candidates: Candidate[] = [];

    for (const id of state.memberIds) {
      const member = await this.db.getMember(id);
      if (member) members.push(member);
    }

    for (const id of state.candidateIds) {
      const candidate = await this.db.getCandidate(id);
      if (candidate) candidates.push(candidate);
    }

    return { members, candidates, state };
  }

  /**
   * Get candidate pool manager
   */
  getCandidatePool(): CandidatePool {
    return this.candidatePool;
  }
}
