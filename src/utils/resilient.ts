/**
 * Resilient execution utilities with retry logic
 */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Error representing a failed operation after all retries
 */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly operation: string,
    public readonly lastError: Error,
    public readonly attempts: number,
  ) {
    super(
      `${operation} failed after ${attempts} attempts: ${lastError.message}`,
    );
    this.name = "RetryExhaustedError";
  }
}

/**
 * Result of a resilient parallel operation
 */
export interface ResilientResult<T> {
  successes: T[];
  failures: RetryExhaustedError[];
}

/**
 * Execute a function with retry logic
 * @param fn The function to execute
 * @param operation Name of the operation for error messages
 * @param maxRetries Maximum number of retry attempts
 * @param baseDelayMs Base delay between retries (uses exponential backoff)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number = MAX_RETRIES,
  baseDelayMs: number = RETRY_DELAY_MS,
): Promise<T> {
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        // Exponential backoff
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new RetryExhaustedError(operation, lastError, maxRetries);
}

/**
 * Execute multiple operations in parallel with retry logic for each
 * Uses Promise.allSettled to ensure all operations complete even if some fail
 * @param operations Array of operations to execute
 * @param baseDelayMs Base delay between retries (uses exponential backoff)
 */
export async function resilientParallel<T>(
  operations: Array<{
    fn: () => Promise<T>;
    label: string;
  }>,
  baseDelayMs: number = RETRY_DELAY_MS,
): Promise<ResilientResult<T>> {
  const results = await Promise.allSettled(
    operations.map(({ fn, label }) =>
      withRetry(fn, label, MAX_RETRIES, baseDelayMs)
    ),
  );

  const successes: T[] = [];
  const failures: RetryExhaustedError[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      successes.push(result.value);
    } else {
      if (result.reason instanceof RetryExhaustedError) {
        failures.push(result.reason);
      } else {
        failures.push(
          new RetryExhaustedError(
            "unknown operation",
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
            MAX_RETRIES,
          ),
        );
      }
    }
  }

  return { successes, failures };
}
