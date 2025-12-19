/**
 * Tests for candidate pool management
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { CandidatePool } from "./candidate-pool.ts";
import { type Candidate, CouncilDB, type Persona } from "./db.ts";
import { MockLLMProvider } from "./llm.ts";
import { silentLogger } from "./utils/logger.ts";

describe("CandidatePool", () => {
  let db: CouncilDB;
  let llm: MockLLMProvider;
  let pool: CandidatePool;

  const createMockPersona = (name: string): Persona => ({
    name,
    values: ["value1", "value2"],
    traits: ["trait1", "trait2"],
    background: `Background for ${name}`,
    decisionStyle: "analytical",
  });

  const createCandidate = (
    id: string,
    name: string,
    fitness = 0,
  ): Candidate => ({
    id,
    persona: createMockPersona(name),
    createdAt: Date.now(),
    fitness,
    chatHistory: [],
  });

  beforeEach(async () => {
    db = await CouncilDB.open(":memory:");
    await db.clear();
    llm = new MockLLMProvider();
    pool = new CandidatePool(db, llm, silentLogger);
  });

  afterEach(() => {
    db.close();
  });

  describe("runPracticeRound", () => {
    it("should skip practice round with less than 2 candidates", async () => {
      const state = await db.getCouncilState();
      await db.saveCandidate(createCandidate("cand_1", "Solo"));
      state.candidateIds = ["cand_1"];
      await db.saveCouncilState(state);

      const result = await pool.runPracticeRound("Test query");

      assertEquals(result.proposals.length, 0);
      assertEquals(result.votes.length, 0);
      assertEquals(result.survivors.length, 1);
    });

    it("should collect proposals from all candidates", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 4; // Set target to match candidates to avoid replenishment
      for (let i = 1; i <= 4; i++) {
        await db.saveCandidate(createCandidate(`cand_${i}`, `Candidate ${i}`));
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 4; i++) {
        responses.push(
          JSON.stringify({
            content: `Proposal ${i}`,
            reasoning: `Reasoning ${i}`,
          }),
        );
      }

      // Votes
      for (let i = 1; i <= 4; i++) {
        responses.push(
          JSON.stringify({
            vote: i === 1 ? 2 : 1,
            reasoning: `Vote ${i}`,
          }),
        );
      }

      // Eviction nominations (no one)
      for (let i = 1; i <= 4; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "none" }));
      }

      llm.setResponses(responses);

      const result = await pool.runPracticeRound("Test query");

      assertEquals(result.proposals.length, 4);
      assertEquals(result.votes.length, 4);
    });

    it("should update fitness based on votes received", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 3; // Set target to match candidates
      for (let i = 1; i <= 3; i++) {
        await db.saveCandidate(
          createCandidate(`cand_${i}`, `Candidate ${i}`, 0),
        );
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 3; i++) {
        responses.push(JSON.stringify({ content: `P${i}`, reasoning: "r" }));
      }

      // Votes - candidates vote on "other proposals" which exclude their own
      // cand_1 sees: [P2, P3], vote=1 picks P2 (cand_2)
      // cand_2 sees: [P1, P3], vote=1 picks P1 (cand_1)
      // cand_3 sees: [P1, P2], vote=1 picks P1 (cand_1)
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" })); // cand_1 votes for cand_2
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" })); // cand_2 votes for cand_1
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" })); // cand_3 votes for cand_1

      // No evictions
      for (let i = 1; i <= 3; i++) {
        responses.push(JSON.stringify({ nominee: null, reasoning: "none" }));
      }

      llm.setResponses(responses);

      await pool.runPracticeRound("Test");

      const cand1 = await db.getCandidate("cand_1");
      const cand2 = await db.getCandidate("cand_2");
      const cand3 = await db.getCandidate("cand_3");

      assertEquals(cand1?.fitness, 2); // Got 2 votes
      assertEquals(cand2?.fitness, 1); // Got 1 vote
      assertEquals(cand3?.fitness, 0); // Got 0 votes
    });

    it("should evict candidate with simple majority", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 3;
      for (let i = 1; i <= 4; i++) {
        await db.saveCandidate(createCandidate(`cand_${i}`, `Candidate ${i}`));
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 4; i++) {
        responses.push(JSON.stringify({ content: `P${i}`, reasoning: "r" }));
      }

      // Votes
      for (let i = 1; i <= 4; i++) {
        responses.push(
          JSON.stringify({ vote: i === 1 ? 2 : 1, reasoning: "v" }),
        );
      }

      // Eviction: 3 out of 4 nominate candidate 4 (majority)
      responses.push(JSON.stringify({ nominee: 4, reasoning: "evict" }));
      responses.push(JSON.stringify({ nominee: 4, reasoning: "evict" }));
      responses.push(JSON.stringify({ nominee: 4, reasoning: "evict" }));
      responses.push(JSON.stringify({ nominee: null, reasoning: "none" }));

      // New candidate creation (to replenish pool)
      responses.push(
        JSON.stringify({
          name: "New Candidate",
          values: ["fresh"],
          traits: ["new"],
          background: "Newly created",
          decisionStyle: "fresh perspective",
        }),
      );

      llm.setResponses(responses);

      const result = await pool.runPracticeRound("Test");

      assertEquals(result.evictions.includes("cand_4"), true);
      assertEquals(result.survivors.includes("cand_4"), false);
    });

    it("should protect candidate with 75% vote nullification", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 4; // Set target to match candidates
      for (let i = 1; i <= 4; i++) {
        await db.saveCandidate(createCandidate(`cand_${i}`, `Candidate ${i}`));
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      const responses: string[] = [];

      // Proposals
      for (let i = 1; i <= 4; i++) {
        responses.push(JSON.stringify({ content: `P${i}`, reasoning: "r" }));
      }

      // All 4 candidates vote, 3 vote for candidate 1 = 75% (protected)
      responses.push(JSON.stringify({ vote: 2, reasoning: "v" })); // cand_1 -> cand_2
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" })); // cand_2 -> cand_1
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" })); // cand_3 -> cand_1
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" })); // cand_4 -> cand_1

      // All try to evict candidate 1, but they're protected
      for (let i = 1; i <= 4; i++) {
        responses.push(JSON.stringify({ nominee: 1, reasoning: "evict" }));
      }

      llm.setResponses(responses);

      const result = await pool.runPracticeRound("Test");

      // Candidate 1 should survive due to nullification
      assertEquals(result.evictions.includes("cand_1"), false);
      assertEquals(result.survivors.includes("cand_1"), true);
    });

    it("should queue concurrent practice rounds", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 2;
      for (let i = 1; i <= 2; i++) {
        await db.saveCandidate(createCandidate(`cand_${i}`, `Candidate ${i}`));
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      // Set up responses for multiple rounds (2 candidates = 2 proposals + 2 votes per round)
      const responses: string[] = [];
      // First round
      responses.push(JSON.stringify({ content: "P1", reasoning: "r" }));
      responses.push(JSON.stringify({ content: "P2", reasoning: "r" }));
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" }));
      responses.push(JSON.stringify({ vote: 2, reasoning: "v" }));
      // Second round (queued)
      responses.push(JSON.stringify({ content: "P1-2", reasoning: "r" }));
      responses.push(JSON.stringify({ content: "P2-2", reasoning: "r" }));
      responses.push(JSON.stringify({ vote: 1, reasoning: "v" }));
      responses.push(JSON.stringify({ vote: 2, reasoning: "v" }));
      llm.setResponses(responses);

      // Start first round (will complete)
      const promise1 = pool.runPracticeRound("First query");
      // Queue second round (while first is in progress)
      const promise2 = pool.runPracticeRound("Second query");

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // First round should complete normally
      assertEquals(result1.proposals.length, 2);
      // Second round should be queued (returns early with queue message)
      assertEquals(result2.proposals.length, 0);
      assertEquals(result2.errors.length, 1);
      assertEquals(
        result2.errors[0].includes("queued"),
        true,
      );
    });
  });

  describe("replenishPool", () => {
    it("should create candidates until target is reached", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;
      state.candidateIds = [];
      await db.saveCouncilState(state);

      // Mock persona generation for 5 candidates
      for (let i = 0; i < 5; i++) {
        llm.pushResponse(
          JSON.stringify({
            name: `Generated ${i}`,
            values: ["value"],
            traits: ["trait"],
            background: "Generated",
            decisionStyle: "style",
          }),
        );
      }

      await pool.replenishPool(state);

      assertEquals(state.candidateIds.length, 5);
    });

    it("should not create candidates if already at target", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 3;

      for (let i = 1; i <= 3; i++) {
        await db.saveCandidate(createCandidate(`cand_${i}`, `Candidate ${i}`));
        state.candidateIds.push(`cand_${i}`);
      }
      await db.saveCouncilState(state);

      await pool.replenishPool(state);

      // No new candidates should be created
      assertEquals(state.candidateIds.length, 3);
    });
  });

  describe("createCandidate", () => {
    it("should create candidate with generated persona", async () => {
      const state = await db.getCouncilState();
      state.targetPoolSize = 10;
      await db.saveCouncilState(state);

      llm.pushResponse(
        JSON.stringify({
          name: "Test Candidate",
          values: ["integrity", "innovation"],
          traits: ["analytical", "creative"],
          background: "Test background",
          decisionStyle: "balanced",
        }),
      );

      const candidate = await pool.createCandidate(state);

      assertExists(candidate);
      assertEquals(candidate.persona.name, "Test Candidate");
      assertEquals(candidate.fitness, 0);
      assertGreater(candidate.chatHistory.length, 0);
    });

    it("should include last removal causes in candidate context", async () => {
      const state = await db.getCouncilState();
      state.lastRemovalCauses = ["Was too aggressive", "Lacked collaboration"];
      await db.saveCouncilState(state);

      llm.pushResponse(
        JSON.stringify({
          name: "Informed Candidate",
          values: ["collaboration"],
          traits: ["peaceful"],
          background: "Learned from others",
          decisionStyle: "cooperative",
        }),
      );

      const candidate = await pool.createCandidate(state);

      // Chat history should include removal causes
      const historyText = candidate.chatHistory
        .map((m) => m.content)
        .join(" ");
      assertEquals(
        historyText.includes("removal") || historyText.includes("Recent"),
        true,
      );
    });
  });
});
