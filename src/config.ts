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
