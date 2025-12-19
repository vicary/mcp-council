/**
 * Database layer for persisting council state using Deno.Kv
 */

import { monotonicUlid } from "@std/ulid";
import type { ChatMessage } from "./llm.ts";

/**
 * Pagination options for list operations
 */
export interface ListOptions {
  limit?: number;
  reverse?: boolean;
  cursor?: string;
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
  items: T[];
  cursor?: string;
  hasMore: boolean;
}

/**
 * Persona definition for council members and candidates
 */
export interface Persona {
  model?: string;
  name: string;
  values: string[];
  traits: string[];
  background: string;
  decisionStyle: string;
}

/**
 * Active council member
 */
export interface Member {
  id: string;
  persona: Persona;
  createdAt: number;
  promotedAt: number;
  chatHistory: ChatMessage[];
}

/**
 * Candidate waiting for promotion
 */
export interface Candidate {
  id: string;
  persona: Persona;
  createdAt: number;
  fitness: number;
  chatHistory: ChatMessage[];
  evictedAt?: number;
  evictionReason?: string;
}

/**
 * Global council state
 */
export interface CouncilState {
  memberIds: string[];
  candidateIds: string[];
  targetPoolSize: number;
  roundsSinceEviction: number;
  lastRemovalCauses: string[];
  removalHistorySummary?: string;
}

export class CouncilDB {
  private kv!: Deno.Kv;
  private closed = false;

  private constructor() {
    // Private constructor - use CouncilDB.open() instead
  }

  /**
   * Open a connection to the KV store
   * @param path Optional path for the database. Use ":memory:" for in-memory testing.
   */
  static async open(path?: string): Promise<CouncilDB> {
    const db = new CouncilDB();
    db.kv = await Deno.openKv(path);
    await db.ensureCouncilState();
    return db;
  }

  private async ensureCouncilState(): Promise<void> {
    const res = await this.kv.get<CouncilState>(["state"]);
    if (!res.value) {
      const initialState: CouncilState = {
        memberIds: [],
        candidateIds: [],
        targetPoolSize: 20,
        roundsSinceEviction: 0,
        lastRemovalCauses: [],
      };
      await this.kv.set(["state"], initialState);
    }
  }

  private static readonly MAX_RETRIES = 10;

  private async retryDelay(attempt: number): Promise<void> {
    // Exponential backoff with jitter: 1-2ms, 2-4ms, 4-8ms, etc.
    const baseDelay = Math.pow(2, attempt);
    const jitter = Math.random() * baseDelay;
    await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
  }

  // Member operations
  async saveMember(member: Member): Promise<void> {
    for (let attempt = 0; attempt < CouncilDB.MAX_RETRIES; attempt++) {
      const { state, versionstamp } = await this.getCouncilStateWithVersion();
      if (!state.memberIds.includes(member.id)) {
        state.memberIds.push(member.id);
      }
      const result = await this.kv.atomic()
        .check({ key: ["state"], versionstamp })
        .set(["members", member.id], member)
        .set(["state"], state)
        .commit();
      if (result.ok) return;
      await this.retryDelay(attempt);
    }
    throw new Error("Failed to save member after max retries");
  }

  async getMember(id: string): Promise<Member | null> {
    const res = await this.kv.get<Member>(["members", id]);
    return res.value;
  }

  async getAllMembers(options?: ListOptions): Promise<PaginatedResult<Member>> {
    return await this.listWithPagination<Member>(["members"], options);
  }

  /**
   * Generic paginated list helper
   */
  private async listWithPagination<T>(
    prefix: Deno.KvKey,
    options?: ListOptions,
  ): Promise<PaginatedResult<T>> {
    const limit = options?.limit;
    const reverse = options?.reverse ?? false;
    const cursor = options?.cursor;

    const items: T[] = [];
    let lastKey: string | undefined;
    let hasMore = false;

    // Build selector based on cursor position
    let selector: Deno.KvListSelector;
    if (cursor) {
      const cursorKey = [...prefix, cursor];
      if (reverse) {
        // For reverse, we want items with keys < cursor
        selector = { prefix, end: cursorKey };
      } else {
        // For forward, we want items with keys > cursor
        selector = { prefix, start: cursorKey };
      }
    } else {
      selector = { prefix };
    }

    for await (const entry of this.kv.list<T>(selector, { reverse })) {
      // Skip the cursor key itself if present
      if (cursor && entry.key[entry.key.length - 1] === cursor) {
        continue;
      }

      if (limit && items.length >= limit) {
        hasMore = true;
        break;
      }

      items.push(entry.value);
      lastKey = entry.key[entry.key.length - 1] as string;
    }

    return {
      items,
      cursor: hasMore ? lastKey : undefined,
      hasMore,
    };
  }

  async getMembersByIds(ids: string[]): Promise<Member[]> {
    if (ids.length === 0) return [];

    // Deno KV getMany has a limit of 10 keys, so batch the requests
    const BATCH_SIZE = 10;
    const results: Member[] = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const keys = batchIds.map((id) => ["members", id] as const);
      const batchResults = await this.kv.getMany<Member[]>(keys);
      for (const r of batchResults) {
        if (r.value !== null) {
          results.push(r.value);
        }
      }
    }

    return results;
  }

  async deleteMember(id: string): Promise<void> {
    // Delete history first (multiple ULID-keyed entries)
    await this.deleteHistory("member", id);

    for (let attempt = 0; attempt < CouncilDB.MAX_RETRIES; attempt++) {
      const { state, versionstamp } = await this.getCouncilStateWithVersion();
      state.memberIds = state.memberIds.filter((mid) => mid !== id);
      const result = await this.kv.atomic()
        .check({ key: ["state"], versionstamp })
        .delete(["members", id])
        .set(["state"], state)
        .commit();
      if (result.ok) return;
      await this.retryDelay(attempt);
    }
    throw new Error("Failed to delete member after max retries");
  }

  // Candidate operations
  async saveCandidate(candidate: Candidate): Promise<void> {
    for (let attempt = 0; attempt < CouncilDB.MAX_RETRIES; attempt++) {
      const { state, versionstamp } = await this.getCouncilStateWithVersion();
      if (!state.candidateIds.includes(candidate.id)) {
        state.candidateIds.push(candidate.id);
      }
      const result = await this.kv.atomic()
        .check({ key: ["state"], versionstamp })
        .set(["candidates", candidate.id], candidate)
        .set(["state"], state)
        .commit();
      if (result.ok) return;
      await this.retryDelay(attempt);
    }
    throw new Error("Failed to save candidate after max retries");
  }

  async getCandidate(id: string): Promise<Candidate | null> {
    const res = await this.kv.get<Candidate>(["candidates", id]);
    return res.value;
  }

  async getAllCandidates(
    options?: ListOptions,
  ): Promise<PaginatedResult<Candidate>> {
    return await this.listWithPagination<Candidate>(["candidates"], options);
  }

  async getCandidatesByIds(ids: string[]): Promise<Candidate[]> {
    if (ids.length === 0) return [];

    // Deno KV getMany has a limit of 10 keys, so batch the requests
    const BATCH_SIZE = 10;
    const results: Candidate[] = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const keys = batchIds.map((id) => ["candidates", id] as const);
      const batchResults = await this.kv.getMany<Candidate[]>(keys);
      for (const r of batchResults) {
        if (r.value !== null) {
          results.push(r.value);
        }
      }
    }

    return results;
  }

  async deleteCandidate(id: string): Promise<void> {
    // Delete history first (multiple ULID-keyed entries)
    await this.deleteHistory("candidate", id);

    for (let attempt = 0; attempt < CouncilDB.MAX_RETRIES; attempt++) {
      const { state, versionstamp } = await this.getCouncilStateWithVersion();
      state.candidateIds = state.candidateIds.filter((cid) => cid !== id);
      const result = await this.kv.atomic()
        .check({ key: ["state"], versionstamp })
        .delete(["candidates", id])
        .set(["state"], state)
        .commit();
      if (result.ok) return;
      await this.retryDelay(attempt);
    }
    throw new Error("Failed to delete candidate after max retries");
  }

  /**
   * Evict a candidate (mark as evicted instead of deleting)
   */
  async evictCandidate(id: string, reason: string): Promise<void> {
    const candidate = await this.getCandidate(id);
    if (!candidate) return;

    candidate.evictedAt = Date.now();
    candidate.evictionReason = reason;

    for (let attempt = 0; attempt < CouncilDB.MAX_RETRIES; attempt++) {
      const { state, versionstamp } = await this.getCouncilStateWithVersion();
      state.candidateIds = state.candidateIds.filter((cid) => cid !== id);
      const result = await this.kv.atomic()
        .check({ key: ["state"], versionstamp })
        .delete(["candidates", id])
        .set(["evicted", id], candidate)
        .set(["state"], state)
        .commit();
      if (result.ok) return;
      await this.retryDelay(attempt);
    }
    throw new Error("Failed to evict candidate after max retries");
  }

  /**
   * Get all evicted candidates (paginated)
   */
  async getAllEvictedCandidates(
    options?: ListOptions,
  ): Promise<PaginatedResult<Candidate>> {
    return this.listWithPagination<Candidate>(["evicted"], options);
  }

  /**
   * Get a specific evicted candidate
   */
  async getEvictedCandidate(id: string): Promise<Candidate | null> {
    const res = await this.kv.get<Candidate>(["evicted", id]);
    return res.value;
  }

  /**
   * Delete an evicted candidate permanently
   */
  async deleteEvictedCandidate(id: string): Promise<void> {
    // Delete all history entries for this candidate
    await this.deleteHistory("candidate", id);
    await this.kv.delete(["evicted", id]);
  }

  // Message history operations (separate storage for TUI review)
  // Messages are stored as: ["history", type, id, ulid] -> ChatMessage
  // This allows efficient pagination and reverse ordering with Kv.list()
  private static readonly MAX_HISTORY_MESSAGES = 100;

  /**
   * Append a message to the history
   * Messages are stored with ULID keys for sortable, paginated access
   */
  async appendToHistory(
    type: "member" | "candidate",
    id: string,
    message: ChatMessage,
  ): Promise<void> {
    const msgId = monotonicUlid();
    const key = ["history", type, id, msgId];
    await this.kv.set(key, message);

    // Trim old messages if over limit
    await this.trimHistory(type, id);
  }

  /**
   * Append multiple messages to history
   */
  async appendManyToHistory(
    type: "member" | "candidate",
    id: string,
    messages: ChatMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;

    // Use atomic batch for efficiency
    let atomic = this.kv.atomic();
    for (const message of messages) {
      const msgId = monotonicUlid();
      const key = ["history", type, id, msgId];
      atomic = atomic.set(key, message);
    }
    await atomic.commit();

    // Trim old messages if over limit
    await this.trimHistory(type, id);
  }

  /**
   * Trim history to keep only last MAX_HISTORY_MESSAGES
   */
  private async trimHistory(
    type: "member" | "candidate",
    id: string,
  ): Promise<void> {
    const prefix = ["history", type, id];
    const allKeys: Deno.KvKey[] = [];

    // Collect all keys (oldest first, since ULIDs are lexicographically sorted)
    for await (const entry of this.kv.list({ prefix })) {
      allKeys.push(entry.key);
    }

    // Delete oldest entries if over limit
    const excess = allKeys.length - CouncilDB.MAX_HISTORY_MESSAGES;
    if (excess > 0) {
      const keysToDelete = allKeys.slice(0, excess);
      let atomic = this.kv.atomic();
      for (const key of keysToDelete) {
        atomic = atomic.delete(key);
      }
      await atomic.commit();
    }
  }

  /**
   * Get message history for TUI review (paginated)
   * Returns messages in reverse chronological order by default (newest first)
   */
  async getMessageHistory(
    type: "member" | "candidate",
    id: string,
    options?: ListOptions,
  ): Promise<PaginatedResult<ChatMessage>> {
    const prefix: Deno.KvKey = ["history", type, id];
    // Default to reverse order (newest first)
    const reverse = options?.reverse ?? true;
    const limit = options?.limit;
    const cursor = options?.cursor;

    const items: ChatMessage[] = [];
    let lastKey: string | undefined;
    let hasMore = false;

    // Build selector based on cursor position
    let selector: Deno.KvListSelector;
    if (cursor) {
      const cursorKey = [...prefix, cursor];
      if (reverse) {
        selector = { prefix, end: cursorKey };
      } else {
        selector = { prefix, start: cursorKey };
      }
    } else {
      selector = { prefix };
    }

    for await (
      const entry of this.kv.list<ChatMessage>(selector, { reverse })
    ) {
      // Skip the cursor key itself if present
      const keyId = entry.key[entry.key.length - 1] as string;
      if (cursor && keyId === cursor) {
        continue;
      }

      if (limit && items.length >= limit) {
        hasMore = true;
        break;
      }

      items.push(entry.value);
      lastKey = keyId;
    }

    return {
      items,
      cursor: hasMore ? lastKey : undefined,
      hasMore,
    };
  }

  /**
   * Get total count of history messages
   */
  async getHistoryCount(
    type: "member" | "candidate",
    id: string,
  ): Promise<number> {
    const prefix = ["history", type, id];
    let count = 0;
    for await (const _ of this.kv.list({ prefix })) {
      count++;
    }
    return count;
  }

  /**
   * Delete all history for a member or candidate
   */
  private async deleteHistory(
    type: "member" | "candidate",
    id: string,
  ): Promise<void> {
    const prefix = ["history", type, id];
    const keysToDelete: Deno.KvKey[] = [];

    for await (const entry of this.kv.list({ prefix })) {
      keysToDelete.push(entry.key);
    }

    // Delete in batches of 10 (atomic operation limit)
    const batchSize = 10;
    for (let i = 0; i < keysToDelete.length; i += batchSize) {
      const batch = keysToDelete.slice(i, i + batchSize);
      let atomic = this.kv.atomic();
      for (const key of batch) {
        atomic = atomic.delete(key);
      }
      await atomic.commit();
    }
  }

  // Council state operations
  async getCouncilState(): Promise<CouncilState> {
    const res = await this.kv.get<CouncilState>(["state"]);
    if (!res.value) {
      throw new Error("Council state not found");
    }
    return res.value;
  }

  private async getCouncilStateWithVersion(): Promise<
    { state: CouncilState; versionstamp: string }
  > {
    const res = await this.kv.get<CouncilState>(["state"]);
    if (!res.value || !res.versionstamp) {
      throw new Error("Council state not found");
    }
    return { state: res.value, versionstamp: res.versionstamp };
  }

  async saveCouncilState(state: CouncilState): Promise<void> {
    await this.kv.set(["state"], state);
  }

  async saveMembers(members: Member[]): Promise<void> {
    if (members.length === 0) return;
    await Promise.all(members.map((m) => this.saveMember(m)));
  }

  async saveCandidates(candidates: Candidate[]): Promise<void> {
    if (candidates.length === 0) return;
    await Promise.all(candidates.map((c) => this.saveCandidate(c)));
  }

  // Utility
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.kv.close();
  }

  async clear(): Promise<void> {
    // Delete all members
    for await (const entry of this.kv.list({ prefix: ["members"] })) {
      await this.kv.delete(entry.key);
    }

    // Delete all candidates
    for await (const entry of this.kv.list({ prefix: ["candidates"] })) {
      await this.kv.delete(entry.key);
    }

    // Delete all evicted candidates
    for await (const entry of this.kv.list({ prefix: ["evicted"] })) {
      await this.kv.delete(entry.key);
    }

    // Delete all message histories
    for await (const entry of this.kv.list({ prefix: ["history"] })) {
      await this.kv.delete(entry.key);
    }

    // Reset state
    const initialState: CouncilState = {
      memberIds: [],
      candidateIds: [],
      targetPoolSize: 20,
      roundsSinceEviction: 0,
      lastRemovalCauses: [],
    };
    await this.kv.set(["state"], initialState);
  }
}
