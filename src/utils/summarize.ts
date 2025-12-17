/**
 * Summarization utilities for context management
 */

import type { ChatMessage, LLMProvider } from "../llm.ts";

const SUMMARIZE_THRESHOLD = 3; // rounds

export async function summarizeHistory(
  history: ChatMessage[],
  llm: LLMProvider,
): Promise<ChatMessage[]> {
  if (history.length < SUMMARIZE_THRESHOLD * 2) {
    return history;
  }

  const toSummarize = history.slice(0, -SUMMARIZE_THRESHOLD);
  const recent = history.slice(-SUMMARIZE_THRESHOLD);

  const summary = await llm.complete([
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
  ]);

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
