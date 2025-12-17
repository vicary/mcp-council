/**
 * Unique ID generation utilities
 */

export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

export function generateMemberId(): string {
  return generateId("mem");
}

export function generateCandidateId(): string {
  return generateId("cand");
}
