/**
 * Tests for ID generation utilities
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { generateId } from "./id.ts";

describe("ID Generation", () => {
  describe("generateId", () => {
    it("should generate unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      assertEquals(ids.size, 100);
    });

    it("should be a valid ULID", () => {
      const id = generateId();
      // ULID should be 26 chars
      assertEquals(id.length, 26);
    });
  });
});
