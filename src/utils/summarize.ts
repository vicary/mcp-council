/**
 * Summarization utilities for context management
 */

import type { ChatMessage, LLMProvider } from "../llm.ts";

// Default thresholds (messages before summarization triggers)
export const MEMBER_SUMMARIZE_THRESHOLD = 6; // summarize when > 6 messages
export const CANDIDATE_SUMMARIZE_THRESHOLD = 10; // summarize when > 10 messages
export const RECENT_MESSAGES_TO_KEEP = 3; // keep last 3 messages after summarization

export async function summarizeHistory(
  history: ChatMessage[],
  llm: LLMProvider,
  model?: string,
  threshold: number = MEMBER_SUMMARIZE_THRESHOLD,
): Promise<ChatMessage[]> {
  if (history.length <= threshold) {
    return history;
  }

  const toSummarize = history.slice(0, -RECENT_MESSAGES_TO_KEEP);
  const recent = history.slice(-RECENT_MESSAGES_TO_KEEP);

  const summary = await llm.text(
    [
      {
        role: "system",
        content:
          "Summarize the following conversation history concisely, preserving key decisions, votes, and context.",
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n"),
        timestamp: Date.now(),
      },
    ],
    model,
  );

  return [
    {
      role: "system",
      content: `[Previous history summary]: ${summary}`,
      timestamp: Date.now(),
    },
    ...recent,
  ];
}

export function anonymizeSummary(content: string, memberIds: string[]): string {
  let anonymized = content;
  memberIds.forEach((id, index) => {
    anonymized = anonymized.replaceAll(id, `Member_${index + 1}`);
  });
  return anonymized;
}

export async function summarizeRemovalCauses(
  causes: string[],
  llm: LLMProvider,
  model?: string,
): Promise<string> {
  if (causes.length === 0) return "";

  const prompt =
    `Here is a list of recent reasons for removal/eviction from the AI Council:
${causes.map((c) => `- ${c}`).join("\n")}

Summarize these removal reasons into a concise 20-100 word overview that captures the main patterns of behavior that lead to eviction.
Focus on the *types* of failures (e.g. "lack of diversity", "aggression", "repetitive output").
Do not list every single event. Create a cohesive summary.`;

  return await llm.text(
    [
      {
        role: "system",
        content:
          "You are the council archivist. Summarize the history of member removals.",
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
    model,
  );
}
