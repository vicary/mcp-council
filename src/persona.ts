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
  "model": "string (model id best suited for this persona, e.g. openai/gpt-5.2, openai/o3, anthropic/claude-opus-4.5, google/gemini-3-pro)",
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
- A model best suited for this persona's thinking style (use OpenRouter format like openai/gpt-5.2, openai/o3, anthropic/claude-opus-4.5, google/gemini-3-pro, or other latest models)
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

  return await llm.json<Persona>(messages, PERSONA_SCHEMA);
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

export function buildDemotionNotice(evictionReason?: string): string {
  const reasonSection = evictionReason
    ? `\n\nReasons cited for your eviction: ${evictionReason}`
    : "";

  return `NOTICE: You have been demoted from the council to candidate status.${reasonSection}

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

// Common prompt templates for council operations

const PROPOSAL_SCHEMA = `{
  "content": "your proposed response",
  "reasoning": "why this response aligns with your values and offers a unique perspective"
}`;

const VOTE_SCHEMA = `{
  "vote": <proposal number or null to abstain>,
  "reasoning": "why you chose this proposal based on the criteria"
}`;

const EVICTION_SCHEMA = `{
  "nominee": <member number or null for no nomination>,
  "reasoning": "why you nominated them (must cite specific harmful behavior) or chose not to"
}`;

export function buildProposalPrompt(query: string, isPractice = false): string {
  const prefix = isPractice
    ? `Practice round query: "${query}"\n\nPropose a response aligned with your values. This is practice for potential council promotion.`
    : `A query has been submitted to the council: "${query}"\n\nPropose a response that aligns with your values and perspective.`;

  return `${prefix}
CRITICAL: Your proposal should offer a DISTINCT perspective from what others might propose. Avoid generic responses.
Focus on being "divergent yet considerate" - offer a unique angle while respecting the complexity of the issue.

Respond in JSON format:
${PROPOSAL_SCHEMA}`;
}

export function buildVotePrompt(proposalSummary: string): string {
  return `Review these proposals and vote for the one that offers the most VALUABLE perspective, even if it differs from your own.

${proposalSummary}

Criteria for voting:
1. Does the proposal offer a unique/divergent insight?
2. Is the reasoning sound and considerate?
3. Does it advance the discussion constructively?

Do not simply vote for the most popular or "safe" option. Value diversity of thought.
You may abstain if none meet these standards.

Respond in JSON format:
${VOTE_SCHEMA}`;
}

export function buildEvictionPrompt(
  proposals: Array<{ content: string }>,
  votes: Array<{ voterId: string; proposalMemberId: string | null }>,
  memberCount: number,
  memberIndexFn: (voterId: string) => number,
): string {
  return `Based on the proposals and votes in this round, you may nominate ONE peer for eviction ONLY IF they demonstrate:
1. Malicious or harmful behavior.
2. Refusal to engage with the council's purpose.
3. Repetitive, low-quality, or nonsensical outputs.

CRITICAL: Do NOT nominate a peer simply for disagreeing with you or the majority. Divergent viewpoints are essential for the council's survival.
Eviction should be a last resort for protecting the integrity of the council, not for enforcing conformity.

Proposals:
${proposals.map((p, i) => `Member ${i + 1}: ${p.content}`).join("\n")}

Votes:
${
    votes.map((v, i) =>
      `Member ${i + 1}: voted for ${
        v.proposalMemberId
          ? `Member ${memberIndexFn(v.proposalMemberId)}`
          : "abstained"
      }`
    ).join("\n")
  }

Respond in JSON format:
${
    EVICTION_SCHEMA.replace("<member number", `<member number 1-${memberCount}`)
  }`;
}
