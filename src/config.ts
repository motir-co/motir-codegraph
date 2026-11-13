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

/** The depth past which a published layer is due for compaction, when unset. */
export const DEFAULT_COMPACTION_THRESHOLD = 8;

/** The depth at which a commit is written as a base, when unset. */
export const DEFAULT_HARD_CEILING = 32;

/** How long a staged layer may sit before it is discarded, when unset: two hours. */
export const DEFAULT_STAGED_LAYER_STALENESS_MS = 7_200_000;

/**
 * The three knobs of the commit-layer library (src/layers): service
 * configuration, read once by the process that hosts the library's calls and
 * handed down. Never per tenant or per repository.
 */
export interface LayerSettings {
  /**
   * A layer depth (a whole number of layers above its base). A published layer
   * deeper than this is due for compaction into a new base. Always below
   * `hardCeiling - 1`, so compaction can fire before the ceiling forces a base.
   */
  readonly compactionThreshold: number;
  /**
   * A layer depth. A commit whose parent's chain has reached it is written as
   * a base instead of a deeper delta, so no chain is ever longer than this.
   */
  readonly hardCeiling: number;
  /**
   * Milliseconds. A staged layer older than this was left by a dead job and is
   * discarded, which releases the blobs it pinned. Longer than any index job.
   */
  readonly stagedLayerStaleness: number;
}

/** A whole number of 1 or more from `name`, or `fallback` when unset or blank. */
function readPositiveWhole(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\s*\d+\s*$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number of 1 or more, not ${raw}.`);
  }
  return value;
}

/**
 * `COMPACTION_THRESHOLD`, `HARD_CEILING` and `STAGED_LAYER_STALENESS_MS`, each
 * defaulted when unset or blank (8, 32 and 7,200,000 ms). A value that is not
 * a whole number of 1 or more is refused naming its variable. The pair is then
 * checked over the EFFECTIVE values: no layer is deeper than the ceiling minus
 * one (a parent at the ceiling is followed by a base) and a layer is due only
 * when strictly deeper than the threshold, so a threshold at or above the
 * ceiling minus one could never fire and is refused naming both.
 *
 * The one way to obtain these values: nothing is read at import, and there is
 * no variant that skips the pair check.
 */
export function readLayerSettings(env: NodeJS.ProcessEnv = process.env): LayerSettings {
  const compactionThreshold = readPositiveWhole(
    env,
    'COMPACTION_THRESHOLD',
    DEFAULT_COMPACTION_THRESHOLD,
  );
  const hardCeiling = readPositiveWhole(env, 'HARD_CEILING', DEFAULT_HARD_CEILING);
  const stagedLayerStaleness = readPositiveWhole(
    env,
    'STAGED_LAYER_STALENESS_MS',
    DEFAULT_STAGED_LAYER_STALENESS_MS,
  );
  if (compactionThreshold >= hardCeiling - 1) {
    throw new Error(
      `COMPACTION_THRESHOLD (${String(compactionThreshold)}) must be below HARD_CEILING (${String(hardCeiling)}) minus one: no layer is deeper than the ceiling minus one, so compaction past this threshold could never fire.`,
    );
  }
  return { compactionThreshold, hardCeiling, stagedLayerStaleness };
}

/** The compressed-source cap when `FETCH_BYTE_CAP_BYTES` is unset: 256 MiB. */
export const DEFAULT_FETCH_BYTE_CAP_BYTES = 268_435_456;

/** The extracted-bytes cap when `TAR_BYTE_CAP_BYTES` is unset: 1 GiB. */
export const DEFAULT_TAR_BYTE_CAP_BYTES = 1_073_741_824;

/** The whole-fetch deadline when `FETCH_TIMEOUT_MS` is unset: two minutes. */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * The fetcher's four settings (src/fetch): service configuration, the same for
 * every tenant and repository, read once by the process that fetches.
 */
export interface FetchSettings {
  /** Bytes. A source archive larger than this, declared or streamed, is refused. */
  readonly byteCapBytes: number;
  /** Bytes. An archive whose regular files extract to more than this is refused. */
  readonly tarByteCapBytes: number;
  /** Milliseconds for the whole fetch: every redirect, the download, the extraction and the hash. */
  readonly timeoutMs: number;
  /**
   * Lower-cased bare host names whose addresses may be loopback or private (a
   * source host inside the deployment's own network). Never exempts the
   * link-local and instance-metadata ranges.
   */
  readonly allowedHosts: readonly string[];
}

/**
 * `FETCH_ALLOWED_HOSTS`: comma-separated bare host names, matched
 * case-insensitively, empty entries dropped. An entry carrying a scheme, a
 * port, a path or a wildcard is a configuration error naming the variable and
 * the entry.
 */
function readAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.FETCH_ALLOWED_HOSTS ?? '';
  const hosts: string[] = [];
  for (const entry of raw.split(',')) {
    const host = entry.trim().toLowerCase();
    if (host === '') continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
      throw new Error(
        `FETCH_ALLOWED_HOSTS entries must be bare host names (no scheme, port, path or wildcard), not ${entry.trim()}.`,
      );
    }
    hosts.push(host);
  }
  return hosts;
}

/**
 * `FETCH_BYTE_CAP_BYTES`, `TAR_BYTE_CAP_BYTES` and `FETCH_TIMEOUT_MS`, each
 * defaulted when unset or blank (256 MiB, 1 GiB and 120,000 ms) and refused
 * naming its variable when it is not a whole number of 1 or more, and
 * `FETCH_ALLOWED_HOSTS`. Reads nothing else.
 */
export function readFetchSettings(env: NodeJS.ProcessEnv = process.env): FetchSettings {
  return {
    byteCapBytes: readPositiveWhole(env, 'FETCH_BYTE_CAP_BYTES', DEFAULT_FETCH_BYTE_CAP_BYTES),
    tarByteCapBytes: readPositiveWhole(env, 'TAR_BYTE_CAP_BYTES', DEFAULT_TAR_BYTE_CAP_BYTES),
    timeoutMs: readPositiveWhole(env, 'FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS),
    allowedHosts: readAllowedHosts(env),
  };
}
