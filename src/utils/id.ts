import { monotonicUlid } from "@std/ulid";

/**
 * Unique ID generation utilities
 */

export function generateId(): string {
  return monotonicUlid();
}
