/**
 * The pre-layer hook: checks a job's fetched tree after it is hashed and
 * before any layer is opened, so a refusal writes nothing. The per-repository
 * size refusals plug in here; this module ships with no check registered.
 */

/** What a check is given: the job's identity and the tree it fetched. */
export interface PreLayerCheckInput {
  readonly tenantId: string;
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly refName: string;
  readonly isDefaultBranch: boolean;
  readonly tree: {
    /** Tree path → git blob id. */
    readonly paths: ReadonlyMap<string, string>;
    /** Tree path → bytes. */
    readonly sizes: ReadonlyMap<string, number>;
    readonly fileCount: number;
    readonly totalBytes: number;
  };
}

/** Pass, or ONE refusal that ends the job `failed` with its code and message. */
export type PreLayerOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: string; readonly message: string };

export type PreLayerCheck = (
  input: PreLayerCheckInput,
) => PreLayerOutcome | Promise<PreLayerOutcome>;

/** The checks every job runs, in order. None is registered yet. */
export const PRE_LAYER_CHECKS: readonly PreLayerCheck[] = [];

const PASS: PreLayerOutcome = { ok: true };

/** Runs `checks` in order and answers the first refusal, or pass. */
export async function runPreLayerChecks(
  input: PreLayerCheckInput,
  checks: readonly PreLayerCheck[] = PRE_LAYER_CHECKS,
): Promise<PreLayerOutcome> {
  for (const check of checks) {
    const outcome = await check(input);
    if (!outcome.ok) return outcome;
  }
  return PASS;
}
