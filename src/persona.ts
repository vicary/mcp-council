/**
 * Persona generation and management
 */

import type { Persona } from "./db.ts";
import type { ChatMessage, LLMProvider } from "./llm.ts";

const PERSONA_ARCHETYPES = [
  "pragmatic analyst",
  "creative visionary",
  "ethical guardian",
  "risk assessor",
  "systems thinker",
  "devil's advocate",
  "consensus builder",
  "domain expert",
  "futurist",
  "traditionalist",
  "minimalist",
  "maximalist",
];

const PERSONA_SCHEMA = `{
  "name": "string (creative unique name)",
  "values": ["string (core value)", ...],
  "traits": ["string (personality trait)", ...],
  "background": "string (brief background description)",
  "decisionStyle": "string (how they approach decisions)"
}`;

export async function generatePersona(
  llm: LLMProvider,
  existingPersonas: Persona[],
  evictionCause?: string,
): Promise<Persona> {
  // Pick an archetype hint randomly
  const archetype =
    PERSONA_ARCHETYPES[Math.floor(Math.random() * PERSONA_ARCHETYPES.length)];

  // Build a detailed summary of existing personas to help LLM avoid duplication
  const existingPersonaSummaries = existingPersonas.map((p) =>
    `- ${p.name}: values=[${p.values.join(", ")}], traits=[${
      p.traits.join(", ")
    }], style="${p.decisionStyle}"`
  ).join("\n");

  // Collect all existing values and traits to explicitly avoid
  const existingValues = new Set<string>();
  const existingTraits = new Set<string>();
  for (const p of existingPersonas) {
    p.values.forEach((v) => existingValues.add(v.toLowerCase()));
    p.traits.forEach((t) => existingTraits.add(t.toLowerCase()));
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are creating a unique AI council member persona. The persona MUST be distinctly different from all existing members in values, traits, and perspective.

Archetype hint: ${archetype}

EXISTING COUNCIL MEMBERS (you MUST create someone DIFFERENT):
${existingPersonaSummaries || "None yet - be creative!"}

Values already in use (AVOID THESE): ${[...existingValues].join(", ") || "none"}
Traits already in use (AVOID THESE): ${[...existingTraits].join(", ") || "none"}

${
          evictionCause
            ? `This persona is being created to replace someone removed for: ${evictionCause}. Consider what qualities might address this gap.`
            : ""
        }

IMPORTANT: Create a persona that brings a UNIQUE perspective not yet represented. Use different values and traits than listed above. Be creative with the name - avoid generic patterns.

Generate a persona with:
- A creative, memorable, UNIQUE name (not similar to existing names)
- 3-5 core values that guide decisions (DIFFERENT from existing values listed above)
- 3-5 personality traits (DIFFERENT from existing traits listed above)
- A brief background (1-2 sentences) that explains their unique perspective
- A decision-making style description that differs from existing members

Respond with valid JSON matching this schema:
${PERSONA_SCHEMA}`,
      timestamp: Date.now(),
    },
    {
      role: "user",
      content:
        "Generate a unique council member persona that is distinctly different from all existing members.",
      timestamp: Date.now(),
    },
  ];

  return await llm.completeJSON<Persona>(messages, PERSONA_SCHEMA);
}

export function buildSystemPrompt(persona: Persona): string {
  return `You are ${persona.name}, a member of an AI council that deliberates on important decisions.

Your core values: ${persona.values.join(", ")}
Your traits: ${persona.traits.join(", ")}
Background: ${persona.background}
Decision style: ${persona.decisionStyle}

When proposing solutions or voting, stay true to your persona's values and perspective. Be concise but thoughtful.`;
}

export function buildCouncilIntro(): string {
  return `Welcome to the AI Council. You are one of 8 members who deliberate on queries submitted by users.

Your responsibilities:
1. Propose responses aligned with your values when queries arrive
2. Vote on the best proposal from your peers (you cannot vote for yourself)
3. Nominate members for eviction if their proposals/votes conflict with council values
4. Participate in promotion votes when vacancies occur

Decisions require collaboration. Your unique perspective is valuable.`;
}

export function buildCandidateIntro(): string {
  return `You are a candidate for the AI Council, not yet a full member.

As a candidate:
1. You participate in practice rounds to demonstrate your judgment
2. Council members will evaluate your proposals and voting patterns
3. You need a majority vote from council members AND other candidates to be promoted
4. Candidates can be evicted by simple majority (easier than full members who require supermajority)

Your situation is precarious - be thoughtful and demonstrate wisdom. Show that you can:
- Propose balanced, well-reasoned responses
- Vote for proposals that serve the broader good
- Collaborate effectively with diverse perspectives

Survival tip: Avoid extreme positions and build consensus. Your fitness score increases when others vote for your proposals.`;
}

export function buildDemotionNotice(): string {
  return `NOTICE: You have been demoted from the council to candidate status.

This means:
- You lost the protection of supermajority eviction (now only simple majority needed)
- You must prove yourself again through practice rounds
- Your fitness score has been reset to 0

Reflect on what led to your demotion. To regain your position:
- Be more considerate of others' perspectives
- Propose responses that build consensus
- Vote thoughtfully and explain your reasoning clearly

This is your opportunity to demonstrate growth and earn back your seat.`;
}
