/**
 * Tests for Council bootstrap and lifecycle
 */

import {
  assertEquals,
  assertExists,
  assertFalse,
  assertGreater,
} from "@std/assert";
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
    council.stopPeriodicRecovery();
    db.close();
  });

  describe("periodic recovery", () => {
    it("should create candidates incrementally through recovery cycles", async () => {
      // Set a smaller pool size for testing
      const state = await db.getCouncilState();
      state.targetPoolSize = 2;
      await db.saveCouncilState(state);

      // Mock persona generation for first recovery cycle (creates 1 candidate)
      llm.pushResponse(
        JSON.stringify({
          name: `Generated 0`,
          values: ["value"],
          traits: ["trait"],
          background: "Generated",
          decisionStyle: "style",
        }),
      );

      // Call the recovery cycle through startPeriodicRecovery + wait
      // Since we don't have direct access, we test through getStatus after manual trigger
      // We need to expose recovery for testing, so let's test through behavior

      // Initial state should have no candidates
      let status = await council.getStatus();
      assertEquals(status.candidates.length, 0);

      // After recovery runs, we should have started creating candidates
      // Since startPeriodicRecovery runs immediately, we can test the first cycle
      council.startPeriodicRecovery();

      // Wait a bit for the first cycle to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      status = await council.getStatus();
      // Should have created at least 1 candidate in first cycle
      assertGreater(
        status.candidates.length,
        0,
        "Should have created candidates",
      );
    });

    it("should restore existing members on recovery", async () => {
      // Pre-populate with members
      const state = await db.getCouncilState();
      state.targetPoolSize = 0; // No candidates needed
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

      // No mock responses needed - existing members should be found
      council.startPeriodicRecovery();

      // Wait for first cycle
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = await council.getStatus();
      assertEquals(status.members.length, 8);
      assertEquals(status.members[0].persona.name, "Existing 1");
    });

    it("should skip recovery when operation is in progress", async () => {
      // Set up state where recovery would create candidates
      const state = await db.getCouncilState();
      state.targetPoolSize = 5;
      await db.saveCouncilState(state);

      // Mock persona generation
      llm.pushResponse(
        JSON.stringify({
          name: `Generated`,
          values: ["value"],
          traits: ["trait"],
          background: "Generated",
          decisionStyle: "style",
        }),
      );

      // Mark operation in progress
      council.setOperationInProgress(true);

      // Start recovery - it should skip because operation is in progress
      council.startPeriodicRecovery();

      // Wait for cycle
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = await council.getStatus();
      // Should NOT have created any candidates because operation was in progress
      assertEquals(
        status.candidates.length,
        0,
        "Should not create candidates when operation in progress",
      );
    });

    it("should preserve existing members and candidates on recovery", async () => {
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

      // Start recovery - should NOT create anything new
      council.startPeriodicRecovery();

      // Wait for cycle
      await new Promise((resolve) => setTimeout(resolve, 100));

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

        // Recovery should NOT create new members/candidates
        council.startPeriodicRecovery();
        await new Promise((resolve) => setTimeout(resolve, 100));

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

  describe("hasMinimumMembers", () => {
    it("should return false when council has fewer than 3 members", async () => {
      const state = await db.getCouncilState();
      state.memberIds = ["mem_1", "mem_2"];
      await db.saveCouncilState(state);

      assertFalse(await council.hasMinimumMembers());
    });

    it("should return true when council has 3 or more members", async () => {
      const state = await db.getCouncilState();
      for (let i = 1; i <= 3; i++) {
        await db.saveMember({
          id: `mem_${i}`,
          persona: createMockPersona(`Member ${i}`),
          createdAt: Date.now(),
          promotedAt: Date.now(),
          chatHistory: [],
        });
        state.memberIds.push(`mem_${i}`);
      }
      await db.saveCouncilState(state);

      assertEquals(await council.hasMinimumMembers(), true);
    });
  });

  describe("operation tracking", () => {
    it("should track operation in progress state", () => {
      assertFalse(council.isOperationInProgress());

      council.setOperationInProgress(true);
      assertEquals(council.isOperationInProgress(), true);

      council.setOperationInProgress(false);
      assertFalse(council.isOperationInProgress());
    });
  });
});
