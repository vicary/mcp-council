/**
 * Integration tests for the full council voting flow
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Council } from "./council.ts";
import { CouncilDB, type Persona } from "./db.ts";
import { MockLLMProvider } from "./llm.ts";
import { Orchestrator } from "./orchestrator.ts";
import { silentLogger } from "./utils/logger.ts";

describe("Integration: Full Voting Flow", () => {
  let db: CouncilDB;
  let llm: MockLLMProvider;
  let _council: Council;
  let orchestrator: Orchestrator;

  const createMockPersona = (name: string): Persona => ({
    name,
    values: ["integrity", "innovation"],
    traits: ["analytical", "creative"],
    background: `${name} is an AI council member.`,
    decisionStyle: "balanced approach",
  });

  beforeEach(async () => {
    db = await CouncilDB.open(":memory:");
    await db.clear();
    llm = new MockLLMProvider();
    _council = new Council(db, llm, silentLogger);
    orchestrator = new Orchestrator(db, llm, silentLogger);

    // Pre-populate council with 8 members
    const state = await db.getCouncilState();
    for (let i = 1; i <= 8; i++) {
      await db.saveMember({
        id: `mem_${i}`,
        persona: createMockPersona(`Council Member ${i}`),
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      });
      state.memberIds.push(`mem_${i}`);
    }

    // Add some candidates
    for (let i = 1; i <= 5; i++) {
      await db.saveCandidate({
        id: `cand_${i}`,
        persona: createMockPersona(`Candidate ${i}`),
        createdAt: Date.now(),
        fitness: i * 2,
        chatHistory: [],
      });
      state.candidateIds.push(`cand_${i}`);
    }

    state.targetPoolSize = 5;
    await db.saveCouncilState(state);
  });

  afterEach(() => {
    db.close();
  });

  it("should complete a full voting round", async () => {
    const responses: string[] = [];

    // 8 proposals
    for (let i = 1; i <= 8; i++) {
      responses.push(
        JSON.stringify({
          content: `Member ${i} proposes: Consider all angles carefully.`,
          reasoning: `Based on my values of integrity and innovation.`,
        }),
      );
    }

    // 8 votes (create a clear winner)
    for (let i = 1; i <= 8; i++) {
      responses.push(
        JSON.stringify({
          vote: i === 1 ? 2 : 1, // Most vote for proposal 1
          reasoning: `This proposal aligns with council values.`,
        }),
      );
    }

    // 8 eviction nominations (none)
    for (let i = 1; i <= 8; i++) {
      responses.push(
        JSON.stringify({
          nominee: null,
          reasoning: "All members performed well this round.",
        }),
      );
    }

    // Context summary
    responses.push("Round completed successfully with consensus.");

    llm.setResponses(responses);

    const result = await orchestrator.vote("Should we invest in AI research?");

    // Verify complete result
    assertExists(result.response);
    assertEquals(result.proposals.length, 8);
    assertEquals(result.votes.length, 8);
    assertExists(result.winner);
    assertEquals(result.evictions.length, 0);
  });

  it("should handle member eviction and replacement", async () => {
    const responses: string[] = [];

    // 8 proposals
    for (let i = 1; i <= 8; i++) {
      responses.push(
        JSON.stringify({
          content: `Proposal ${i}`,
          reasoning: `Reasoning ${i}`,
        }),
      );
    }

    // 8 votes
    for (let i = 1; i <= 8; i++) {
      responses.push(
        JSON.stringify({
          vote: i === 1 ? 2 : 1,
          reasoning: "Vote reasoning",
        }),
      );
    }

    // 6+ eviction nominations for member 8 (supermajority)
    for (let i = 1; i <= 6; i++) {
      responses.push(
        JSON.stringify({
          nominee: 8,
          reasoning: "Member 8 has been disruptive.",
        }),
      );
    }
    for (let i = 7; i <= 8; i++) {
      responses.push(
        JSON.stringify({
          nominee: null,
          reasoning: "No issues observed.",
        }),
      );
    }

    // Promotion votes: 7 remaining members + 6 candidates (5 original + demoted mem_8) = 13 votes
    for (let i = 0; i < 13; i++) {
      responses.push(JSON.stringify({ vote: 1 })); // All vote for candidate 1
    }

    llm.setResponses(responses);

    const result = await orchestrator.vote("Test with eviction");

    // Verify eviction occurred
    const eviction = result.evictions.find((e) => e.evicted);
    assertExists(eviction);
    assertEquals(eviction.memberId, "mem_8");
    assertExists(eviction.replacement);
  });

  it("should run multiple voting rounds", async () => {
    const runRound = async (roundNum: number) => {
      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            content: `Round ${roundNum} Proposal ${i}`,
            reasoning: "Reasoning",
          }),
        );
      }

      // Votes
      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({
            vote: i === 1 ? 2 : 1,
            reasoning: "Vote",
          }),
        );
      }

      // No evictions
      for (let i = 1; i <= 8; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "none" }));
      }

      // Summary
      responses.push(`Round ${roundNum} summary`);

      llm.setResponses(responses);

      return await orchestrator.vote(`Query for round ${roundNum}`);
    };

    // Run 3 rounds
    const results = [];
    for (let i = 1; i <= 3; i++) {
      results.push(await runRound(i));
    }

    assertEquals(results.length, 3);

    // Verify rounds since eviction counter
    const state = await db.getCouncilState();
    assertEquals(state.roundsSinceEviction, 3);
  });

  it("should track member chat history across rounds", async () => {
    const runRound = async () => {
      const responses: string[] = [];

      for (let i = 1; i <= 8; i++) {
        responses.push(
          JSON.stringify({ content: `Proposal`, reasoning: "Reason" }),
        );
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
      return await orchestrator.vote("Test query");
    };

    // Run a couple rounds
    await runRound();
    await runRound();

    // Check that members have chat history
    const member = await db.getMember("mem_1");
    assertExists(member);
    assertGreater(member.chatHistory.length, 0);
  });
});

describe("Integration: Candidate Pool", () => {
  let db: CouncilDB;
  let llm: MockLLMProvider;
  let _council: Council;

  beforeEach(async () => {
    db = await CouncilDB.open(":memory:");
    await db.clear();
    llm = new MockLLMProvider();
    _council = new Council(db, llm, silentLogger);
  });

  afterEach(() => {
    db.close();
  });

  it("should run practice rounds for candidates", async () => {
    const state = await db.getCouncilState();
    state.targetPoolSize = 4; // Match the number of candidates we'll add

    // Add candidates
    for (let i = 1; i <= 4; i++) {
      await db.saveCandidate({
        id: `cand_${i}`,
        persona: {
          name: `Candidate ${i}`,
          values: ["value"],
          traits: ["trait"],
          background: "Background",
          decisionStyle: "style",
        },
        createdAt: Date.now(),
        fitness: 0,
        chatHistory: [],
      });
      state.candidateIds.push(`cand_${i}`);
    }
    await db.saveCouncilState(state);

    const pool = _council.getCandidatePool();

    const responses: string[] = [];

    // 4 proposals
    for (let i = 1; i <= 4; i++) {
      responses.push(
        JSON.stringify({
          content: `Practice proposal ${i}`,
          reasoning: `Practice reasoning ${i}`,
        }),
      );
    }

    // 4 votes
    for (let i = 1; i <= 4; i++) {
      responses.push(
        JSON.stringify({
          vote: i === 1 ? 2 : 1,
          reasoning: "Vote reasoning",
        }),
      );
    }

    // 4 eviction nominations (none)
    for (let i = 1; i <= 4; i++) {
      responses.push(
        JSON.stringify({
          nominee: null,
          reasoning: "No issues",
        }),
      );
    }

    llm.setResponses(responses);

    const result = await pool.runPracticeRound("Practice query");

    assertEquals(result.proposals.length, 4);
    assertEquals(result.votes.length, 4);
    assertEquals(result.evictions.length, 0);

    // Verify fitness was updated
    const candidate1 = await db.getCandidate("cand_1");
    assertExists(candidate1);
    assertGreater(candidate1.fitness, 0); // Should have received votes
  });
});
