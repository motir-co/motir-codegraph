import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type pg from 'pg';

import { enqueueJob } from '../../src/db/indexJobs.js';
import { gitBlobHash } from '../../src/fetch/gitBlob.js';
import type { FetchStep, WorkerLogger } from '../../src/worker/runJob.js';
import { bindTo, sha, type QueueTenant } from './queue.js';

/** A tree as path → contents. */
export type Tree = Record<string, string>;

/** One captured log line. */
export interface LogLine {
  level: string;
  fields: Record<string, unknown>;
  message: string;
}

/** A logger that appends every line to `lines`. */
export function capturingLogger(lines: LogLine[]): WorkerLogger {
  return {
    info: (fields, message) => lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => lines.push({ level: 'error', fields, message }),
  };
}

/** A fetch step that writes `tree` under the target directory and hashes it, as the fetcher does. */
export function serveTree(tree: Tree): FetchStep {
  return async ({ dir }) => {
    const root = join(dir, 'tree');
    const paths = new Map<string, string>();
    const sizes = new Map<string, number>();
    let totalBytes = 0;
    for (const [path, contents] of Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const bytes = Buffer.from(contents, 'utf8');
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), bytes);
      paths.set(path, gitBlobHash(bytes));
      sizes.set(path, bytes.length);
      totalBytes += bytes.length;
    }
    return { ok: true, tree: { paths, sizes, fileCount: paths.size, totalBytes, root } };
  };
}

/** `count` small text files with distinct contents. */
export function bigTree(count: number, label = 'file'): Tree {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `src/f${String(i).padStart(3, '0')}.txt`,
      `${label} ${String(i)}\n`,
    ]),
  );
}

/** The tree's paths → git blob ids. */
export function hashesOf(tree: Tree): Map<string, string> {
  return new Map(
    Object.entries(tree).map(([path, contents]) => [
      path,
      gitBlobHash(Buffer.from(contents, 'utf8')),
    ]),
  );
}

/** A fetch URL carrying a presigned-style secret in its query string. */
export const FETCH_SECRET = 'X-Amz-Signature=fanoutsecret0123';
export const fetchUrlFor = (commit: string) =>
  `https://git.example/${commit}/archive.tar.gz?${FETCH_SECRET}`;

/** Enqueues one request job as the API does, bound to the tenant, and answers its id and commit. */
export async function enqueueRequest(
  pool: pg.Pool,
  tenant: QueueTenant,
  spec: { commit?: string; ref?: string; repositoryId?: string } = {},
): Promise<{ jobId: string; commit: string }> {
  const commit = spec.commit ?? sha();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await bindTo(c, tenant);
    const job = await enqueueJob(c, {
      tenantId: tenant.tenantId,
      repositoryId: spec.repositoryId ?? tenant.repositoryId,
      clientId: tenant.clientId,
      kind: 'first_index',
      commitSha: commit,
      refName: spec.ref ?? 'refs/heads/main',
      isDefaultBranch: true,
      fetchUrl: fetchUrlFor(commit),
    });
    await c.query('COMMIT');
    return { jobId: job.id, commit };
  } finally {
    c.release();
  }
}
