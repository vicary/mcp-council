/**
 * Tests for Council bootstrap and lifecycle
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Council } from "./council.ts";
import { CouncilDB, type Persona } from "./db.ts";
import { MockLLMProvider } from "./llm.ts";
import { silentLogger } from "./utils/logger.ts";

describe("Council", () => {
  let db: CouncilDB;
  let llm: MockLLMProvider;
  let council: Council;

  const createMockPersona = (name: string): Persona => ({
    name,
    values: ["value1", "value2"],
    traits: ["trait1", "trait2"],
    background: `Background for ${name}`,
    decisionStyle: "analytical",
  });

  beforeEach(async () => {
    db = await CouncilDB.open(":memory:");
    await db.clear();
    llm = new MockLLMProvider();
    council = new Council(db, llm, silentLogger);
  });

  afterEach(() => {
    db.close();
  });

  describe("bootstrap", () => {
    it("should create initial council of 8 members", async () => {
      // Set a smaller pool size for testing
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;
      await db.saveCouncilState(state);

      // Need to mock persona generation:
      // - 8 candidates to promote to members
      // - 5 candidates to fill the pool after promotion
      for (let i = 0; i < 13; i++) {
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

      await council.bootstrap();

      const status = await council.getStatus();
      assertEquals(status.members.length, 8);
    });

    it("should restore existing members on bootstrap", async () => {
      // Pre-populate with members
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;
      for (let i = 1; i <= 8; i++) {
        await db.saveMember({
          id: `mem_${i}`,
          persona: createMockPersona(`Existing ${i}`),
          createdAt: Date.now(),
          promotedAt: Date.now(),
          chatHistory: [],
        });
        state.memberIds.push(`mem_${i}`);
      }
      await db.saveCouncilState(state);

      // Mock for candidate pool replenishment (5 candidates)
      for (let i = 0; i < 5; i++) {
        llm.pushResponse(
          JSON.stringify({
            name: `Candidate ${i}`,
            values: ["value"],
            traits: ["trait"],
            background: "Background",
            decisionStyle: "style",
          }),
        );
      }

      await council.bootstrap();

      const status = await council.getStatus();
      assertEquals(status.members.length, 8);
      assertEquals(status.members[0].persona.name, "Existing 1");
    });

    it("should restore existing candidates on bootstrap", async () => {
      // Pre-populate with candidates
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;

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
      await db.saveCouncilState(state);

      // Mock for member creation (need 8 - 5 = 3 more candidates, then replenish 5)
      for (let i = 0; i < 8; i++) {
        llm.pushResponse(
          JSON.stringify({
            name: `Generated ${i}`,
            values: ["value"],
            traits: ["trait"],
            background: "Background",
            decisionStyle: "style",
          }),
        );
      }

      await council.bootstrap();

      const status = await council.getStatus();
      assertEquals(status.members.length, 8);
      // Some candidates should have been promoted
    });

    it("should create candidates to reach target pool size", async () => {
      // Set a smaller pool size for testing
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;
      await db.saveCouncilState(state);

      // Mock for all persona generations (8 members + 5 candidates)
      for (let i = 0; i < 13; i++) {
        llm.pushResponse(
          JSON.stringify({
            name: `Entity ${i}`,
            values: ["value"],
            traits: ["trait"],
            background: "Background",
            decisionStyle: "style",
          }),
        );
      }

      await council.bootstrap();

      const status = await council.getStatus();
      assertGreater(status.candidates.length, 0);
    });

    it("should preserve existing members and candidates on restart", async () => {
      // Simulate a fully initialized council
      const state = await db.getCouncilState();
      state.targetPoolSize = 3;

      // Add 8 existing members
      for (let i = 1; i <= 8; i++) {
        await db.saveMember({
          id: `mem_${i}`,
          persona: createMockPersona(`Member ${i}`),
          createdAt: Date.now() - 10000,
          promotedAt: Date.now() - 5000,
          chatHistory: [{
            role: "system",
            content: "test",
            timestamp: Date.now(),
          }],
        });
        state.memberIds.push(`mem_${i}`);
      }

      // Add 3 existing candidates
      for (let i = 1; i <= 3; i++) {
        await db.saveCandidate({
          id: `cand_${i}`,
          persona: createMockPersona(`Candidate ${i}`),
          createdAt: Date.now() - 10000,
          fitness: i * 10,
          chatHistory: [{
            role: "system",
            content: "test",
            timestamp: Date.now(),
          }],
        });
        state.candidateIds.push(`cand_${i}`);
      }

      await db.saveCouncilState(state);

      // No mock responses needed - should NOT create anything new
      await council.bootstrap();

      const status = await council.getStatus();

      // All 8 members should be preserved
      assertEquals(status.members.length, 8);
      for (let i = 1; i <= 8; i++) {
        const member = status.members.find((m) => m.id === `mem_${i}`);
        assertExists(member, `Member mem_${i} should exist`);
        assertEquals(member.persona.name, `Member ${i}`);
      }

      // All 3 candidates should be preserved
      assertEquals(status.candidates.length, 3);
      for (let i = 1; i <= 3; i++) {
        const candidate = status.candidates.find((c) => c.id === `cand_${i}`);
        assertExists(candidate, `Candidate cand_${i} should exist`);
        assertEquals(candidate.persona.name, `Candidate ${i}`);
        assertEquals(candidate.fitness, i * 10);
      }
    });

    it("should preserve data across DB close and reopen (simulating restart)", async () => {
      // Close the in-memory DB and use a temp file for this test
      db.close();

      const tempPath = await Deno.makeTempFile({ suffix: ".sqlite" });
      try {
        // Open with temp file path
        db = await CouncilDB.open(tempPath);

        // Set up initial state
        const state = await db.getCouncilState();
        state.targetPoolSize = 3;

        // Add 8 existing members
        for (let i = 1; i <= 8; i++) {
          await db.saveMember({
            id: `mem_${i}`,
            persona: createMockPersona(`Member ${i}`),
            createdAt: Date.now() - 10000,
            promotedAt: Date.now() - 5000,
            chatHistory: [{
              role: "system",
              content: "test",
              timestamp: Date.now(),
            }],
          });
          state.memberIds.push(`mem_${i}`);
        }

        // Add 3 existing candidates
        for (let i = 1; i <= 3; i++) {
          await db.saveCandidate({
            id: `cand_${i}`,
            persona: createMockPersona(`Candidate ${i}`),
            createdAt: Date.now() - 10000,
            fitness: i * 10,
            chatHistory: [{
              role: "system",
              content: "test",
              timestamp: Date.now(),
            }],
          });
          state.candidateIds.push(`cand_${i}`);
        }

        await db.saveCouncilState(state);

        // Close the database (simulating server shutdown)
        db.close();

        // Reopen the database (simulating server restart) - same temp path
        db = await CouncilDB.open(tempPath);
        council = new Council(db, llm, silentLogger);

        // Bootstrap should NOT create new members/candidates
        await council.bootstrap();

        const status = await council.getStatus();

        // All 8 members should be preserved
        assertEquals(
          status.members.length,
          8,
          "Should have 8 members after restart",
        );
        for (let i = 1; i <= 8; i++) {
          const member = status.members.find((m) => m.id === `mem_${i}`);
          assertExists(member, `Member mem_${i} should exist after restart`);
          assertEquals(member.persona.name, `Member ${i}`);
        }

        // All 3 candidates should be preserved
        assertEquals(
          status.candidates.length,
          3,
          "Should have 3 candidates after restart",
        );
        for (let i = 1; i <= 3; i++) {
          const candidate = status.candidates.find((c) => c.id === `cand_${i}`);
          assertExists(
            candidate,
            `Candidate cand_${i} should exist after restart`,
          );
          assertEquals(candidate.persona.name, `Candidate ${i}`);
          assertEquals(candidate.fitness, i * 10);
        }

        // Close the temp DB before cleanup
        db.close();
      } finally {
        // Reopen in-memory for afterEach cleanup
        db = await CouncilDB.open(":memory:");
        // Clean up temp file
        try {
          await Deno.remove(tempPath);
        } catch {
          // Ignore if already removed
        }
      }
    });
  });

  describe("getStatus", () => {
    it("should return current council status", async () => {
      // Set up some state
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;
      state.roundsSinceEviction = 3;

      for (let i = 1; i <= 8; i++) {
        await db.saveMember({
          id: `mem_${i}`,
          persona: createMockPersona(`Member ${i}`),
          createdAt: Date.now(),
          promotedAt: Date.now(),
          chatHistory: [],
        });
        state.memberIds.push(`mem_${i}`);
      }

      for (let i = 1; i <= 3; i++) {
        await db.saveCandidate({
          id: `cand_${i}`,
          persona: createMockPersona(`Candidate ${i}`),
          createdAt: Date.now(),
          fitness: i,
          chatHistory: [],
        });
        state.candidateIds.push(`cand_${i}`);
      }

      await db.saveCouncilState(state);

      const status = await council.getStatus();

      assertEquals(status.members.length, 8);
      assertEquals(status.candidates.length, 3);
      assertEquals(status.state.targetPoolSize, 5);
      assertEquals(status.state.roundsSinceEviction, 3);
    });

    it("should handle empty council", async () => {
      const status = await council.getStatus();

      assertEquals(status.members.length, 0);
      assertEquals(status.candidates.length, 0);
    });
  });

  describe("getCandidatePool", () => {
    it("should return candidate pool manager", () => {
      const pool = council.getCandidatePool();
      assertExists(pool);
    });
  });
});
