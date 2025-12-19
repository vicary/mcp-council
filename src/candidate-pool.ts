/**
 * Candidate pool management - practice rounds, creation, eviction
 */

import { monotonicUlid } from "@std/ulid";
import type { Candidate, CouncilDB, CouncilState } from "./db.ts";
import type { ChatMessage, LLMProvider } from "./llm.ts";
import type { Proposal, Vote } from "./orchestrator.ts";
import {
  buildCandidateIntro,
  buildProposalPrompt,
  buildSystemPrompt,
  buildVotePrompt,
  generatePersona,
} from "./persona.ts";
import { defaultLogger, type Logger } from "./utils/logger.ts";
import {
  resilientParallel,
  type RetryExhaustedError,
} from "./utils/resilient.ts";
import {
  CANDIDATE_SUMMARIZE_THRESHOLD,
  summarizeRemovalCauses,
} from "./utils/summarize.ts";

/**
 * Result of a candidate practice round
 */
export interface PracticeRoundResult {
  proposals: Proposal[];
  votes: Vote[];
  evictions: string[];
  survivors: string[];
  /** Errors from candidates that failed to respond after retries */
  errors: string[];
}

const NULLIFICATION_THRESHOLD = 0.75;

export class CandidatePool {
  constructor(
    private db: CouncilDB,
    private llm: LLMProvider,
    private logger: Logger = defaultLogger,
  ) {}

  /**
   * Run practice round for candidates after council vote
   */
  async runPracticeRound(prompt: string): Promise<PracticeRoundResult> {
    const state = await this.db.getCouncilState();
    const candidates = await this.db.getCandidatesByIds(state.candidateIds);

    if (candidates.length < 2) {
      return {
        proposals: [],
        votes: [],
        evictions: [],
        survivors: candidates.map((c) => c.id),
        errors: [],
      };
    }

    // Collect errors throughout the practice round
    const allErrors: RetryExhaustedError[] = [];

    // Proposals (parallel with retry)
    const { proposals, errors: proposalErrors } = await this.collectProposals(
      candidates,
      prompt,
    );
    allErrors.push(...proposalErrors);

    // Votes (parallel with retry)
    const { votes, errors: voteErrors } = await this.collectVotes(
      candidates,
      proposals,
    );
    allErrors.push(...voteErrors);

    // Calculate vote counts
    const voteCounts = new Map<string, number>();
    for (const vote of votes) {
      if (vote.proposalMemberId) {
        voteCounts.set(
          vote.proposalMemberId,
          (voteCounts.get(vote.proposalMemberId) || 0) + 1,
        );
      }
    }

    // Update fitness based on votes received
    for (const candidate of candidates) {
      candidate.fitness += voteCounts.get(candidate.id) || 0;
    }
    await this.db.saveCandidates(candidates);

    // Eviction vote (with retry)
    const { evictions, errors: evictionErrors } = await this.processEvictions(
      candidates,
      proposals,
      votes,
      voteCounts,
      state,
    );
    allErrors.push(...evictionErrors);

    const survivors = candidates
      .filter((c) => !evictions.includes(c.id))
      .map((c) => c.id);

    // Allow survivors to update persona
    await this.updateSurvivorPersonas(survivors);

    return {
      proposals,
      votes,
      evictions,
      survivors,
      errors: allErrors.map((e) => e.message),
    };
  }

  private async collectProposals(
    candidates: Candidate[],
    prompt: string,
  ): Promise<{ proposals: Proposal[]; errors: RetryExhaustedError[] }> {
    const userContent = buildProposalPrompt(prompt, true);

    const operations = candidates.map((candidate) => ({
      label: `practice proposal from ${candidate.persona.name}`,
      fn: async (): Promise<Proposal> => {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(candidate.persona),
            timestamp: Date.now(),
          },
          ...candidate.chatHistory.slice(-5),
          {
            role: "user",
            content: userContent,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          content: string;
          reasoning: string;
        }>(messages, "", candidate.persona.model);

        // Save the prompt and response to chat history
        const userMsg: ChatMessage = {
          role: "user",
          content: userContent,
          timestamp: Date.now(),
        };
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: JSON.stringify(response),
          timestamp: Date.now(),
        };
        candidate.chatHistory.push(userMsg, assistantMsg);

        // Also save to separate history storage for TUI review
        await this.db.appendManyToHistory("candidate", candidate.id, [
          userMsg,
          assistantMsg,
        ]);

        // Summarize active context if needed
        if (candidate.chatHistory.length > CANDIDATE_SUMMARIZE_THRESHOLD) {
          candidate.chatHistory = await this.llm.text(
            [
              {
                role: "system",
                content:
                  "Summarize the following conversation history concisely, preserving key decisions, votes, and context.",
                timestamp: Date.now(),
              },
              {
                role: "user",
                content: candidate.chatHistory
                  .map((m) => `${m.role}: ${m.content}`)
                  .join("\n"),
                timestamp: Date.now(),
              },
            ],
            candidate.persona.model,
          ).then((summary) => [
            {
              role: "system" as const,
              content: `[Previous history summary]: ${summary}`,
              timestamp: Date.now(),
            },
            ...candidate.chatHistory.slice(-3),
          ]);
        }

        await this.db.saveCandidate(candidate);

        return {
          memberId: candidate.id,
          content: response.content,
          reasoning: response.reasoning,
        };
      },
    }));

    const { successes, failures } = await resilientParallel(operations);
    return { proposals: successes, errors: failures };
  }

  private async collectVotes(
    candidates: Candidate[],
    proposals: Proposal[],
  ): Promise<{ votes: Vote[]; errors: RetryExhaustedError[] }> {
    // Pre-build proposal summary for all votes
    const proposalSummary = proposals
      .map((p, i) =>
        `Proposal ${i + 1}:\n${p.content}\nReasoning: ${p.reasoning}`
      )
      .join("\n\n");
    const votePrompt = buildVotePrompt(proposalSummary);

    const operations = candidates.map((candidate) => ({
      label: `practice vote from ${candidate.persona.name}`,
      fn: async (): Promise<Vote> => {
        const otherProposals = proposals.filter(
          (p) => p.memberId !== candidate.id,
        );

        if (otherProposals.length === 0) {
          return {
            voterId: candidate.id,
            proposalMemberId: null,
            reasoning: "No other proposals",
          };
        }

        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(candidate.persona),
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: votePrompt,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          vote: number | null;
          reasoning: string;
        }>(messages, "", candidate.persona.model);

        const votedProposal = response.vote !== null
          ? otherProposals[response.vote - 1]
          : null;

        return {
          voterId: candidate.id,
          proposalMemberId: votedProposal?.memberId || null,
          reasoning: response.reasoning,
        };
      },
    }));

    const { successes, failures } = await resilientParallel(operations);
    return { votes: successes, errors: failures };
  }

  private async processEvictions(
    candidates: Candidate[],
    proposals: Proposal[],
    votes: Vote[],
    voteCounts: Map<string, number>,
    state: CouncilState,
  ): Promise<{ evictions: string[]; errors: RetryExhaustedError[] }> {
    // Check nullification: 75% votes protects from eviction
    const totalVotes = votes.filter((v) => v.proposalMemberId).length;
    const shielded = new Set<string>();
    for (const [candidateId, count] of voteCounts) {
      if (totalVotes > 0 && count / totalVotes >= NULLIFICATION_THRESHOLD) {
        shielded.add(candidateId);
      }
    }

    // Eviction nominations (with retry)
    const operations = candidates.map((candidate) => ({
      label: `eviction nomination from candidate ${candidate.persona.name}`,
      fn: async () => {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(candidate.persona),
            timestamp: Date.now(),
          },
          {
            role: "user",
            content:
              `Based on proposals and votes, nominate ONE candidate for eviction (or none) ONLY IF they demonstrate:
1. Malicious or harmful behavior.
2. Refusal to engage with the council's purpose.
3. Repetitive, low-quality, or nonsensical outputs.

CRITICAL: Do NOT nominate a candidate simply for disagreeing with you or the majority. Divergent viewpoints are essential.

Proposals:
${proposals.map((p, i) => `${i + 1}. ${p.content}`).join("\n")}

Respond in JSON format:
{
  "nominee": <candidate number 1-${candidates.length} or null>,
  "reasoning": "why you nominated them (must cite specific harmful behavior) or chose not to"
}`,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          nominee: number | null;
          reasoning: string;
        }>(messages, "", candidate.persona.model);

        return {
          nominatorId: candidate.id,
          nomineeId: response.nominee !== null
            ? candidates[response.nominee - 1]?.id || null
            : null,
          reasoning: response.reasoning,
        };
      },
    }));

    const { successes: nominations, failures: errors } =
      await resilientParallel(operations);

    // Count nominations
    const nominationCounts = new Map<string, number>();
    for (const nom of nominations) {
      if (nom.nomineeId && !shielded.has(nom.nomineeId)) {
        nominationCounts.set(
          nom.nomineeId,
          (nominationCounts.get(nom.nomineeId) || 0) + 1,
        );
      }
    }

    // Simple majority eviction
    const majority = Math.ceil(candidates.length / 2);
    const evicted: string[] = [];

    for (const [candidateId, count] of nominationCounts) {
      if (count >= majority) {
        // Get candidate name for logging
        const evictedCandidate = candidates.find((c) => c.id === candidateId);
        this.logger.operation(
          `[EVICT] Candidate "${evictedCandidate?.persona.name}" (${candidateId}) evicted with ${count}/${candidates.length} nominations (majority: ${majority})`,
        );

        evicted.push(candidateId);

        // Collect reasons from nominations
        const reasons = nominations
          .filter((n) => n.nomineeId === candidateId)
          .map((n) => n.reasoning)
          .join("; ");

        // Record cause
        const cause =
          `Candidate evicted by majority (${count}/${candidates.length}): ${reasons}`;
        state.lastRemovalCauses = [
          cause,
          ...state.lastRemovalCauses.slice(0, 9),
        ];

        // Evict candidate (mark as evicted, don't delete permanently)
        await this.db.evictCandidate(candidateId, reasons);
        state.candidateIds = state.candidateIds.filter(
          (id) => id !== candidateId,
        );
      }
    }

    if (evicted.length > 0) {
      state.removalHistorySummary = await summarizeRemovalCauses(
        state.lastRemovalCauses,
        this.llm,
      );
    }

    // Create new candidates if below target
    await this.replenishPool(state);

    await this.db.saveCouncilState(state);
    return { evictions: evicted, errors };
  }

  private async updateSurvivorPersonas(survivorIds: string[]): Promise<void> {
    const candidates = await this.db.getCandidatesByIds(survivorIds);

    // Filter candidates that will evolve (30% chance)
    const candidatesToEvolve = candidates.filter(() => Math.random() < 0.3);
    if (candidatesToEvolve.length === 0) return;

    // Run all persona refinement LLM calls in parallel
    const refinementResults = await Promise.allSettled(
      candidatesToEvolve.map(async (candidate) => {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content:
              `You are ${candidate.persona.name}. Based on your practice round experience, you may refine one of your traits or values slightly.`,
            timestamp: Date.now(),
          },
          {
            role: "user",
            content: `Current values: ${candidate.persona.values.join(", ")}
Current traits: ${candidate.persona.traits.join(", ")}

Would you like to refine any aspect? Respond in JSON:
{
  "refined": true/false,
  "newValues": [...] (if refined),
  "newTraits": [...] (if refined)
}`,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          refined: boolean;
          newValues?: string[];
          newTraits?: string[];
        }>(messages, "", candidate.persona.model);

        if (response.refined) {
          if (response.newValues) {
            candidate.persona.values = response.newValues;
          }
          if (response.newTraits) {
            candidate.persona.traits = response.newTraits;
          }
          return candidate;
        }
        return null;
      }),
    );

    // Collect successfully refined candidates
    const refinedCandidates = refinementResults
      .filter((r): r is PromiseFulfilledResult<Candidate | null> =>
        r.status === "fulfilled"
      )
      .map((r) => r.value)
      .filter((c): c is Candidate => c !== null);

    // Batch save all refined candidates
    if (refinedCandidates.length > 0) {
      await this.db.saveCandidates(refinedCandidates);
    }
  }

  /**
   * Replenish candidate pool if below target
   */
  async replenishPool(state: CouncilState): Promise<void> {
    while (state.candidateIds.length < state.targetPoolSize) {
      await this.createCandidate(state);
    }
  }

  /**
   * Create a new candidate with generated persona
   */
  async createCandidate(state: CouncilState): Promise<Candidate> {
    // Get all existing personas in parallel
    const [members, candidateList] = await Promise.all([
      this.db.getMembersByIds(state.memberIds),
      this.db.getCandidatesByIds(state.candidateIds),
    ]);

    const existingPersonas = [
      ...members.map((m) => m.persona),
      ...candidateList.map((c) => c.persona),
    ];

    // Get last eviction cause for context
    const lastCause = state.lastRemovalCauses[0];

    // Generate persona
    const persona = await generatePersona(
      this.llm,
      existingPersonas,
      lastCause,
    );

    const candidate: Candidate = {
      id: monotonicUlid(),
      persona,
      createdAt: Date.now(),
      fitness: 0,
      chatHistory: [
        {
          role: "system",
          content: buildCandidateIntro(),
          timestamp: Date.now(),
        },
        {
          role: "system",
          content: `Recent council removal reasons:\n${
            state.lastRemovalCauses.slice(0, 10).join("\n") || "None yet"
          }`,
          timestamp: Date.now(),
        },
      ],
    };

    await this.db.saveCandidate(candidate);
    state.candidateIds.push(candidate.id);

    return candidate;
  }
}
