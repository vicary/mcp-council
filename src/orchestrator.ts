/**
 * Council orchestrator - manages voting flow and rounds
 */

import type { Candidate, CouncilDB, CouncilState, Member } from "./db.ts";
import type { ChatMessage, LLMProvider } from "./llm.ts";
import {
  buildDemotionNotice,
  buildEvictionPrompt,
  buildProposalPrompt,
  buildSystemPrompt,
  buildVotePrompt,
} from "./persona.ts";
import { defaultLogger, type Logger } from "./utils/logger.ts";
import {
  resilientParallel,
  type RetryExhaustedError,
} from "./utils/resilient.ts";
import {
  anonymizeSummary,
  MEMBER_SUMMARIZE_THRESHOLD,
  summarizeHistory,
  summarizeRemovalCauses,
} from "./utils/summarize.ts";

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
  reason?: string;
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

/**
 * Progress callbacks for vote operation
 */
export interface VoteProgressCallbacks {
  onProposalsCollected?: () => Promise<void>;
  onVotingComplete?: () => Promise<void>;
}

export class Orchestrator {
  constructor(
    private db: CouncilDB,
    private llm: LLMProvider,
    private logger: Logger = defaultLogger,
  ) {}

  /**
   * Main voting flow entry point
   */
  async vote(
    prompt: string,
    callbacks?: VoteProgressCallbacks,
  ): Promise<VoteResult> {
    const state = await this.db.getCouncilState();
    const members = await this.db.getMembersByIds(state.memberIds);

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

    // Notify: Proposals collected
    await callbacks?.onProposalsCollected?.();

    // Round 2: Selection (parallel with retry)
    const { votes, winner, tieBreak, errors: voteErrors } = await this
      .selectProposal(members, proposals);
    allErrors.push(...voteErrors);

    // Notify: Voting complete
    await callbacks?.onVotingComplete?.();

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
    const userContent = buildProposalPrompt(prompt);

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
            content: userContent,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          content: string;
          reasoning: string;
        }>(messages, "", member.persona.model);

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
        member.chatHistory.push(userMsg, assistantMsg);

        // Also save to separate history storage for TUI review
        await this.db.appendManyToHistory("member", member.id, [
          userMsg,
          assistantMsg,
        ]);

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

    const votePrompt = buildVotePrompt(proposalSummary);

    const operations = members.map((member) => ({
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
            content: votePrompt,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          vote: number | null;
          reasoning: string;
        }>(messages, "", member.persona.model);

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

    // Tally votes and find winner(s) in single pass
    const { winner, tieBreak } = await this.tallyVotesAndFindWinner(
      votes,
      proposals,
    );

    return { votes, winner, tieBreak, errors };
  }

  /**
   * Tally votes and determine the winner, handling ties if necessary
   */
  private async tallyVotesAndFindWinner(
    votes: Vote[],
    proposals: Proposal[],
  ): Promise<{ winner: Proposal; tieBreak?: TieBreakExplanation }> {
    // Count votes in single iteration
    const voteCounts = new Map<string, number>();
    let maxVotes = 0;

    for (const vote of votes) {
      if (vote.proposalMemberId) {
        const count = (voteCounts.get(vote.proposalMemberId) || 0) + 1;
        voteCounts.set(vote.proposalMemberId, count);
        if (count > maxVotes) maxVotes = count;
      }
    }

    // Find winners (proposals with max votes)
    const winners = maxVotes > 0
      ? proposals.filter((p) => voteCounts.get(p.memberId) === maxVotes)
      : [];

    if (winners.length === 1) {
      return { winner: winners[0] };
    }

    if (winners.length === 0) {
      // All abstained - orchestrator picks
      const winner = await this.breakTie(proposals, "All members abstained");
      return {
        winner,
        tieBreak: {
          tiedProposals: proposals,
          decision: winner.memberId,
          reasoning: "All members abstained, orchestrator selected best fit",
        },
      };
    }

    // Tie - orchestrator breaks it
    const winner = await this.breakTie(winners, "Vote tie");
    return {
      winner,
      tieBreak: {
        tiedProposals: winners,
        decision: winner.memberId,
        reasoning: `Tied at ${maxVotes} votes each, orchestrator selected`,
      },
    };
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

    const response = await this.llm.json<{
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
    // Pre-build member index lookup for efficient lookups
    const memberIndexMap = new Map(members.map((m, i) => [m.id, i + 1]));
    const evictionPrompt = buildEvictionPrompt(
      proposals,
      votes,
      members.length,
      (id) => memberIndexMap.get(id) ?? 0,
    );

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
            content: evictionPrompt,
            timestamp: Date.now(),
          },
        ];

        const response = await this.llm.json<{
          nominee: number | null;
          reasoning: string;
        }>(messages, "", member.persona.model);

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

        // Aggregate eviction reasons into one-liner
        const evictionReason = noms.map((n) => n.reasoning).join("; ");
        result.reason = evictionReason;

        // Demote to candidate with reason
        await this.demoteMember(memberId, state, evictionReason);

        // Record removal cause
        const cause = `Evicted by supermajority (${noms.length} nominations): ${
          noms.map((n) => n.reasoning).join("; ")
        }`;
        state.lastRemovalCauses = [
          cause,
          ...state.lastRemovalCauses.slice(0, 9),
        ];

        // Update summary
        state.removalHistorySummary = await summarizeRemovalCauses(
          state.lastRemovalCauses,
          this.llm,
        );

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
    evictionReason?: string,
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
          content: buildDemotionNotice(evictionReason),
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

    const [members, candidates] = await Promise.all([
      this.db.getMembersByIds(state.memberIds),
      this.db.getCandidatesByIds(state.candidateIds),
    ]);

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
            member.persona.model,
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
            candidate.persona.model,
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
    model: string,
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

    const response = await this.llm.json<{ vote: number }>(
      messages,
      "",
      model,
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
    const memberIds = members.map((m) => m.id);
    const anonymized = anonymizeSummary(summary, memberIds);

    // Process all member updates in parallel
    const updatedMembers = await Promise.all(
      members.map(async (member) => {
        const summaryMsg: ChatMessage = {
          role: "assistant",
          content: `[Round summary]: ${anonymized}`,
          timestamp: Date.now(),
        };
        member.chatHistory.push(summaryMsg);

        // Save to separate history storage for TUI review
        await this.db.appendToHistory("member", member.id, summaryMsg);

        // Summarize active context if needed
        if (member.chatHistory.length > MEMBER_SUMMARIZE_THRESHOLD) {
          member.chatHistory = await summarizeHistory(
            member.chatHistory,
            this.llm,
            member.persona.model,
            MEMBER_SUMMARIZE_THRESHOLD,
          );
        }

        return member;
      }),
    );

    // Batch save all members
    await this.db.saveMembers(updatedMembers);
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
