/**
 * Tests for the Orchestrator - voting flow
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { CouncilDB, type Member, type Persona } from "./db.ts";
import { MockLLMProvider } from "./llm.ts";
import { Orchestrator } from "./orchestrator.ts";
import { silentLogger } from "./utils/logger.ts";

describe("Orchestrator", () => {
  let db: CouncilDB;
  let llm: MockLLMProvider;
  let orchestrator: Orchestrator;

  const createMockPersona = (name: string): Persona => ({
    name,
    values: ["value1", "value2"],
    traits: ["trait1", "trait2"],
    background: `Background for ${name}`,
    decisionStyle: "analytical",
  });

  const createMember = (id: string, name: string): Member => ({
    id,
    persona: createMockPersona(name),
    createdAt: Date.now(),
    promotedAt: Date.now(),
    chatHistory: [],
  });

  beforeEach(async () => {
    db = await CouncilDB.open(":memory:");
    await db.clear();
    llm = new MockLLMProvider();
    orchestrator = new Orchestrator(db, llm, silentLogger);

    // Set up 8 council members
    const state = await db.getCouncilState();
    for (let i = 1; i <= 8; i++) {
      const member = createMember(`mem_${i}`, `Member ${i}`);
      await db.saveMember(member);
      state.memberIds.push(member.id);
    }
    await db.saveCouncilState(state);
  });

  afterEach(() => {
    db.close();
  });

  describe("vote", () => {
    it("should collect proposals from all members", async () => {
      // Mock responses for 8 proposals + 8 votes + 8 eviction nominations
      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            content: `Proposal ${i} content`,
            reasoning: `Reasoning ${i}`,
          }),
        );
      }

      // Votes (everyone votes for proposal 1, except member 1 who votes for 2)
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            vote: i === 1 ? 2 : 1,
            reasoning: `Vote reasoning ${i}`,
          }),
        );
      }

      // Eviction nominations (no one nominates)
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            nominee: null,
            reasoning: "No issues observed",
          }),
        );
      }

      // Summary (for context update)
      responses.push("Session summary");

      llm.setResponses(responses);

      const result = await orchestrator.vote("Test query");

      assertEquals(result.proposals.length, 8);
      assertEquals(result.votes.length, 8);
      assertExists(result.winner);
    });

    it("should handle tie-break", async () => {
      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            content: `Proposal ${i}`,
            reasoning: `Reasoning ${i}`,
          }),
        );
      }

      // Votes creating a tie (4 for proposal 1, 4 for proposal 2)
      for (let i = 1; i <= 8; i++) {
        const vote = i <= 4 ? (i === 1 ? 2 : 1) : i === 5 ? 1 : 2;
        responses.push(
          JSON.stringify({
            vote,
            reasoning: `Vote ${i}`,
          }),
        );
      }

      // Tie-break decision
      responses.push(
        JSON.stringify({
          selection: 1,
          reasoning: "More comprehensive",
        }),
      );

      // Eviction nominations
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "none" }));
      }

      // Summary
      responses.push("Summary");

      llm.setResponses(responses);

      const result = await orchestrator.vote("Test query");

      assertExists(result.tieBreak);
      assertStringIncludes(result.tieBreak.reasoning, "orchestrator");
    });

    it("should prevent self-voting", async () => {
      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            content: `Proposal ${i}`,
            reasoning: `Reasoning ${i}`,
          }),
        );
      }

      // All members try to vote for themselves (should become null)
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            vote: i, // Voting for self
            reasoning: "My proposal is best",
          }),
        );
      }

      // Tie-break (all votes invalid = orchestrator picks)
      responses.push(
        JSON.stringify({
          selection: 1,
          reasoning: "Selected first proposal",
        }),
      );

      // Eviction nominations
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "none" }));
      }

      // Summary
      responses.push("Summary");

      llm.setResponses(responses);

      const result = await orchestrator.vote("Test query");

      // All votes should be null (abstained due to self-vote prevention)
      const validVotes = result.votes.filter((v) =>
        v.proposalMemberId !== null
      );
      assertEquals(validVotes.length, 0);
      assertExists(result.tieBreak);
    });

    it("should handle eviction with supermajority", async () => {
      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            content: `Proposal ${i}`,
            reasoning: `Reasoning ${i}`,
          }),
        );
      }

      // Votes
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            vote: i === 1 ? 2 : 1,
            reasoning: "Good proposal",
          }),
        );
      }

      // Eviction nominations - 6 people nominate member 8
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            nominee: i <= 6 ? 8 : null,
            reasoning: i <= 6 ? "Problematic behavior" : "No issues",
          }),
        );
      }

      // Add a candidate for promotion
      const state = await db.getCouncilState();
      await db.saveCandidate({
        id: "cand_1",
        persona: createMockPersona("Candidate 1"),
        createdAt: Date.now(),
        fitness: 5,
        chatHistory: [],
      });
      state.candidateIds.push("cand_1");
      state.targetPoolSize = 2; // Set to 2 (cand_1 + demoted mem_8)
      await db.saveCouncilState(state);

      // Promotion votes: 7 remaining members + 2 candidates (cand_1 + demoted mem_8) = 9 voters
      for (let i = 1; i <= 9; i++) {
        responses.push(JSON.stringify({ vote: 1 }));
      }

      llm.setResponses(responses);

      const result = await orchestrator.vote("Test query");

      // Should have eviction result
      const eviction = result.evictions.find((e) => e.evicted);
      assertExists(eviction);
      assertEquals(eviction.nominations.length, 6);
    });

    it("should update rounds since eviction counter", async () => {
      const responses: string[] = [];

      // Standard round with no evictions
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ content: `P${i}`, reasoning: "r" }));
      }
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({ vote: i === 1 ? 2 : 1, reasoning: "v" }),
        );
      }
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "n" }));
      }
      responses.push("Summary");

      llm.setResponses(responses);

      const stateBefore = await db.getCouncilState();
      const roundsBefore = stateBefore.roundsSinceEviction;

      await orchestrator.vote("Test");

      const stateAfter = await db.getCouncilState();
      assertEquals(stateAfter.roundsSinceEviction, roundsBefore + 1);
    });
  });

  describe("runPromotionVote", () => {
    it("should promote candidate with most votes", async () => {
      // Set up candidates (we already have 8 members in the council)
      const state = await db.getCouncilState();

      for (let i = 1; i <= 3; i++) {
        await db.saveCandidate({
          id: `cand_${i}`,
          persona: createMockPersona(`Candidate ${i}`),
          createdAt: Date.now(),
          fitness: i * 2, // Different fitness levels
          chatHistory: [],
        });
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      // Promotion votes: 8 members + 3 candidates = 11 voters total
      // Members vote for candidate index, candidates vote for their filtered list
      // All vote for index 2:
      // - Members see [cand_1, cand_2, cand_3], vote=2 picks cand_2
      // - cand_1 sees [cand_2, cand_3], vote=2 picks cand_3
      // - cand_2 sees [cand_1, cand_3], vote=2 picks cand_3
      // - cand_3 sees [cand_1, cand_2], vote=2 picks cand_2
      // Result: cand_2 gets 16 (8×2) + 1 = 17 points, cand_3 gets 2 points
      const responses: string[] = [];
      for (let i = 0; i < 11; i++) {
        responses.push(JSON.stringify({ vote: 2 }));
      }
      llm.setResponses(responses);

      const winnerId = await orchestrator.runPromotionVote(state);

      assertEquals(winnerId, "cand_2");

      // Verify candidate was promoted in the passed state object
      // (runPromotionVote modifies state but doesn't save to DB)
      assertEquals(state.memberIds.includes("cand_2"), true);
      assertEquals(state.candidateIds.includes("cand_2"), false);
    });

    it("should use fitness to break ties", async () => {
      const state = await db.getCouncilState();

      // Two candidates with different fitness
      await db.saveCandidate({
        id: "cand_low",
        persona: createMockPersona("Low Fitness"),
        createdAt: Date.now(),
        fitness: 5,
        chatHistory: [],
      });
      await db.saveCandidate({
        id: "cand_high",
        persona: createMockPersona("High Fitness"),
        createdAt: Date.now(),
        fitness: 15,
        chatHistory: [],
      });
      state.candidateIds = ["cand_low", "cand_high"];
      await db.saveCouncilState(state);

      // Create tie: half vote for each
      const responses: string[] = [];
      for (let i = 0; i < 10; i++) {
        responses.push(JSON.stringify({ vote: i % 2 === 0 ? 1 : 2 }));
      }
      llm.setResponses(responses);

      const winnerId = await orchestrator.runPromotionVote(state);

      // Higher fitness should win
      assertEquals(winnerId, "cand_high");
    });
  });

  describe("pool size adjustment", () => {
    it("should decrease target after 10 rounds without eviction", async () => {
      const state = await db.getCouncilState();
      state.roundsSinceEviction = 9;
      state.targetPoolSize = 15;
      await db.saveCouncilState(state);

      const responses: string[] = [];
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ content: `P${i}`, reasoning: "r" }));
      }
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({ vote: i === 1 ? 2 : 1, reasoning: "v" }),
        );
      }
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "n" }));
      }
      responses.push("Summary");
      llm.setResponses(responses);

      await orchestrator.vote("Test");

      const newState = await db.getCouncilState();
      assertEquals(newState.targetPoolSize, 14);
      assertEquals(newState.roundsSinceEviction, 0); // Reset
    });

    it("should not decrease below minimum of 3", async () => {
      const state = await db.getCouncilState();
      state.roundsSinceEviction = 9;
      state.targetPoolSize = 3;
      await db.saveCouncilState(state);

      const responses: string[] = [];
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ content: `P${i}`, reasoning: "r" }));
      }
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({ vote: i === 1 ? 2 : 1, reasoning: "v" }),
        );
      }
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "n" }));
      }
      responses.push("Summary");
      llm.setResponses(responses);

      await orchestrator.vote("Test");

      const newState = await db.getCouncilState();
      assertEquals(newState.targetPoolSize, 3);
    });
  });
});
