/**
 * The fetcher's one refusal, and its closed vocabulary of reason codes: what a
 * job row records when its source could not be turned into a tree. Kept apart
 * from `fetchTree.ts` so every step of the fetch can throw it without an
 * import cycle; `fetchTree.ts` re-exports both.
 */

/** Every reason a fetch is refused for. There is no sixth. */
export const FETCH_REFUSAL_CODES = [
  'not_https',
  'address_refused',
  'source_too_large',
  'fetch_timeout',
  'fetch_failed',
] as const;

export type FetchRefusalCode = (typeof FETCH_REFUSAL_CODES)[number];

/**
 * A fetch that did not produce a tree. `reasonCode` is for the job row; the
 * message is for a person and NEVER holds the URL, its host's query string or
 * anything a server sent: each is a fixed sentence written here.
 */
export class FetchRefusedError extends Error {
  readonly reasonCode: FetchRefusalCode;

  constructor(reasonCode: FetchRefusalCode, message: string) {
    super(message);
    this.name = 'FetchRefusedError';
    this.reasonCode = reasonCode;
  }
}

/** The message every deadline refusal carries. */
export const TIMEOUT_MESSAGE = 'The fetch did not finish within FETCH_TIMEOUT_MS.';

/**
 * Any failure of a fetch step as a refusal: a refusal already raised passes
 * through; anything after the deadline fired is `fetch_timeout`; everything
 * else is `fetch_failed` with the fixed sentence `failed` writes from the
 * error's code (a system code such as ECONNREFUSED, never its message, which
 * can name the host).
 */
export function refusalFrom(
  error: unknown,
  signal: AbortSignal | undefined,
  failed: (code: string | null) => string,
): FetchRefusedError {
  if (error instanceof FetchRefusedError) return error;
  if (signal?.aborted === true) return new FetchRefusedError('fetch_timeout', TIMEOUT_MESSAGE);
  const code = (error as { code?: unknown } | null)?.code;
  return new FetchRefusedError('fetch_failed', failed(typeof code === 'string' ? code : null));
}

/** ` (CODE)` when there is a code, for the end of a fixed sentence. */
export function withCode(code: string | null): string {
  return code === null ? '' : ` (${code})`;
}
