/**
 * Tests for resilient execution utilities
 */

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  resilientParallel,
  RetryExhaustedError,
  withRetry,
} from "./resilient.ts";

describe("Resilient Utilities", () => {
  describe("withRetry", () => {
    it("should return result on first successful attempt", async () => {
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        return "success";
      }, "test operation");

      assertEquals(result, "success");
      assertEquals(attempts, 1);
    });

    it("should retry on failure and succeed", async () => {
      let attempts = 0;
      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("temporary failure");
          }
          return "success after retries";
        },
        "test operation",
        3,
        10, // Use 10ms delay for fast tests
      );

      assertEquals(result, "success after retries");
      assertEquals(attempts, 3);
    });

    it("should throw RetryExhaustedError after max retries", async () => {
      let attempts = 0;
      await assertRejects(
        async () => {
          await withRetry(
            async () => {
              attempts++;
              throw new Error("persistent failure");
            },
            "test operation",
            3,
            10, // Use 10ms delay for fast tests
          );
        },
        RetryExhaustedError,
        "test operation failed after 3 attempts",
      );

      assertEquals(attempts, 3);
    });

    it("should preserve original error message", async () => {
      try {
        await withRetry(
          async () => {
            throw new Error("specific error message");
          },
          "my operation",
          1,
        );
      } catch (e) {
        if (e instanceof RetryExhaustedError) {
          assertEquals(e.operation, "my operation");
          assertEquals(e.lastError.message, "specific error message");
          assertEquals(e.attempts, 1);
        }
      }
    });
  });

  describe("resilientParallel", () => {
    it("should return all successes when no failures", async () => {
      const operations = [
        { label: "op1", fn: async () => 1 },
        { label: "op2", fn: async () => 2 },
        { label: "op3", fn: async () => 3 },
      ];

      const result = await resilientParallel(operations);

      assertEquals(result.successes.length, 3);
      assertEquals(result.failures.length, 0);
      assertEquals(result.successes.sort(), [1, 2, 3]);
    });

    it("should collect both successes and failures", async () => {
      const operations = [
        { label: "success1", fn: async () => "ok1" },
        {
          label: "failure1",
          fn: async () => {
            throw new Error("fail");
          },
        },
        { label: "success2", fn: async () => "ok2" },
      ];

      const result = await resilientParallel(operations, 10); // Use 10ms delay for fast tests

      assertEquals(result.successes.length, 2);
      assertEquals(result.failures.length, 1);
      assertEquals(result.failures[0].operation, "failure1");
    });

    it("should handle all failures", async () => {
      const operations = [
        {
          label: "fail1",
          fn: async () => {
            throw new Error("error1");
          },
        },
        {
          label: "fail2",
          fn: async () => {
            throw new Error("error2");
          },
        },
      ];

      const result = await resilientParallel(operations, 10); // Use 10ms delay for fast tests

      assertEquals(result.successes.length, 0);
      assertEquals(result.failures.length, 2);
    });

    it("should retry failed operations before marking as failure", async () => {
      const attemptCounts = { op1: 0, op2: 0 };

      const operations = [
        {
          label: "op1",
          fn: async () => {
            attemptCounts.op1++;
            if (attemptCounts.op1 < 2) {
              throw new Error("temporary");
            }
            return "recovered";
          },
        },
        {
          label: "op2",
          fn: async () => {
            attemptCounts.op2++;
            throw new Error("permanent");
          },
        },
      ];

      const result = await resilientParallel(operations, 10); // Use 10ms delay for fast tests

      assertEquals(result.successes, ["recovered"]);
      assertEquals(result.failures.length, 1);
      assertEquals(attemptCounts.op1, 2); // Succeeded on 2nd try
      assertEquals(attemptCounts.op2, 3); // Failed all 3 attempts
    });
  });
});
