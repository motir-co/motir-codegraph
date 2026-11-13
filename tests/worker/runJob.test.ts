import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_HARD_CEILING, readLayerSettings, type WorkerSettings } from '../../src/config.js';
import { gitBlobHash } from '../../src/fetch/gitBlob.js';
import { enqueueJob } from '../../src/db/indexJobs.js';
import { listCurrentPublishedCommits } from '../../src/db/layers.js';
import { claimNext, inClaimTransaction, renewLease, type Claim } from '../../src/db/workerJobs.js';
import { openLayer } from '../../src/layers/openLayer.js';
import { LayerNotPublishableError, PublishUnboundError } from '../../src/layers/publish.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import { createAppPool } from '../../src/server/pool.js';
import { PRE_LAYER_CHECKS, runPreLayerChecks } from '../../src/worker/preLayerCheck.js';
import {
  CANDIDATE_ANCESTOR_LIMIT,
  failureOf,
  JOB_RUNNERS,
  publishJobLayer,
  redactFetchUrl,
  runJob,
  scratchDirFor,
  storeMissingBlobs,
  type FetchStep,
  type RunJobDeps,
  type WorkerLogger,
} from '../../src/worker/runJob.js';
import { freshDatabase, queryRows, type FreshDatabase } from '../helpers/db.js';
import { recordQueries } from '../helpers/queryLog.js';
import { bindTo, queueTenant, sha, type QueueTenant } from '../helpers/queue.js';
import { asOperator } from '../helpers/tenancy.js';

// One claimed job at a time, run against a real database with the fetch step
// injected: the stub writes a tree to the job's scratch directory and answers
// its hashes the way the fetcher does. Rows are read back as the owner.

type Tree = Record<string, string>;

let db: FreshDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let scratch: string;
let t: QueueTenant;
let lines: { level: string; fields: Record<string, unknown>; message: string }[];

const SECRET = 'X-Amz-Signature=deadbeefcafe';
const fetchUrlFor = (n: string) => `https://git.example/${n}/archive.tar.gz?${SECRET}`;

const log: WorkerLogger = {
  info: (fields, message) => lines.push({ level: 'info', fields, message }),
  warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
  error: (fields, message) => lines.push({ level: 'error', fields, message }),
};

function settings(overrides: Partial<WorkerSettings> = {}): WorkerSettings {
  return {
    pollMs: 10,
    jobLeaseMs: 60_000,
    maxAttempts: 3,
    scratchDir: scratch,
    blobStoreBatchSize: 500,
    ...overrides,
  };
}

/** A fetch step that writes `tree` under the job's directory and hashes it. */
function serve(tree: Tree): FetchStep {
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

function deps(fetch: FetchStep, overrides: Partial<RunJobDeps> = {}): RunJobDeps {
  return {
    pool,
    settings: settings(),
    layerSettings: readLayerSettings({}),
    fetch,
    log,
    ...overrides,
  };
}

interface JobSpec {
  kind?: 'first_index' | 'push' | 'refresh';
  commit?: string;
  ref?: string;
  isDefaultBranch?: boolean;
  previousHead?: string;
  changedPaths?: string[];
  repositoryId?: string;
  tenant?: QueueTenant;
}

/** Enqueues one job as the API does, bound to the tenant, and claims it. */
async function enqueueAndClaim(spec: JobSpec = {}): Promise<{ claim: Claim; commit: string }> {
  const tenant = spec.tenant ?? t;
  const commit = spec.commit ?? sha();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await bindTo(c, tenant);
    await enqueueJob(c, {
      tenantId: tenant.tenantId,
      repositoryId: spec.repositoryId ?? tenant.repositoryId,
      clientId: tenant.clientId,
      kind: spec.kind ?? 'first_index',
      commitSha: commit,
      refName: spec.ref ?? 'refs/heads/main',
      isDefaultBranch: spec.isDefaultBranch ?? true,
      candidateAncestors: spec.previousHead === undefined ? [] : [spec.previousHead],
      changedPaths: spec.changedPaths ?? [],
      fetchUrl: fetchUrlFor(commit),
    });
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const claim = await claimNext(pool, settings());
  expect(claim).not.toBeNull();
  return { claim: claim as Claim, commit };
}

async function job(id: string) {
  return (
    await queryRows<{
      state: string;
      failure_reason_code: string | null;
      failure_message: string | null;
      fetch_url: string | null;
      ended_at: Date | null;
      claimed_by: string | null;
    }>(
      owner,
      `SELECT state, failure_reason_code, failure_message, fetch_url, ended_at, claimed_by
         FROM codegraph.index_jobs WHERE id = $1`,
      [id],
    )
  )[0];
}

async function layersOf(repositoryId: string) {
  return await queryRows<{
    id: string;
    commit_sha: string;
    kind: string;
    parent_layer_id: string | null;
    state: string;
  }>(
    owner,
    `SELECT id, commit_sha, kind, parent_layer_id, state FROM codegraph.commit_layers
      WHERE repository_id = $1 ORDER BY staged_at, id`,
    [repositoryId],
  );
}

async function refHeads(repositoryId: string) {
  return await queryRows(
    owner,
    `SELECT ref_name, commit_sha, layer_id, is_default_branch FROM codegraph.ref_heads
      WHERE repository_id = $1 ORDER BY ref_name`,
    [repositoryId],
  );
}

async function resolved(tenant: QueueTenant, repositoryId: string, commit: string) {
  const resolution = await resolveCommit(owner, tenant.tenantId, repositoryId, commit);
  return resolution.state === 'indexed' ? resolution.paths : null;
}

const hashes = (tree: Tree) =>
  new Map(
    Object.entries(tree)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, contents]) => [path, gitBlobHash(Buffer.from(contents, 'utf8'))]),
  );

async function scratchEntries(): Promise<string[]> {
  return await readdir(scratch);
}

const TREE: Tree = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.py': 'def b():\n    return 2\n',
  'README.md': '# readme\n',
};

beforeAll(async () => {
  db = await freshDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  pool = createAppPool(db.appUrl);
  scratch = await mkdtemp(join(tmpdir(), 'worker-scratch-'));
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await rm(scratch, { recursive: true, force: true });
  await db.drop();
});

beforeEach(async () => {
  lines = [];
  // Each case owns a fresh tenant, so no job or layer of another case is claimable.
  await owner.query('DELETE FROM codegraph.index_jobs');
  t = await queueTenant(owner, 2);
});

describe('a first index of the default branch', () => {
  it('opens a base from the whole tree, publishes it with the ref, and leaves no scratch', async () => {
    const { claim, commit } = await enqueueAndClaim();
    const result = await runJob(deps(serve(TREE)), claim);
    expect(result).toEqual({ outcome: 'succeeded', storedBlobs: 3 });
    const [layer] = await layersOf(t.repositoryId);
    expect(layer).toMatchObject({
      commit_sha: commit,
      kind: 'base',
      parent_layer_id: null,
      state: 'published',
    });
    expect(await refHeads(t.repositoryId)).toEqual([
      {
        ref_name: 'refs/heads/main',
        commit_sha: commit,
        layer_id: layer?.id,
        is_default_branch: true,
      },
    ]);
    expect(await resolved(t, t.repositoryId, commit)).toEqual(hashes(TREE));
    expect(await job(claim.jobId)).toMatchObject({
      state: 'succeeded',
      fetch_url: null,
      failure_reason_code: null,
    });
    expect(await scratchEntries()).toEqual([]);
  });
});

describe('a push', () => {
  it('opens a delta over previousHead, storing only new blobs, whatever changed_paths says', async () => {
    const base = await enqueueAndClaim();
    await runJob(deps(serve(TREE)), base.claim);
    const [baseLayer] = await layersOf(t.repositoryId);

    const next: Tree = { ...TREE, 'src/b.py': 'def b():\n    return 3\n', 'src/c.ts': 'c;\n' };
    const push = await enqueueAndClaim({
      kind: 'push',
      previousHead: base.commit,
      changedPaths: ['no/such/path', 'README.md'],
    });
    const result = await runJob(deps(serve(next)), push.claim);
    expect(result).toEqual({ outcome: 'succeeded', storedBlobs: 2 });
    const delta = (await layersOf(t.repositoryId)).find((l) => l.commit_sha === push.commit);
    expect(delta).toMatchObject({
      kind: 'delta',
      parent_layer_id: baseLayer?.id,
      state: 'published',
    });
    expect(await resolved(t, t.repositoryId, push.commit)).toEqual(hashes(next));

    // The same commit tree pushed in the second repository with an empty
    // changed list resolves to the same map; every blob is already the tenant's.
    const again = await enqueueAndClaim({
      kind: 'push',
      repositoryId: t.repositoryIds[1] as string,
      previousHead: base.commit,
      changedPaths: [],
    });
    expect(await runJob(deps(serve(next)), again.claim)).toEqual({
      outcome: 'succeeded',
      storedBlobs: 0,
    });
    expect(await resolved(t, t.repositoryIds[1] as string, again.commit)).toEqual(hashes(next));
  });
});

describe('a job carrying no candidates', () => {
  it('is offered the repository’s published commits, so a branch’s first index is a delta over main', async () => {
    const main = await enqueueAndClaim();
    await runJob(deps(serve(TREE)), main.claim);
    const headsBefore = await refHeads(t.repositoryId);
    const [mainLayer] = await layersOf(t.repositoryId);

    const feature = await enqueueAndClaim({ ref: 'refs/heads/feature', isDefaultBranch: false });
    await runJob(deps(serve({ ...TREE, 'src/f.ts': 'f;\n' })), feature.claim);
    const layer = (await layersOf(t.repositoryId)).find((l) => l.commit_sha === feature.commit);
    expect(layer).toMatchObject({ kind: 'delta', parent_layer_id: mainLayer?.id });
    const heads = await refHeads(t.repositoryId);
    expect(heads.find((h) => h.ref_name === 'refs/heads/main')).toEqual(headsBefore[0]);
    expect(heads.find((h) => h.ref_name === 'refs/heads/feature')).toMatchObject({
      commit_sha: feature.commit,
      is_default_branch: false,
    });
  });

  it('reads the published commits newest first, capped at CANDIDATE_ANCESTOR_LIMIT', async () => {
    const commits: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await enqueueAndClaim({
        ref: `refs/heads/r${String(i)}`,
        isDefaultBranch: i === 0,
      });
      expect(
        await runJob(deps(serve({ ...TREE, [`f${String(i)}`]: String(i) })), run.claim),
        JSON.stringify(lines),
      ).toMatchObject({ outcome: 'succeeded' });
      commits.push(run.commit);
    }
    const listed = await inClaimTransaction(pool, t, (c) =>
      listCurrentPublishedCommits(c, t, CANDIDATE_ANCESTOR_LIMIT),
    );
    expect(listed).toEqual([...commits].reverse());
    expect(await inClaimTransaction(pool, t, (c) => listCurrentPublishedCommits(c, t, 1))).toEqual([
      commits[2],
    ]);
    await expect(
      inClaimTransaction(pool, t, (c) => listCurrentPublishedCommits(c, t, 0)),
    ).rejects.toThrow(RangeError);
  });
});

describe('a fetch refusal', () => {
  it.each(['not_https', 'address_refused', 'source_too_large', 'fetch_timeout'])(
    'ends the job failed with %s, opening no layer and moving no ref',
    async (reasonCode) => {
      const main = await enqueueAndClaim();
      await runJob(deps(serve(TREE)), main.claim);
      const headsBefore = await refHeads(t.repositoryId);
      const layersBefore = await layersOf(t.repositoryId);
      const blobsBefore = await queryRows(
        owner,
        'SELECT count(*)::int AS n FROM codegraph.blob WHERE tenant_id = $1',
        [t.tenantId],
      );

      const { claim } = await enqueueAndClaim();
      const refused: FetchStep = async ({ dir }) => {
        await writeFile(join(dir, 'partial'), 'x');
        return {
          ok: false,
          reasonCode,
          message: `The fetch was refused (${reasonCode}).`,
        };
      };
      expect(await runJob(deps(refused), claim)).toEqual({ outcome: 'failed', reasonCode });
      const row = await job(claim.jobId);
      expect(row).toMatchObject({
        state: 'failed',
        failure_reason_code: reasonCode,
        fetch_url: null,
      });
      expect(row?.failure_message).toBe(`The fetch was refused (${reasonCode}).`);
      expect(row?.ended_at).toBeInstanceOf(Date);
      expect(await layersOf(t.repositoryId)).toEqual(layersBefore);
      expect(await refHeads(t.repositoryId)).toEqual(headsBefore);
      expect(
        await queryRows(
          owner,
          'SELECT count(*)::int AS n FROM codegraph.blob WHERE tenant_id = $1',
          [t.tenantId],
        ),
      ).toEqual(blobsBefore);
      expect(await resolved(t, t.repositoryId, main.commit)).toEqual(hashes(TREE));
      expect(await scratchEntries()).toEqual([]);
    },
  );
});

describe('a lost lease', () => {
  it('stops before publish, moves no ref, and leaves the new claim’s row untouched', async () => {
    const { claim } = await enqueueAndClaim();
    const stolen: FetchStep = async (target) => {
      const answer = await serve(TREE)(target);
      // Another worker takes the row: its token replaces this claim's.
      await owner.query(
        "UPDATE codegraph.index_jobs SET claimed_by = 'other-claim' WHERE id = $1",
        [claim.jobId],
      );
      return answer;
    };
    expect(await runJob(deps(stolen), claim)).toEqual({ outcome: 'lease_lost' });
    expect((await layersOf(t.repositoryId)).filter((l) => l.state === 'published')).toEqual([]);
    expect(await refHeads(t.repositoryId)).toEqual([]);
    expect(await job(claim.jobId)).toMatchObject({
      state: 'running',
      claimed_by: 'other-claim',
      failure_reason_code: null,
    });
    expect(await scratchEntries()).toEqual([]);
    expect(lines.some((l) => l.message.includes('lease was lost'))).toBe(true);
  });

  it('answers lease_lost for a claim whose row was already taken before the run began', async () => {
    const { claim } = await enqueueAndClaim();
    await owner.query("UPDATE codegraph.index_jobs SET claimed_by = 'other-claim' WHERE id = $1", [
      claim.jobId,
    ]);
    expect(await runJob(deps(serve(TREE)), claim)).toEqual({ outcome: 'lease_lost' });
    expect(await job(claim.jobId)).toMatchObject({ state: 'running', claimed_by: 'other-claim' });
  });

  it('writes no outcome when the lease is lost as the job ends', async () => {
    const { claim } = await enqueueAndClaim();
    const refused: FetchStep = async () => {
      await owner.query(
        "UPDATE codegraph.index_jobs SET claimed_by = 'other-claim' WHERE id = $1",
        [claim.jobId],
      );
      return { ok: false, reasonCode: 'fetch_timeout', message: 'too slow' };
    };
    expect(await runJob(deps(refused), claim)).toEqual({ outcome: 'lease_lost' });
    expect(await job(claim.jobId)).toMatchObject({ state: 'running', failure_reason_code: null });
  });
});

describe('a lost grant', () => {
  it('ends the iteration logged, publishing and writing nothing', async () => {
    const { claim } = await enqueueAndClaim();
    // The shipped revoke, as an operator calls it.
    const operator = randomUUID();
    await owner.query(
      "INSERT INTO codegraph.clients (id, name, kind) VALUES ($1, 'op', 'operator')",
      [operator],
    );
    await asOperator(db.appUrl, operator, 'codegraph.codegraph_revoke_access($1, $2)', [
      t.clientId,
      t.tenantId,
    ]);
    expect(await runJob(deps(serve(TREE)), claim)).toEqual({ outcome: 'grant_lost' });
    expect(await layersOf(t.repositoryId)).toEqual([]);
    expect(await job(claim.jobId)).toMatchObject({ state: 'running', failure_reason_code: null });
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('no live grant'))).toBe(true);
    expect(await scratchEntries()).toEqual([]);
  });

  it('answers grant_lost when the grant goes mid-run, as the job is ended', async () => {
    const { claim } = await enqueueAndClaim();
    const revoking: FetchStep = async () => {
      await owner.query(
        'UPDATE codegraph.grants SET revoked_at = now() WHERE client_id = $1 AND tenant_id = $2',
        [t.clientId, t.tenantId],
      );
      return { ok: false, reasonCode: 'fetch_timeout', message: 'too slow' };
    };
    expect(await runJob(deps(revoking), claim)).toEqual({ outcome: 'grant_lost' });
    expect(await job(claim.jobId)).toMatchObject({ state: 'running' });
  });
});

describe('an error thrown out of the run', () => {
  it('ends the job internal_error with the fetch URL redacted from the message and the log', async () => {
    const { claim, commit } = await enqueueAndClaim();
    const url = fetchUrlFor(commit);
    const throwing: FetchStep = async ({ dir }) => {
      await writeFile(join(dir, 'half'), 'x');
      throw new Error(`socket hang up while reading ${url}`);
    };
    expect(await runJob(deps(throwing), claim)).toEqual({
      outcome: 'failed',
      reasonCode: 'internal_error',
    });
    const row = await job(claim.jobId);
    expect(row).toMatchObject({ state: 'failed', fetch_url: null });
    expect(row?.failure_message).toBe('socket hang up while reading [fetch-url]');
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.stringify(lines)).not.toContain('git.example');
    expect(await scratchEntries()).toEqual([]);
  });

  it('ends a kind with no runner internal_error, naming the kind', async () => {
    const { claim } = await enqueueAndClaim({ kind: 'push' });
    const runners = JOB_RUNNERS as Record<string, unknown>;
    const push = runners.push;
    runners.push = undefined;
    try {
      expect(await runJob(deps(serve(TREE)), claim)).toEqual({
        outcome: 'failed',
        reasonCode: 'internal_error',
      });
    } finally {
      runners.push = push;
    }
    expect((await job(claim.jobId))?.failure_message).toContain('job kind push');
  });

  it('hands a maintenance kind to its runner rather than the request path', async () => {
    await owner.query(
      `INSERT INTO codegraph.index_jobs (tenant_id, repository_id, client_id, kind)
       VALUES ($1, $2, $3, 'release')`,
      [t.tenantId, t.repositoryId, t.clientId],
    );
    const claim = (await claimNext(pool, settings())) as Claim;
    expect(JOB_RUNNERS.release).toBeUndefined();
    expect(await runJob(deps(serve(TREE)), claim)).toMatchObject({
      outcome: 'maintained',
      answer: { kind: 'release', result: { layerIds: [], blobHashes: [] } },
    });
    expect((await job(claim.jobId))?.state).toBe('succeeded');
  });

  it('maps the publish refusals to their reason codes', () => {
    expect(failureOf(new PublishUnboundError('t', 'c'))).toMatchObject({
      reasonCode: 'binding_refused',
    });
    expect(failureOf(new LayerNotPublishableError('not_found', 'l'))).toMatchObject({
      reasonCode: 'layer_unpublishable',
    });
    expect(failureOf('plain')).toEqual({ reasonCode: 'internal_error', message: 'plain' });
  });
});

describe('the secret stays out of every log line and recorded message', () => {
  it('logs no fetch URL across a success and a refusal', async () => {
    const ok = await enqueueAndClaim();
    await runJob(deps(serve(TREE)), ok.claim);
    const bad = await enqueueAndClaim();
    await runJob(
      deps(() => Promise.resolve({ ok: false, reasonCode: 'address_refused', message: 'refused' })),
      bad.claim,
    );
    expect(lines.length).toBeGreaterThan(2);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.stringify(lines)).not.toContain('git.example');
    const messages = await queryRows<{ m: string | null; u: string | null }>(
      owner,
      'SELECT failure_message AS m, fetch_url AS u FROM codegraph.index_jobs',
    );
    for (const { m, u } of messages) {
      expect(u).toBeNull();
      expect(m ?? '').not.toContain(SECRET);
    }
  });

  it('redacts the URL and its query string, longest first', () => {
    const url = 'https://h.example/a?sig=abc&x=1';
    expect(redactFetchUrl(`GET ${url} failed; sig=abc&x=1 rejected`, url)).toBe(
      'GET [fetch-url] failed; [fetch-url] rejected',
    );
    expect(redactFetchUrl('nothing here', null)).toBe('nothing here');
    expect(redactFetchUrl('raw not-a-url', 'not-a-url')).toBe('raw [fetch-url]');
  });
});

describe('the pre-layer checks', () => {
  it('run after the hash and before openLayer, and a refusal opens nothing', async () => {
    const { claim, commit } = await enqueueAndClaim({ isDefaultBranch: false, ref: 'dev' });
    const seen: unknown[] = [];
    const result = await runJob(
      deps(serve(TREE), {
        checks: [
          (input) => {
            seen.push(input);
            return { ok: true };
          },
          () => ({ ok: false, reasonCode: 'repository_too_large', message: 'Too many files.' }),
          () => {
            throw new Error('never reached');
          },
        ],
      }),
      claim,
    );
    expect(result).toEqual({ outcome: 'failed', reasonCode: 'repository_too_large' });
    expect(seen).toEqual([
      {
        tenantId: t.tenantId,
        repositoryId: t.repositoryId,
        commitSha: commit,
        refName: 'dev',
        isDefaultBranch: false,
        tree: {
          paths: hashes(TREE),
          sizes: expect.any(Map) as unknown,
          fileCount: 3,
          totalBytes: 51,
        },
      },
    ]);
    expect(await job(claim.jobId)).toMatchObject({
      failure_reason_code: 'repository_too_large',
      failure_message: 'Too many files.',
    });
    expect(await layersOf(t.repositoryId)).toEqual([]);
    expect(await scratchEntries()).toEqual([]);
  });

  it('pass with none registered', async () => {
    expect(PRE_LAYER_CHECKS).toEqual([]);
    expect(
      await runPreLayerChecks({
        tenantId: 't',
        repositoryId: 'r',
        commitSha: 'c',
        refName: 'main',
        isDefaultBranch: true,
        tree: { paths: new Map(), sizes: new Map(), fileCount: 0, totalBytes: 0 },
      }),
    ).toEqual({ ok: true });
  });
});

describe('storing in passes', () => {
  it('renews the lease between the first and the last pass of a store larger than one pass', async () => {
    // A run fans such a job out; the publish retry still stores in passes.
    const big: Tree = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${String(i)}.txt`, `file ${String(i)}\n`]),
    );
    const { claim, commit } = await enqueueAndClaim();
    const dir = scratchDirFor(settings(), claim.jobId);
    await mkdir(dir, { recursive: true });
    const fetched = await serve(big)({ url: '', dir });
    if (!fetched.ok) throw new Error('stub refused');
    const opened = await openLayer(pool, {
      clientId: t.clientId,
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      commitSha: commit,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
      candidateAncestors: [],
      paths: fetched.tree.paths,
      settings: { hardCeiling: DEFAULT_HARD_CEILING },
    });
    const recordingPool = createAppPool(db.appUrl);
    const recorded = recordQueries(recordingPool);
    try {
      const created = await storeMissingBlobs(
        { ...deps(serve(big)), pool: recordingPool, settings: settings({ blobStoreBatchSize: 2 }) },
        claim,
        opened,
        fetched.tree,
      );
      expect(created).toBe(5);
    } finally {
      await recordingPool.end();
      await rm(dir, { recursive: true, force: true });
    }
    const texts = recorded.texts();
    const stores = texts.flatMap((text, i) =>
      text.includes('INSERT INTO codegraph.blob') &&
      !text.includes('blob_contents') &&
      !text.includes('blob_fact')
        ? [i]
        : [],
    );
    const renewals = texts.flatMap((text, i) => (text.includes('SET lease_expires_at') ? [i] : []));
    expect(stores.length).toBeGreaterThanOrEqual(5);
    const first = stores[0] as number;
    const last = stores.at(-1) as number;
    expect(renewals.filter((i) => i > first && i < last).length).toBeGreaterThanOrEqual(2);
  });
});

describe('publishJobLayer', () => {
  it('stores what the layer lacks and publishes again; a second refusal is layer_unpublishable', async () => {
    const { claim, commit } = await enqueueAndClaim();
    const runDeps = deps(serve(TREE));
    const dir = scratchDirFor(runDeps.settings, claim.jobId);
    await mkdir(dir, { recursive: true });
    const outcome = await serve(TREE)({ url: '', dir });
    if (!outcome.ok) throw new Error('stub refused');
    const opened = await openLayer(pool, {
      clientId: t.clientId,
      tenantId: t.tenantId,
      repositoryId: t.repositoryId,
      commitSha: commit,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
      candidateAncestors: [],
      paths: outcome.tree.paths,
      settings: { hardCeiling: DEFAULT_HARD_CEILING },
    });
    const claimed = {
      commitSha: commit,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
    } as Parameters<typeof publishJobLayer>[2];

    // Nothing stored yet: the first publish is refused, the retry stores and publishes.
    const done = await publishJobLayer(runDeps, claim, claimed, opened, outcome.tree);
    expect(done.storedOnRetry).toBe(3);
    expect(done.published.commitSha).toBe(commit);

    // A second job whose layer names a blob nothing will store.
    const second = await enqueueAndClaim({ repositoryId: t.repositoryIds[1] as string });
    const lone = new Map([['x.txt', gitBlobHash(Buffer.from('never stored'))]]);
    const unstorable = await openLayer(pool, {
      clientId: t.clientId,
      tenantId: t.tenantId,
      repositoryId: t.repositoryIds[1] as string,
      commitSha: second.commit,
      refName: 'refs/heads/main',
      isDefaultBranch: true,
      candidateAncestors: [],
      paths: lone,
      settings: { hardCeiling: DEFAULT_HARD_CEILING },
    });
    await expect(
      publishJobLayer(runDeps, second.claim, claimed, { ...unstorable, entries: [] }, outcome.tree),
    ).rejects.toMatchObject({ name: 'JobFailure', reasonCode: 'layer_unpublishable' });
    await rm(dir, { recursive: true, force: true });
  });
});

describe('renewLease', () => {
  it('extends this claim’s lease and answers false for another token', async () => {
    const { claim } = await enqueueAndClaim();
    const scope = { tenantId: claim.tenantId, repositoryId: claim.repositoryId };
    expect(
      await inClaimTransaction(pool, claim, (c) =>
        renewLease(c, scope, claim.jobId, claim.claimedBy, 1000),
      ),
    ).toBe(true);
    expect(
      await inClaimTransaction(pool, claim, (c) => renewLease(c, scope, claim.jobId, 'nope', 1000)),
    ).toBe(false);
  });
});
