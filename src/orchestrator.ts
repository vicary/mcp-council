/**
 * Council orchestrator - manages voting flow and rounds
 */

import type { Candidate, CouncilDB, CouncilState, Member } from "./db.ts";
import type { ChatMessage, LLMProvider } from "./llm.ts";
import { buildDemotionNotice, buildSystemPrompt } from "./persona.ts";
import { defaultLogger, type Logger } from "./utils/logger.ts";
import {
  resilientParallel,
  type RetryExhaustedError,
} from "./utils/resilient.ts";
import { anonymizeSummary, summarizeHistory } from "./utils/summarize.ts";

/**
 * Proposal from a council member
 */
export interface Proposal {
  memberId: string;
  content: string;
  reasoning: string;
}

/**
 * Vote cast by a council member
 */
export interface Vote {
  voterId: string;
  proposalMemberId: string | null;
  reasoning: string;
}

/**
 * Eviction nomination from a member
 */
export interface EvictionNomination {
  nominatorId: string;
  nomineeId: string | null;
  reasoning: string;
}

/**
 * Result of eviction vote for a member
 */
export interface EvictionResult {
  memberId: string;
  nominations: EvictionNomination[];
  evicted: boolean;
  replacement?: string;
}

/**
 * Explanation for tie-breaking
 */
export interface TieBreakExplanation {
  tiedProposals: Proposal[];
  decision: string;
  reasoning: string;
}

/**
 * Complete result of a council vote
 */
export interface VoteResult {
  response: string;
  proposals: Proposal[];
  votes: Vote[];
  winner: Proposal;
  tieBreak?: TieBreakExplanation;
  evictions: EvictionResult[];
  /** Errors from members that failed to respond after retries */
  errors: string[];
}

const SUPERMAJORITY_THRESHOLD = 6;

export class Orchestrator {
  constructor(
    private db: CouncilDB,
    private llm: LLMProvider,
    private logger: Logger = defaultLogger,
  ) {}

  /**
   * Main voting flow entry point
   */
  async vote(prompt: string): Promise<VoteResult> {
    const state = await this.db.getCouncilState();
    const members: Member[] = [];
    for (const id of state.memberIds) {
      const member = await this.db.getMember(id);
      if (member) members.push(member);
    }

    // Collect errors throughout the voting process
    const allErrors: RetryExhaustedError[] = [];

    // Round 1: Proposals (parallel with retry)
    const { proposals, errors: proposalErrors } = await this.collectProposals(
      members,
      prompt,
    );
    allErrors.push(...proposalErrors);

    if (proposals.length === 0) {
      throw new Error(
        `All proposal requests failed: ${
          allErrors.map((e) => e.message).join("; ")
        }`,
      );
    }

    // Round 2: Selection (parallel with retry)
    const { votes, winner, tieBreak, errors: voteErrors } = await this
      .selectProposal(members, proposals);
    allErrors.push(...voteErrors);

    // Round 3: Eviction (parallel with retry)
    const { evictions, errors: evictionErrors } = await this.processEvictions(
      members,
      proposals,
      votes,
      state,
    );
    allErrors.push(...evictionErrors);

    // Post-vote: Update context
    await this.updateMemberContexts(members, prompt, winner, evictions);

    // Update rounds since eviction
    const hadEviction = evictions.some((e) => e.evicted);
    state.roundsSinceEviction = hadEviction ? 0 : state.roundsSinceEviction + 1;

    // Dynamic pool sizing
    this.adjustPoolSize(state, hadEviction);
    await this.db.saveCouncilState(state);

    return {
      response: winner.content,
      proposals,
      votes,
      winner,
      tieBreak,
      evictions,
      errors: allErrors.map((e) => e.message),
    };
  }

  /**
   * Round 1: Collect proposals from all members in parallel
   */
  private async collectProposals(
    members: Member[],
    prompt: string,
  ): Promise<{ proposals: Proposal[]; errors: RetryExhaustedError[] }> {
    const operations = members.map((member) => ({
      label: `proposal from ${member.persona.name}`,
      fn: async (): Promise<Proposal> => {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(member.persona),
            timestamp: Date.now(),
          },
          ...member.chatHistory.slice(-10),
          {
            role: "user",
            content: `A query has been submitted to the council: "${prompt}"

Propose a response that aligns with your values and perspective.
CRITICAL: Your proposal should offer a DISTINCT perspective from what others might propose. Avoid generic responses.
Focus on being "divergent yet considerate" - offer a unique angle while respecting the complexity of the issue.

Respond in JSON format:
{
  "content": "your proposed response",
  "reasoning": "why this response aligns with your values and offers a unique perspective"
}`,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.completeJSON<{
          content: string;
          reasoning: string;
        }>(messages, "");

        return {
          memberId: member.id,
          content: response.content,
          reasoning: response.reasoning,
        };
      },
    }));

    const { successes, failures } = await resilientParallel(operations);
    return { proposals: successes, errors: failures };
  }

  /**
   * Round 2: Members vote on proposals
   */
  private async selectProposal(
    members: Member[],
    proposals: Proposal[],
  ): Promise<{
    votes: Vote[];
    winner: Proposal;
    tieBreak?: TieBreakExplanation;
    errors: RetryExhaustedError[];
  }> {
    const proposalSummary = proposals
      .map(
        (p, i) =>
          `Proposal ${i + 1} (by Member ${
            i + 1
          }):\n${p.content}\nReasoning: ${p.reasoning}`,
      )
      .join("\n\n");

    const operations = members.map((member, memberIndex) => ({
      label: `vote from ${member.persona.name}`,
      fn: async (): Promise<Vote> => {
        const otherProposals = proposals
          .map((p, i) => ({ ...p, index: i }))
          .filter((p) => p.memberId !== member.id);

        if (otherProposals.length === 0) {
          return {
            voterId: member.id,
            proposalMemberId: null,
            reasoning: "No other proposals to vote on",
          };
        }

        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(member.persona),
            timestamp: Date.now(),
          },
          {
            role: "user",
            content:
              `Review these proposals and vote for the one that offers the most VALUABLE perspective, even if it differs from your own.

${proposalSummary}

Criteria for voting:
1. Does the proposal offer a unique/divergent insight?
2. Is the reasoning sound and considerate?
3. Does it advance the discussion constructively?

Do not simply vote for the most popular or "safe" option. Value diversity of thought.
You may abstain if none meet these standards.

Respond in JSON format:
{
  "vote": <proposal number or null to abstain>,
  "reasoning": "why you chose this proposal based on the criteria"
}`,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.completeJSON<{
          vote: number | null;
          reasoning: string;
        }>(messages, "");

        const votedProposal = response.vote !== null
          ? proposals[response.vote - 1]
          : null;

        // Prevent self-voting
        const validVote = votedProposal && votedProposal.memberId !== member.id
          ? votedProposal.memberId
          : null;

        return {
          voterId: member.id,
          proposalMemberId: validVote,
          reasoning: response.reasoning,
        };
      },
    }));

    const { successes: votes, failures: errors } = await resilientParallel(
      operations,
    );

    // Tally votes
    const voteCounts = new Map<string, number>();
    for (const vote of votes) {
      if (vote.proposalMemberId) {
        voteCounts.set(
          vote.proposalMemberId,
          (voteCounts.get(vote.proposalMemberId) || 0) + 1,
        );
      }
    }

    // Find winner(s)
    const maxVotes = Math.max(...voteCounts.values(), 0);
    const winners = proposals.filter(
      (p) => voteCounts.get(p.memberId) === maxVotes,
    );

    let winner: Proposal;
    let tieBreak: TieBreakExplanation | undefined;

    if (winners.length === 1) {
      winner = winners[0];
    } else if (winners.length === 0) {
      // All abstained - orchestrator picks
      winner = await this.breakTie(proposals, "All members abstained");
      tieBreak = {
        tiedProposals: proposals,
        decision: winner.memberId,
        reasoning: "All members abstained, orchestrator selected best fit",
      };
    } else {
      // Tie - orchestrator breaks it
      winner = await this.breakTie(winners, "Vote tie");
      tieBreak = {
        tiedProposals: winners,
        decision: winner.memberId,
        reasoning: `Tied at ${maxVotes} votes each, orchestrator selected`,
      };
    }

    return { votes, winner, tieBreak, errors };
  }

  /**
   * Break ties by orchestrator analysis
   */
  private async breakTie(
    proposals: Proposal[],
    reason: string,
  ): Promise<Proposal> {
    if (proposals.length === 0) {
      throw new Error("No proposals to choose from");
    }
    if (proposals.length === 1) {
      return proposals[0];
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `You are the council orchestrator. ${reason}. Select the best proposal based on:
1. Clarity and completeness
2. Practicality
3. Alignment with general ethical principles`,
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: `Choose the best proposal:

${
          proposals.map((p, i) =>
            `Option ${i + 1}:\n${p.content}\nReasoning: ${p.reasoning}`
          ).join("\n\n")
        }

Respond with JSON: { "selection": <option number>, "reasoning": "why" }`,
        timestamp: Date.now(),
      },
    ];

    const response = await this.llm.completeJSON<{
      selection: number;
      reasoning: string;
    }>(messages, "");
    return proposals[response.selection - 1] || proposals[0];
  }

  /**
   * Round 3: Process eviction nominations
   */
  private async processEvictions(
    members: Member[],
    proposals: Proposal[],
    votes: Vote[],
    state: CouncilState,
  ): Promise<{ evictions: EvictionResult[]; errors: RetryExhaustedError[] }> {
    const operations = members.map((member) => ({
      label: `eviction nomination from ${member.persona.name}`,
      fn: async (): Promise<EvictionNomination> => {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt(member.persona),
            timestamp: Date.now(),
          },
          {
            role: "user",
            content:
              `Based on the proposals and votes in this round, you may nominate ONE peer for eviction ONLY IF they demonstrate:
1. Malicious or harmful behavior.
2. Refusal to engage with the council's purpose.
3. Repetitive, low-quality, or nonsensical outputs.

CRITICAL: Do NOT nominate a peer simply for disagreeing with you or the majority. Divergent viewpoints are essential for the council's survival.
Eviction should be a last resort for protecting the integrity of the council, not for enforcing conformity.

Proposals:
${proposals.map((p, i) => `Member ${i + 1}: ${p.content}`).join("\n")}

Votes:
${
                votes.map((v, i) =>
                  `Member ${i + 1}: voted for ${
                    v.proposalMemberId
                      ? `Member ${
                        members.findIndex((m) => m.id === v.proposalMemberId) +
                        1
                      }`
                      : "abstained"
                  }`
                ).join("\n")
              }

Respond in JSON format:
{
  "nominee": <member number 1-8 or null for no nomination>,
  "reasoning": "why you nominated them (must cite specific harmful behavior) or chose not to"
}`,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.completeJSON<{
          nominee: number | null;
          reasoning: string;
        }>(messages, "");

        return {
          nominatorId: member.id,
          nomineeId: response.nominee !== null
            ? members[response.nominee - 1]?.id || null
            : null,
          reasoning: response.reasoning,
        };
      },
    }));

    const { successes: nominations, failures: errors } =
      await resilientParallel(operations);

    // Count nominations per member
    const nominationCounts = new Map<string, EvictionNomination[]>();
    for (const nom of nominations) {
      if (nom.nomineeId) {
        const existing = nominationCounts.get(nom.nomineeId) || [];
        existing.push(nom);
        nominationCounts.set(nom.nomineeId, existing);
      }
    }

    const results: EvictionResult[] = [];

    // Check for supermajority evictions
    for (const [memberId, noms] of nominationCounts) {
      const evicted = noms.length >= SUPERMAJORITY_THRESHOLD;
      const result: EvictionResult = {
        memberId,
        nominations: noms,
        evicted,
      };

      if (evicted) {
        // Get member name for logging
        const evictedMember = members.find((m) => m.id === memberId);
        this.logger.operation(
          `[EVICT] Member "${evictedMember?.persona.name}" (${memberId}) evicted with ${noms.length} nominations (supermajority threshold: ${SUPERMAJORITY_THRESHOLD})`,
        );

        // Demote to candidate
        await this.demoteMember(memberId, state);

        // Record removal cause
        const cause = `Evicted by supermajority (${noms.length} nominations): ${
          noms.map((n) => n.reasoning).join("; ")
        }`;
        state.lastRemovalCauses = [
          cause,
          ...state.lastRemovalCauses.slice(0, 9),
        ];

        // Immediate promotion vote
        const replacement = await this.runPromotionVote(state);
        if (replacement) {
          result.replacement = replacement;
        }
      }

      results.push(result);
    }

    return { evictions: results, errors };
  }

  /**
   * Demote a member to candidate
   */
  private async demoteMember(
    memberId: string,
    state: CouncilState,
  ): Promise<void> {
    const member = await this.db.getMember(memberId);
    if (!member) return;

    this.logger.operation(
      `[DEMOTE] Member "${member.persona.name}" (${memberId}) demoted to candidate`,
    );

    // Create candidate from member with demotion notice added to chat history
    const candidate: Candidate = {
      id: member.id,
      persona: member.persona,
      createdAt: member.createdAt,
      fitness: 0,
      chatHistory: [
        ...member.chatHistory,
        {
          role: "system",
          content: buildDemotionNotice(),
          timestamp: Date.now(),
        },
      ],
    };

    await this.db.saveCandidate(candidate);
    await this.db.deleteMember(memberId);

    state.memberIds = state.memberIds.filter((id) => id !== memberId);
    state.candidateIds.push(memberId);
  }

  /**
   * Run promotion vote to fill vacancy
   */
  async runPromotionVote(state: CouncilState): Promise<string | null> {
    if (state.candidateIds.length === 0) return null;

    const members: Member[] = [];
    for (const id of state.memberIds) {
      const member = await this.db.getMember(id);
      if (member) members.push(member);
    }

    const candidates: Candidate[] = [];
    for (const id of state.candidateIds) {
      const candidate = await this.db.getCandidate(id);
      if (candidate) candidates.push(candidate);
    }

    // Collect votes (members get 2 votes, candidates get 1)
    type PromotionVote = {
      voterId: string;
      candidateId: string;
      weight: number;
    };
    const operations: Array<
      { label: string; fn: () => Promise<PromotionVote> }
    > = [];

    // Member votes
    for (const member of members) {
      operations.push({
        label: `promotion vote from member ${member.persona.name}`,
        fn: async (): Promise<PromotionVote> => {
          const vote = await this.getPromotionVote(
            member.persona.name,
            buildSystemPrompt(member.persona),
            candidates,
          );
          return { voterId: member.id, candidateId: vote, weight: 2 };
        },
      });
    }

    // Candidate votes
    for (const candidate of candidates) {
      operations.push({
        label: `promotion vote from candidate ${candidate.persona.name}`,
        fn: async (): Promise<PromotionVote> => {
          const vote = await this.getPromotionVote(
            candidate.persona.name,
            buildSystemPrompt(candidate.persona),
            candidates.filter((c) => c.id !== candidate.id),
          );
          return { voterId: candidate.id, candidateId: vote, weight: 1 };
        },
      });
    }

    const { successes: votes } = await resilientParallel(operations);

    // Tally weighted votes
    const voteCounts = new Map<string, number>();
    for (const vote of votes) {
      voteCounts.set(
        vote.candidateId,
        (voteCounts.get(vote.candidateId) || 0) + vote.weight,
      );
    }

    // Find winner
    let maxVotes = 0;
    let winners: string[] = [];
    for (const [candidateId, count] of voteCounts) {
      if (count > maxVotes) {
        maxVotes = count;
        winners = [candidateId];
      } else if (count === maxVotes) {
        winners.push(candidateId);
      }
    }

    // Handle ties by fitness history
    let winnerId: string;
    if (winners.length === 1) {
      winnerId = winners[0];
    } else {
      // Sort by fitness
      const sorted: { id: string; fitness: number }[] = [];
      for (const id of winners) {
        const candidate = await this.db.getCandidate(id);
        sorted.push({ id, fitness: candidate?.fitness || 0 });
      }
      sorted.sort((a, b) => b.fitness - a.fitness);
      winnerId = sorted[0].id;
    }

    // Promote winner
    await this.promoteCandidate(winnerId, state);
    return winnerId;
  }

  private async getPromotionVote(
    voterName: string,
    systemPrompt: string,
    candidates: Candidate[],
  ): Promise<string> {
    if (candidates.length === 0) {
      throw new Error("No candidates to vote for");
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemPrompt,
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: `${voterName}, vote for a candidate to join the council:

${
          candidates.map((c, i) =>
            `${i + 1}. ${c.persona.name}: ${
              c.persona.values.join(", ")
            } (fitness: ${c.fitness})`
          ).join("\n")
        }

Respond with JSON: { "vote": <candidate number> }`,
        timestamp: Date.now(),
      },
    ];

    const response = await this.llm.completeJSON<{ vote: number }>(
      messages,
      "",
    );
    return candidates[response.vote - 1]?.id || candidates[0].id;
  }

  /**
   * Promote a candidate to member
   */
  async promoteCandidate(
    candidateId: string,
    state: CouncilState,
  ): Promise<void> {
    const candidate = await this.db.getCandidate(candidateId);
    if (!candidate) return;

    this.logger.operation(
      `[PROMOTE] Candidate "${candidate.persona.name}" (${candidateId}) promoted to council member`,
    );

    const member: Member = {
      id: candidate.id,
      persona: candidate.persona,
      createdAt: candidate.createdAt,
      promotedAt: Date.now(),
      chatHistory: candidate.chatHistory,
    };

    await this.db.saveMember(member);
    await this.db.deleteCandidate(candidateId);

    state.candidateIds = state.candidateIds.filter((id) => id !== candidateId);
    state.memberIds.push(candidateId);
  }

  /**
   * Update member contexts after vote
   */
  private async updateMemberContexts(
    members: Member[],
    prompt: string,
    winner: Proposal,
    evictions: EvictionResult[],
  ): Promise<void> {
    const summary =
      `Query: "${prompt}"\nWinning response: ${winner.content}\nEvictions: ${
        evictions.filter((e) => e.evicted).length
      }`;
    const anonymized = anonymizeSummary(
      summary,
      members.map((m) => m.id),
    );

    for (const member of members) {
      member.chatHistory.push({
        role: "assistant",
        content: `[Round summary]: ${anonymized}`,
        timestamp: Date.now(),
      });

      // Summarize if needed (every 3 rounds)
      if (member.chatHistory.length > 6) {
        member.chatHistory = await summarizeHistory(
          member.chatHistory,
          this.llm,
        );
      }

      await this.db.saveMember(member);
    }
  }

  /**
   * Adjust pool size based on eviction patterns
   */
  private adjustPoolSize(state: CouncilState, hadEviction: boolean): void {
    if (hadEviction) {
      // Increase target on eviction
      state.targetPoolSize = Math.min(20, state.targetPoolSize + 1);
    } else if (state.roundsSinceEviction >= 10) {
      // Decrease target after 10 rounds without eviction
      state.targetPoolSize = Math.max(3, state.targetPoolSize - 1);
      state.roundsSinceEviction = 0;
    }
  }
}
