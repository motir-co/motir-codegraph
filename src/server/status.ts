import type { RepositoryRow } from './binding.js';

/**
 * The one answer of `GET /v1/tenants/:tenantId/repositories/:repositoryId/status`.
 * Later epics fill its fields from their own tables and add `state` members;
 * they never rename or drop a key (docs/api-contract.md).
 */
export type StatusState = 'not_indexed';

/** An index job that has started and not finished. */
export interface InProgressJob {
  jobId: string;
  commit: string;
  startedAt: string;
}

/** The most recent index job that failed, and why. */
export interface LastFailure {
  reason: string;
  commit: string;
  failedAt: string;
}

/** How precisely one language of the repository is indexed. */
export interface LanguageCoverage {
  language: string;
  /** `precise` from SCIP, `tree_sitter` from syntax only. */
  precision: 'precise' | 'tree_sitter';
}

export interface RepositoryStatus {
  tenantId: string;
  repositoryId: string;
  state: StatusState;
  /** The commit sha the index answers for, or null. */
  indexedCommit: string | null;
  inProgressJob: InProgressJob | null;
  lastFailure: LastFailure | null;
  languages: LanguageCoverage[];
}

/** Every top-level key of the answer, in order; the status test pins it. */
export const REPOSITORY_STATUS_KEYS: readonly (keyof RepositoryStatus)[] = [
  'tenantId',
  'repositoryId',
  'state',
  'indexedCommit',
  'inProgressJob',
  'lastFailure',
  'languages',
];

/**
 * The answer for a repository nothing has indexed: every registered
 * repository, until the indexing epic exists. The ids come from the row the
 * database returned, never from the path.
 */
export function notIndexedStatus(repository: RepositoryRow): RepositoryStatus {
  return {
    tenantId: repository.tenant_id,
    repositoryId: repository.id,
    state: 'not_indexed',
    indexedCommit: null,
    inProgressJob: null,
    lastFailure: null,
    languages: [],
  };
}
