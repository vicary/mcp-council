/**
 * Tests for ID generation utilities
 */

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { generateCandidateId, generateId, generateMemberId } from "./id.ts";

describe("ID Generation", () => {
  describe("generateId", () => {
    it("should generate ID with correct prefix", () => {
      const id = generateId("test");
      assertMatch(id, /^test_/);
    });

    it("should generate unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId("test"));
      }
      assertEquals(ids.size, 100);
    });

    it("should contain timestamp component", () => {
      const id = generateId("pre");
      const parts = id.split("_");
      assertEquals(parts.length, 3);
      // Timestamp should be alphanumeric (base36)
      assertMatch(parts[1], /^[a-z0-9]+$/);
    });
  });

  describe("generateMemberId", () => {
    it("should generate member ID with 'mem' prefix", () => {
      const id = generateMemberId();
      assertMatch(id, /^mem_/);
    });

    it("should generate unique member IDs", () => {
      const id1 = generateMemberId();
      const id2 = generateMemberId();
      assertNotEquals(id1, id2);
    });
  });

  describe("generateCandidateId", () => {
    it("should generate candidate ID with 'cand' prefix", () => {
      const id = generateCandidateId();
      assertMatch(id, /^cand_/);
    });

    it("should generate unique candidate IDs", () => {
      const id1 = generateCandidateId();
      const id2 = generateCandidateId();
      assertNotEquals(id1, id2);
    });
  });
});
