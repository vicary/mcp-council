/**
 * Tests for database layer
 */

import { assertEquals, assertExists } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Candidate, CouncilDB, type Member, type Persona } from "./db.ts";

describe("CouncilDB", () => {
  let db: CouncilDB;

  const mockPersona: Persona = {
    name: "Test Persona",
    values: ["integrity", "innovation"],
    traits: ["analytical", "creative"],
    background: "A test persona for unit testing",
    decisionStyle: "data-driven",
  };

  beforeEach(async () => {
    db = await CouncilDB.open(":memory:");
    await db.clear();
  });

  afterEach(() => {
    db.close();
  });

  describe("Member operations", () => {
    it("should save and retrieve a member", async () => {
      const member: Member = {
        id: "mem_test_123",
        persona: mockPersona,
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      };

      await db.saveMember(member);
      const retrieved = await db.getMember(member.id);

      assertExists(retrieved);
      assertEquals(retrieved.id, member.id);
      assertEquals(retrieved.persona.name, mockPersona.name);
    });

    it("should return null for non-existent member", async () => {
      const result = await db.getMember("non_existent_id");
      assertEquals(result, null);
    });

    it("should retrieve all members", async () => {
      const member1: Member = {
        id: "mem_1",
        persona: mockPersona,
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      };
      const member2: Member = {
        id: "mem_2",
        persona: { ...mockPersona, name: "Second Persona" },
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      };

      await db.saveMember(member1);
      await db.saveMember(member2);

      const { items: allMembers } = await db.getAllMembers();
      assertEquals(allMembers.length, 2);
    });

    it("should delete a member", async () => {
      const member: Member = {
        id: "mem_to_delete",
        persona: mockPersona,
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      };

      await db.saveMember(member);
      assertExists(await db.getMember(member.id));

      await db.deleteMember(member.id);
      assertEquals(await db.getMember(member.id), null);
    });

    it("should update existing member on save", async () => {
      const member: Member = {
        id: "mem_update",
        persona: mockPersona,
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      };

      await db.saveMember(member);

      member.chatHistory.push({
        role: "user",
        content: "test message",
        timestamp: Date.now(),
      });
      await db.saveMember(member);

      const retrieved = await db.getMember(member.id);
      assertEquals(retrieved?.chatHistory.length, 1);
    });
  });

  describe("Candidate operations", () => {
    it("should save and retrieve a candidate", async () => {
      const candidate: Candidate = {
        id: "cand_test_123",
        persona: mockPersona,
        createdAt: Date.now(),
        fitness: 5,
        chatHistory: [],
      };

      await db.saveCandidate(candidate);
      const retrieved = await db.getCandidate(candidate.id);

      assertExists(retrieved);
      assertEquals(retrieved.id, candidate.id);
      assertEquals(retrieved.fitness, 5);
    });

    it("should track candidate fitness", async () => {
      const candidate: Candidate = {
        id: "cand_fitness",
        persona: mockPersona,
        createdAt: Date.now(),
        fitness: 0,
        chatHistory: [],
      };

      await db.saveCandidate(candidate);

      candidate.fitness = 10;
      await db.saveCandidate(candidate);

      const retrieved = await db.getCandidate(candidate.id);
      assertEquals(retrieved?.fitness, 10);
    });

    it("should retrieve all candidates", async () => {
      const candidates = [
        { id: "cand_1", fitness: 1 },
        { id: "cand_2", fitness: 2 },
        { id: "cand_3", fitness: 3 },
      ];

      for (const c of candidates) {
        await db.saveCandidate({
          id: c.id,
          persona: mockPersona,
          createdAt: Date.now(),
          fitness: c.fitness,
          chatHistory: [],
        });
      }

      const { items: allCandidates } = await db.getAllCandidates();
      assertEquals(allCandidates.length, 3);
    });

    it("should delete a candidate", async () => {
      const candidate: Candidate = {
        id: "cand_to_delete",
        persona: mockPersona,
        createdAt: Date.now(),
        fitness: 0,
        chatHistory: [],
      };

      await db.saveCandidate(candidate);
      await db.deleteCandidate(candidate.id);

      assertEquals(await db.getCandidate(candidate.id), null);
    });
  });

  describe("Council state operations", () => {
    it("should initialize default council state", async () => {
      const state = await db.getCouncilState();

      assertExists(state);
      assertEquals(state.memberIds, []);
      assertEquals(state.candidateIds, []);
      assertEquals(state.targetPoolSize, 20);
      assertEquals(state.roundsSinceEviction, 0);
    });

    it("should save and retrieve council state", async () => {
      const state = await db.getCouncilState();

      state.memberIds = ["mem_1", "mem_2"];
      state.candidateIds = ["cand_1", "cand_2", "cand_3"];
      state.targetPoolSize = 15;
      state.roundsSinceEviction = 5;
      state.lastRemovalCauses = ["test cause 1", "test cause 2"];

      await db.saveCouncilState(state);

      const retrieved = await db.getCouncilState();
      assertEquals(retrieved.memberIds, ["mem_1", "mem_2"]);
      assertEquals(retrieved.candidateIds.length, 3);
      assertEquals(retrieved.targetPoolSize, 15);
      assertEquals(retrieved.roundsSinceEviction, 5);
      assertEquals(retrieved.lastRemovalCauses.length, 2);
    });
  });

  describe("Clear operation", () => {
    it("should clear all data", async () => {
      // Add some data
      await db.saveMember({
        id: "mem_1",
        persona: mockPersona,
        createdAt: Date.now(),
        promotedAt: Date.now(),
        chatHistory: [],
      });
      await db.saveCandidate({
        id: "cand_1",
        persona: mockPersona,
        createdAt: Date.now(),
        fitness: 0,
        chatHistory: [],
      });

      const state = await db.getCouncilState();
      state.memberIds = ["mem_1"];
      state.candidateIds = ["cand_1"];
      await db.saveCouncilState(state);

      // Clear
      await db.clear();

      // Verify
      assertEquals((await db.getAllMembers()).items.length, 0);
      assertEquals((await db.getAllCandidates()).items.length, 0);

      const clearedState = await db.getCouncilState();
      assertEquals(clearedState.memberIds, []);
      assertEquals(clearedState.candidateIds, []);
    });
  });

  describe("Concurrent access", () => {
    it("should handle concurrent member saves without data loss", async () => {
      // Create 10 members concurrently - all should succeed due to retry logic
      const members: Member[] = [];
      for (let i = 0; i < 10; i++) {
        members.push({
          id: `mem_concurrent_${i}`,
          persona: { ...mockPersona, name: `Concurrent Member ${i}` },
          createdAt: Date.now(),
          promotedAt: Date.now(),
          chatHistory: [],
        });
      }

      // Save all concurrently
      await Promise.all(members.map((m) => db.saveMember(m)));

      // Verify all members were saved
      const { items: allMembers } = await db.getAllMembers();
      assertEquals(allMembers.length, 10);

      // Verify state is consistent
      const state = await db.getCouncilState();
      assertEquals(state.memberIds.length, 10);
      for (const member of members) {
        assertEquals(
          state.memberIds.includes(member.id),
          true,
          `Member ${member.id} should be in state`,
        );
      }
    });

    it("should handle concurrent candidate saves without data loss", async () => {
      // Create 10 candidates concurrently
      const candidates: Candidate[] = [];
      for (let i = 0; i < 10; i++) {
        candidates.push({
          id: `cand_concurrent_${i}`,
          persona: { ...mockPersona, name: `Concurrent Candidate ${i}` },
          createdAt: Date.now(),
          fitness: i * 10,
          chatHistory: [],
        });
      }

      // Save all concurrently
      await Promise.all(candidates.map((c) => db.saveCandidate(c)));

      // Verify all candidates were saved
      const { items: allCandidates } = await db.getAllCandidates();
      assertEquals(allCandidates.length, 10);

      // Verify state is consistent
      const state = await db.getCouncilState();
      assertEquals(state.candidateIds.length, 10);
      for (const candidate of candidates) {
        assertEquals(
          state.candidateIds.includes(candidate.id),
          true,
          `Candidate ${candidate.id} should be in state`,
        );
      }
    });

    it("should handle concurrent member deletes without errors", async () => {
      // First, create members sequentially
      for (let i = 0; i < 5; i++) {
        await db.saveMember({
          id: `mem_del_${i}`,
          persona: { ...mockPersona, name: `Delete Member ${i}` },
          createdAt: Date.now(),
          promotedAt: Date.now(),
          chatHistory: [],
        });
      }

      // Verify they exist
      assertEquals((await db.getAllMembers()).items.length, 5);

      // Delete all concurrently
      await Promise.all(
        [0, 1, 2, 3, 4].map((i) => db.deleteMember(`mem_del_${i}`)),
      );

      // Verify all were deleted
      const { items: allMembers } = await db.getAllMembers();
      assertEquals(allMembers.length, 0);

      const state = await db.getCouncilState();
      assertEquals(state.memberIds.length, 0);
    });

    it("should handle mixed concurrent operations", async () => {
      // Pre-create some members to delete
      for (let i = 0; i < 3; i++) {
        await db.saveMember({
          id: `mem_existing_${i}`,
          persona: { ...mockPersona, name: `Existing Member ${i}` },
          createdAt: Date.now(),
          promotedAt: Date.now(),
          chatHistory: [],
        });
      }

      // Concurrent: save new members, delete existing, save candidates
      const operations: Promise<void>[] = [];

      // Save 3 new members
      for (let i = 0; i < 3; i++) {
        operations.push(
          db.saveMember({
            id: `mem_new_${i}`,
            persona: { ...mockPersona, name: `New Member ${i}` },
            createdAt: Date.now(),
            promotedAt: Date.now(),
            chatHistory: [],
          }),
        );
      }

      // Delete existing members
      for (let i = 0; i < 3; i++) {
        operations.push(db.deleteMember(`mem_existing_${i}`));
      }

      // Save 3 candidates
      for (let i = 0; i < 3; i++) {
        operations.push(
          db.saveCandidate({
            id: `cand_new_${i}`,
            persona: { ...mockPersona, name: `New Candidate ${i}` },
            createdAt: Date.now(),
            fitness: i * 10,
            chatHistory: [],
          }),
        );
      }

      // Execute all concurrently
      await Promise.all(operations);

      // Verify final state
      const { items: members } = await db.getAllMembers();
      const { items: candidates } = await db.getAllCandidates();
      const state = await db.getCouncilState();

      assertEquals(members.length, 3, "Should have 3 new members");
      assertEquals(candidates.length, 3, "Should have 3 candidates");
      assertEquals(state.memberIds.length, 3);
      assertEquals(state.candidateIds.length, 3);

      // Verify correct members exist
      for (let i = 0; i < 3; i++) {
        assertEquals(
          state.memberIds.includes(`mem_new_${i}`),
          true,
          `New member ${i} should exist`,
        );
        assertEquals(
          state.memberIds.includes(`mem_existing_${i}`),
          false,
          `Existing member ${i} should be deleted`,
        );
        assertEquals(
          state.candidateIds.includes(`cand_new_${i}`),
          true,
          `Candidate ${i} should exist`,
        );
      }
    });

    it("should handle rapid sequential saves of same member", async () => {
      // Save the same member multiple times with different chat history
      const memberId = "mem_rapid_update";

      const saves: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        saves.push(
          db.saveMember({
            id: memberId,
            persona: { ...mockPersona, name: `Rapid Update Member` },
            createdAt: Date.now(),
            promotedAt: Date.now(),
            chatHistory: [
              { role: "user", content: `Message ${i}`, timestamp: Date.now() },
            ],
          }),
        );
      }

      await Promise.all(saves);

      // Member should exist exactly once in state
      const state = await db.getCouncilState();
      const memberIdCount =
        state.memberIds.filter((id) => id === memberId).length;
      assertEquals(memberIdCount, 1, "Member ID should appear exactly once");

      // Member should be retrievable
      const member = await db.getMember(memberId);
      assertExists(member);
    });
  });
});
