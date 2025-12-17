/**
 * Tests for summarization utilities
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { type ChatMessage, MockLLMProvider } from "../llm.ts";
import { anonymizeSummary, summarizeHistory } from "./summarize.ts";

describe("Summarization Utilities", () => {
  describe("anonymizeSummary", () => {
    it("should replace member IDs with anonymous labels", () => {
      const content = "mem_123 voted for mem_456's proposal";
      const memberIds = ["mem_123", "mem_456"];

      const result = anonymizeSummary(content, memberIds);

      assertEquals(result, "Member_1 voted for Member_2's proposal");
    });

    it("should handle multiple occurrences of same ID", () => {
      const content = "mem_abc proposed, then mem_abc voted";
      const memberIds = ["mem_abc"];

      const result = anonymizeSummary(content, memberIds);

      assertEquals(result, "Member_1 proposed, then Member_1 voted");
    });

    it("should preserve content without member IDs", () => {
      const content = "The council reached consensus";
      const memberIds = ["mem_123"];

      const result = anonymizeSummary(content, memberIds);

      assertEquals(result, "The council reached consensus");
    });

    it("should handle empty member ID list", () => {
      const content = "Some content";
      const memberIds: string[] = [];

      const result = anonymizeSummary(content, memberIds);

      assertEquals(result, "Some content");
    });
  });

  describe("summarizeHistory", () => {
    const mockLLM = new MockLLMProvider();

    it("should return history unchanged if below threshold", async () => {
      const history: ChatMessage[] = [
        { role: "user", content: "test 1", timestamp: Date.now() },
        { role: "assistant", content: "response 1", timestamp: Date.now() },
      ];

      const result = await summarizeHistory(history, mockLLM);

      assertEquals(result.length, 2);
      assertEquals(result[0].content, "test 1");
    });

    it("should summarize long history", async () => {
      mockLLM.setResponses(["This is a summary of the conversation."]);

      const history: ChatMessage[] = [];
      for (let i = 0; i < 10; i++) {
        history.push({
          role: "user",
          content: `message ${i}`,
          timestamp: Date.now(),
        });
      }

      const result = await summarizeHistory(history, mockLLM);

      // Should have summary + recent messages
      assertStringIncludes(result[0].content, "[Previous history summary]");
      assertEquals(result.length, 4); // 1 summary + 3 recent
    });

    it("should preserve recent messages", async () => {
      mockLLM.setResponses(["Summary"]);

      const history: ChatMessage[] = [];
      for (let i = 0; i < 8; i++) {
        history.push({
          role: "user",
          content: `message ${i}`,
          timestamp: Date.now(),
        });
      }

      const result = await summarizeHistory(history, mockLLM);

      // Last 3 messages should be preserved
      assertEquals(result[result.length - 1].content, "message 7");
      assertEquals(result[result.length - 2].content, "message 6");
      assertEquals(result[result.length - 3].content, "message 5");
    });
  });
});
