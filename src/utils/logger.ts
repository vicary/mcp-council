/**
 * Logger interface for dependency injection
 */
export interface Logger {
  operation(...args: unknown[]): void;
}

/**
 * Default logger that outputs to stderr
 */
export const defaultLogger: Logger = {
  operation: (...args) => console.error(...args),
};

/**
 * Silent logger for tests
 */
export const silentLogger: Logger = {
  operation: () => {},
};
