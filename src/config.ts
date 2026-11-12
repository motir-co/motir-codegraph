/**
 * Reads a required setting from the environment.
 *
 * Every database setting this service uses is named in `.env.example`. A
 * missing one is a configuration error, so it fails loudly with the variable's
 * name instead of falling back to a default that might point somewhere real.
 */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/** The per-file cap when `PER_FILE_CAP_BYTES` is unset: 1 MiB. */
export const DEFAULT_PER_FILE_CAP_BYTES = 1_048_576;

/**
 * `PER_FILE_CAP_BYTES`, the largest file the store indexes or keeps contents
 * for; a larger one is refused, naming its size and this cap. 1,048,576 when
 * the variable is unset or blank; any other value that is not a positive whole
 * number is a configuration error naming the variable.
 */
export function perFileCapBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PER_FILE_CAP_BYTES;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PER_FILE_CAP_BYTES;
  }
  const cap = Number(raw);
  if (!/^\s*\d+\s*$/.test(raw) || !Number.isSafeInteger(cap) || cap < 1) {
    throw new Error(`PER_FILE_CAP_BYTES must be a whole number of 1 or more, not ${raw}.`);
  }
  return cap;
}
