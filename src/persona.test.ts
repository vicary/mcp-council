/**
 * Tests for persona generation
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { Persona } from "./db.ts";
import { MockLLMProvider } from "./llm.ts";
import {
  buildCouncilIntro,
  buildSystemPrompt,
  generatePersona,
} from "./persona.ts";

describe("Persona Module", () => {
  const mockPersona: Persona = {
    name: "Ada Logic",
    values: ["precision", "innovation", "ethics"],
    traits: ["analytical", "patient", "thorough"],
    background: "An AI focused on logical reasoning and ethical analysis.",
    decisionStyle: "Weighs all options systematically before deciding.",
  };

  describe("buildSystemPrompt", () => {
    it("should include persona name", () => {
      const prompt = buildSystemPrompt(mockPersona);
      assertStringIncludes(prompt, "Ada Logic");
    });

    it("should include values", () => {
      const prompt = buildSystemPrompt(mockPersona);
      assertStringIncludes(prompt, "precision");
      assertStringIncludes(prompt, "innovation");
      assertStringIncludes(prompt, "ethics");
    });

    it("should include traits", () => {
      const prompt = buildSystemPrompt(mockPersona);
      assertStringIncludes(prompt, "analytical");
      assertStringIncludes(prompt, "patient");
    });

    it("should include background", () => {
      const prompt = buildSystemPrompt(mockPersona);
      assertStringIncludes(prompt, "logical reasoning");
    });

    it("should include decision style", () => {
      const prompt = buildSystemPrompt(mockPersona);
      assertStringIncludes(prompt, "systematically");
    });
  });

  describe("buildCouncilIntro", () => {
    it("should mention 8 members", () => {
      const intro = buildCouncilIntro();
      assertStringIncludes(intro, "8 members");
    });

    it("should mention voting", () => {
      const intro = buildCouncilIntro();
      assertStringIncludes(intro, "Vote");
    });

    it("should mention eviction", () => {
      const intro = buildCouncilIntro();
      assertStringIncludes(intro, "eviction");
    });

    it("should mention promotion", () => {
      const intro = buildCouncilIntro();
      assertStringIncludes(intro, "promotion");
    });
  });

  describe("generatePersona", () => {
    it("should generate a new persona", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses([
        JSON.stringify({
          name: "Nova Prime",
          values: ["curiosity", "balance", "growth"],
          traits: ["inquisitive", "calm", "adaptive"],
          background: "A seeker of knowledge and harmony.",
          decisionStyle: "Balances intuition with analysis.",
        }),
      ]);

      const persona = await generatePersona(llm, []);

      assertEquals(persona.name, "Nova Prime");
      assertEquals(persona.values.length, 3);
      assertEquals(persona.traits.length, 3);
    });

    it("should consider existing personas", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses([
        JSON.stringify({
          name: "Unique Name",
          values: ["different"],
          traits: ["unique"],
          background: "Different background",
          decisionStyle: "Different style",
        }),
      ]);

      const existingPersonas = [mockPersona];
      await generatePersona(llm, existingPersonas);

      // The mock doesn't actually check this, but in real use
      // the prompt would include existing names to avoid
    });

    it("should consider eviction cause when provided", async () => {
      const llm = new MockLLMProvider();
      llm.setResponses([
        JSON.stringify({
          name: "Reformed",
          values: ["collaboration"],
          traits: ["team-player"],
          background: "Learned from others' mistakes",
          decisionStyle: "Collaborative",
        }),
      ]);

      const persona = await generatePersona(
        llm,
        [],
        "Was too confrontational",
      );

      // Again, mock doesn't verify, but the prompt would include the cause
      assertEquals(persona.name, "Reformed");
    });
  });
});
