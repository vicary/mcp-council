/**
 * Tests for LLM provider
 */

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { type ChatMessage, MockLLMProvider } from "./llm.ts";

describe("MockLLMProvider", () => {
  describe("complete", () => {
    it("should return mock response", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses(["Hello, world!"]);

      const messages: ChatMessage[] = [
        { role: "user", content: "Hi", timestamp: Date.now() },
      ];

      const result = await llm.text(messages);
      assertEquals(result, "Hello, world!");
    });

    it("should return responses in order", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses(["First", "Second", "Third"]);

      const messages: ChatMessage[] = [
        { role: "user", content: "test", timestamp: Date.now() },
      ];

      assertEquals(await llm.text(messages), "First");
      assertEquals(await llm.text(messages), "Second");
      assertEquals(await llm.text(messages), "Third");
    });

    it("should return default response when exhausted", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses(["Only one"]);

      const messages: ChatMessage[] = [
        { role: "user", content: "test", timestamp: Date.now() },
      ];

      await llm.text(messages); // Use up the response
      const result = await llm.text(messages);
      assertEquals(result, "Mock response");
    });

    it("should support pushResponse", async () => {
      const llm = new MockLLMProvider();
      llm.pushResponse("Pushed response");

      const messages: ChatMessage[] = [
        { role: "user", content: "test", timestamp: Date.now() },
      ];

      const result = await llm.text(messages);
      assertEquals(result, "Pushed response");
    });
  });

  describe("completeJSON", () => {
    it("should parse JSON response", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses(['{"name": "Test", "value": 42}']);

      const messages: ChatMessage[] = [
        { role: "user", content: "test", timestamp: Date.now() },
      ];

      const result = await llm.json<{ name: string; value: number }>(
        messages,
        "",
      );
      assertEquals(result.name, "Test");
      assertEquals(result.value, 42);
    });

    it("should throw on missing response", async () => {
      const llm = new MockLLMProvider();
      // No responses set

      const messages: ChatMessage[] = [
        { role: "user", content: "test", timestamp: Date.now() },
      ];

      await assertRejects(
        () => llm.json(messages, ""),
        Error,
        "No mock response available",
      );
    });

    it("should throw on invalid JSON", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses(["not valid json"]);

      const messages: ChatMessage[] = [
        { role: "user", content: "test", timestamp: Date.now() },
      ];

      await assertRejects(() => llm.json(messages, ""), SyntaxError);
    });
  });
});
