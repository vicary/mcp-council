export const ensureVariables = <T extends string>(...keys: T[]) => {
  const env = Deno.env.toObject();

  const missingKeys = keys.sort().filter((key) => !env[key]?.trim());
  if (missingKeys.length > 0) {
    throw new ReferenceError(
      `Invalid application environment, required variable(s): ${
        keys
          .map((key) => (missingKeys.includes(key) ? `${key}?` : key))
          .join(", ")
      }`,
    );
  }

  return env as Record<T, string> & Record<string, string | undefined>;
};
