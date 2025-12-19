/**
 * LLM Provider abstraction for AI completions
 */

import { ensureVariables } from "./utils/env.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface LLMProvider {
  text(messages: ChatMessage[], model?: string): Promise<string>;
  json<T>(messages: ChatMessage[], schema: string, model?: string): Promise<T>;
}

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * OpenAI-compatible LLM provider
 */
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;

  private static readonly JSON_RETRY_MAX = 2;

  constructor(config: LLMConfig = {}) {
    const {
      OPENAI_API_KEY,
      OPENAI_BASE_URL = "https://api.openai.com/v1",
    } = ensureVariables("OPENAI_API_KEY");

    this.apiKey = config.apiKey || OPENAI_API_KEY;
    this.baseUrl = config.baseUrl || OPENAI_BASE_URL;
  }

  private async fetchCompletion(
    messages: Array<{ role: string; content: string }>,
    model?: string,
    jsonMode = false,
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(jsonMode && { response_format: { type: "json_object" } }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async text(
    messages: ChatMessage[],
    model?: string,
  ): Promise<string> {
    return await this.fetchCompletion(
      messages.map((m) => ({ role: m.role, content: m.content })),
      model,
    );
  }

  async json<T>(
    messages: ChatMessage[],
    _schema: string,
    model?: string,
  ): Promise<T> {
    const apiMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    let content = await this.fetchCompletion(apiMessages, model, true);
    let lastError: Error | null = null;

    // Try parsing with auto-retry on malformed JSON
    for (let attempt = 0; attempt <= OpenAIProvider.JSON_RETRY_MAX; attempt++) {
      try {
        return JSON.parse(content) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < OpenAIProvider.JSON_RETRY_MAX) {
          // Ask LLM to fix the malformed JSON
          content = await this.fetchCompletion(
            [
              ...apiMessages,
              { role: "assistant", content },
              {
                role: "user",
                content:
                  `Your response was not valid JSON. Error: ${lastError.message}\n\nPlease respond with ONLY valid JSON, no markdown or extra text.`,
              },
            ],
            model,
            true,
          );
        }
      }
    }

    throw new Error(
      `Failed to parse JSON after ${
        OpenAIProvider.JSON_RETRY_MAX + 1
      } attempts: ${lastError?.message}`,
    );
  }
}

/**
 * Mock LLM provider for testing
 */
export class MockLLMProvider implements LLMProvider {
  private responses: string[] = [];
  private callIndex = 0;

  setResponses(responses: string[]): void {
    this.responses = responses;
    this.callIndex = 0;
  }

  pushResponse(response: string): void {
    this.responses.push(response);
  }

  text(_messages: ChatMessage[], _model?: string): Promise<string> {
    if (this.callIndex >= this.responses.length) {
      return Promise.resolve("Mock response");
    }
    return Promise.resolve(this.responses[this.callIndex++]);
  }

  json<T>(
    _messages: ChatMessage[],
    _schema: string,
    _model?: string,
  ): Promise<T> {
    if (this.callIndex >= this.responses.length) {
      return Promise.reject(
        new Error("No mock response available for JSON completion"),
      );
    }
    const response = this.responses[this.callIndex++];
    try {
      return Promise.resolve(JSON.parse(response) as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
}
