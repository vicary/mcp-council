/**
 * Database layer for persisting council state using Deno.Kv
 */

import type { ChatMessage } from "./llm.ts";

/**
 * Persona definition for council members and candidates
 */
export interface Persona {
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

  async getAllMembers(): Promise<Member[]> {
    const members: Member[] = [];
    for await (const entry of this.kv.list<Member>({ prefix: ["members"] })) {
      members.push(entry.value);
    }
    return members;
  }

  async deleteMember(id: string): Promise<void> {
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

  async getAllCandidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for await (
      const entry of this.kv.list<Candidate>({ prefix: ["candidates"] })
    ) {
      candidates.push(entry.value);
    }
    return candidates;
  }

  async deleteCandidate(id: string): Promise<void> {
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
