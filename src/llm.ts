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
  complete(messages: ChatMessage[]): Promise<string>;
  completeJSON<T>(messages: ChatMessage[], schema: string): Promise<T>;
}

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * OpenAI-compatible LLM provider
 */
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: LLMConfig = {}) {
    const {
      OPENAI_API_KEY,
      OPENAI_BASE_URL = "https://api.openai.com/v1",
      OPENAI_MODEL = "gpt-5.2",
    } = ensureVariables("OPENAI_API_KEY");

    this.apiKey = config.apiKey || OPENAI_API_KEY;
    this.baseUrl = config.baseUrl ||
      OPENAI_BASE_URL;
    this.model = config.model || OPENAI_MODEL;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  async completeJSON<T>(messages: ChatMessage[], _schema: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LLM request failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    return JSON.parse(content) as T;
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

  complete(_messages: ChatMessage[]): Promise<string> {
    if (this.callIndex >= this.responses.length) {
      return Promise.resolve("Mock response");
    }
    return Promise.resolve(this.responses[this.callIndex++]);
  }

  completeJSON<T>(_messages: ChatMessage[], _schema: string): Promise<T> {
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
