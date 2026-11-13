import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFetchSettings, readLayerSettings, type WorkerSettings } from '../../src/config.js';
import { endJob, enqueueJob, type JobKind } from '../../src/db/indexJobs.js';
import { claimNext, inClaimTransaction, type Claim } from '../../src/db/workerJobs.js';
import { fetchTree, FetchRefusedError } from '../../src/fetch/fetchTree.js';
import { resolveCommit } from '../../src/layers/resolution.js';
import { BIND_CLIENT_SQL, BIND_TENANT_SQL } from '../../src/server/binding.js';
import { createAppPool } from '../../src/server/pool.js';
import type { PreLayerCheck } from '../../src/worker/preLayerCheck.js';
import {
  runJob,
  type FetchStep,
  type RunJobDeps,
  type RunResult,
} from '../../src/worker/runJob.js';
import { freshDatabase, queryRows, withClient, type FreshDatabase } from '../helpers/db.js';
import { sha } from '../helpers/queue.js';
import { treeTarball } from '../helpers/tarball.js';
import { startTarballServer, type TarballServer } from '../helpers/tarballServer.js';
import { asOperator, buildTenancyFixture, type TenancyFixture } from '../helpers/tenancy.js';

// The assembled write path, each card's door feeding the next one's input, on
// a real Postgres with two tenants: the enqueue (src/db/indexJobs.ts) → the
// claim (codegraph_claim_index_job, nothing bound) → one job run by
// src/worker/runJob.ts through the real fetcher against the https tarball
// fixture → the layer it publishes → resolveCommit bound to the job's tenant.
// Nothing is mocked. The two tenants, and the commit deliberately published in
// the tenant that does not own the job, ARE the test: a single-tenant fixture
// would pass every case here while proving nothing.

type Tree = Record<string, string>;

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const REF = 'refs/heads/main';

/** A git blob id, computed here rather than by the code under test. */
const blobId = (contents: string) => {
  const bytes = Buffer.from(contents, 'utf8');
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
};
const mapOf = (tree: Tree) =>
  new Map(Object.entries(tree).map(([path, contents]) => [path, blobId(contents)]));

const TREE_A1: Tree = {
  'src/index.ts': 'export const answer = 42;\n',
  'src/util.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'docs/guide.md': '# guide\n',
  'README.md': '# acme web\n',
};
const TREE_X: Tree = { 'lib/x.ts': 'export const x = 1;\n', 'README.md': '# acme api\n' };
const TREE_Y: Tree = { 'lib/y.ts': 'export const y = 2;\n', 'README.md': '# globex core\n' };

let server: TarballServer;
let scratch: string;

beforeAll(async () => {
  server = await startTarballServer({ originHost: '127.0.0.1' });
  scratch = await mkdtemp(join(tmpdir(), 'index-queue-gate-'));
});

afterAll(async () => {
  await server.close();
  await rm(scratch, { recursive: true, force: true });
});

/** The real fetcher, trusting the fixture's certificate and allowed its loopback host. */
const realFetch: FetchStep = async (target) => {
  try {
    const tree = await fetchTree(target, {
      settings: readFetchSettings({ FETCH_ALLOWED_HOSTS: new URL(server.origin).hostname }),
      tls: { ca: server.ca },
    });
    return { ok: true, tree };
  } catch (error) {
    if (error instanceof FetchRefusedError) {
      return { ok: false, reasonCode: error.reasonCode, message: error.message };
    }
    throw error;
  }
};

function workerSettings(): WorkerSettings {
  return {
    pollMs: 10,
    jobLeaseMs: LEASE_MS,
    maxAttempts: MAX_ATTEMPTS,
    scratchDir: scratch,
    // Above every tree here, so each job runs in one pass and never fans out.
    blobStoreBatchSize: 1_000,
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** One two-tenant world on a database of its own. */
interface World {
  db: FreshDatabase;
  owner: pg.Client;
  pool: pg.Pool;
  fx: TenancyFixture;
  /** A client granted tenant B only. */
  bClient: string;
  a: { tenantId: string; r0: string; r1: string };
  b: { tenantId: string; r0: string };
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const db = await freshDatabase();
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  const pool = createAppPool(db.appUrl);
  const fx = await buildTenancyFixture({ ownerUrl: db.ownerUrl, appUrl: db.appUrl });
  const bClient = (await asOperator<string>(
    db.appUrl,
    fx.operatorId,
    'codegraph.codegraph_create_client($1, $2)',
    ['globex-indexer', 'client'],
  )) as string;
  await asOperator(db.appUrl, fx.operatorId, 'codegraph.codegraph_grant_access($1, $2)', [
    bClient,
    fx.tenantB.id,
  ]);
  return {
    db,
    owner,
    pool,
    fx,
    bClient,
    a: {
      tenantId: fx.tenantA.id,
      r0: fx.tenantA.repositories[0]?.id as string,
      r1: fx.tenantA.repositories[1]?.id as string,
    },
    b: { tenantId: fx.tenantB.id, r0: fx.tenantB.repositories[0]?.id as string },
    async close() {
      await pool.end();
      await owner.end();
      await db.drop();
    },
  };
}

interface Enqueue {
  tenantId: string;
  repositoryId: string;
  clientId: string;
  kind?: JobKind;
  commit?: string | null;
  candidateAncestors?: string[];
  fetchUrl?: string | null;
}

/** Commits one job through src/db/indexJobs.ts in a transaction bound to its tenant. */
async function enqueue(w: World, spec: Enqueue): Promise<{ jobId: string; commit: string | null }> {
  const kind = spec.kind ?? 'first_index';
  const request = kind === 'first_index' || kind === 'push' || kind === 'refresh';
  const commit = spec.commit === undefined ? sha() : spec.commit;
  const c = await w.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [spec.clientId, spec.tenantId]);
    const job = await enqueueJob(c, {
      tenantId: spec.tenantId,
      repositoryId: spec.repositoryId,
      clientId: spec.clientId,
      kind,
      commitSha: commit,
      refName: request ? REF : null,
      isDefaultBranch: request,
      candidateAncestors: spec.candidateAncestors ?? [],
      fetchUrl: request ? (spec.fetchUrl ?? 'https://git.example/never-fetched.tar.gz') : null,
    });
    await c.query('COMMIT');
    return { jobId: job.id, commit };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

const claim = (pool: pg.Pool) =>
  claimNext(pool, { jobLeaseMs: LEASE_MS, maxAttempts: MAX_ATTEMPTS });

async function jobRow(w: World, id: string) {
  const [row] = await queryRows<{
    state: string;
    fetch_url: string | null;
    failure_reason_code: string | null;
    failure_message: string | null;
    lease_expires_at: Date | null;
    claimed_by: string | null;
  }>(
    w.owner,
    `SELECT state, fetch_url, failure_reason_code, failure_message, lease_expires_at, claimed_by
       FROM codegraph.index_jobs WHERE id = $1`,
    [id],
  );
  return row;
}

function deps(w: World, overrides: Partial<RunJobDeps> = {}): RunJobDeps {
  return {
    pool: w.pool,
    settings: workerSettings(),
    layerSettings: readLayerSettings({}),
    fetch: realFetch,
    log: quiet,
    ...overrides,
  };
}

/** Serves `tree` as a commit's tarball, wrapped in one top-level directory. */
const serveTree = (tree: Tree, commit: string) =>
  server.commit('gate', commit, treeTarball(tree, `gate-${commit}`));

/** Enqueues, claims and runs one request job through the real fetcher. */
async function index(
  w: World,
  spec: Omit<Enqueue, 'fetchUrl' | 'commit'> & { tree: Tree; commit?: string },
  overrides: Partial<RunJobDeps> = {},
): Promise<{ jobId: string; commit: string; result: RunResult }> {
  const commit = spec.commit ?? sha();
  const { jobId } = await enqueue(w, { ...spec, commit, fetchUrl: serveTree(spec.tree, commit) });
  const claimed = await claim(w.pool);
  expect(claimed?.jobId).toBe(jobId);
  const result = await runJob(deps(w, overrides), claimed as Claim);
  return { jobId, commit, result };
}

async function resolvedMap(
  w: World,
  tenantId: string,
  clientId: string,
  repo: string,
  commit: string,
) {
  const c = await w.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(BIND_TENANT_SQL, [clientId, tenantId]);
    return await resolveCommit(c, tenantId, repo, commit);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Every base table of schema codegraph that carries a tenant id, from the catalogue. */
async function tenantTables(owner: pg.Client): Promise<string[]> {
  const rows = await queryRows<{ table_name: string }>(
    owner,
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'codegraph' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY 1`,
  );
  return rows.map((r) => r.table_name);
}

/** Per table: the number of the tenant's rows and an md5 over them in row-text order. */
async function digest(owner: pg.Client, tenantId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of await tenantTables(owner)) {
    const [row] = await queryRows<{ n: number; md5: string | null }>(
      owner,
      `SELECT count(*)::int AS n, md5(string_agg(t::text, E'\\n' ORDER BY t::text)) AS md5
         FROM codegraph.${owner.escapeIdentifier(table)} t WHERE tenant_id = $1`,
      [tenantId],
    );
    out[table] = `${String(row?.n)}:${String(row?.md5)}`;
  }
  return out;
}

/** Every row of every tenant table, as text, keyed by table. */
async function allRows(owner: pg.Client): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const table of await tenantTables(owner)) {
    const rows = await queryRows<{ row: string }>(
      owner,
      `SELECT to_jsonb(t)::text AS row FROM codegraph.${owner.escapeIdentifier(table)} t`,
    );
    out.set(table, new Set(rows.map((r) => r.row)));
  }
  return out;
}

async function blobCount(owner: pg.Client, tenantId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    owner,
    'SELECT count(*)::int AS n FROM codegraph.blob WHERE tenant_id = $1',
    [tenantId],
  );
  return row?.n ?? 0;
}

async function layerCount(owner: pg.Client, commit: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    owner,
    'SELECT count(*)::int AS n FROM codegraph.commit_layers WHERE commit_sha = $1',
    [commit],
  );
  return row?.n ?? 0;
}

describe('enqueue → claim', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });

  afterAll(async () => {
    await w.close();
  });

  it('a job committed bound to its tenant is answered by the claim on a connection with nothing bound', async () => {
    const { jobId } = await enqueue(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r0,
      clientId: w.fx.readerId,
    });
    const answered = await withClient(w.db.appUrl, async (c) => {
      const [bound] = await queryRows<{ tenant: string | null; client: string | null }>(
        c,
        `SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant,
                NULLIF(current_setting('app.client_id', true), '') AS client`,
      );
      expect(bound).toEqual({ tenant: null, client: null });
      return await queryRows(c, 'SELECT * FROM codegraph.codegraph_claim_index_job($1, $2)', [
        LEASE_MS,
        MAX_ATTEMPTS,
      ]);
    });
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      claim_kind: 'job',
      tenant_id: w.a.tenantId,
      repository_id: w.a.r0,
      client_id: w.fx.readerId,
      job_id: jobId,
      batch_id: null,
    });
    const row = await jobRow(w, jobId);
    expect(row?.state).toBe('running');
    expect(row?.lease_expires_at).not.toBeNull();
    expect(row?.claimed_by).toBe((answered[0] as { claimed_by: string }).claimed_by);
  });

  it('runs tenants in parallel, one job per repository, and strands no queued job', async () => {
    await w.owner.query('DELETE FROM codegraph.index_jobs');
    const bJob = await enqueue(w, {
      tenantId: w.b.tenantId,
      repositoryId: w.b.r0,
      clientId: w.bClient,
    });
    const a1 = await enqueue(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r0,
      clientId: w.fx.readerId,
    });
    const a2 = await enqueue(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r0,
      clientId: w.fx.readerId,
    });
    const a3 = await enqueue(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r1,
      clientId: w.fx.readerId,
    });

    // Two claims live at the same moment, on two connections of their own.
    const second = createAppPool(w.db.appUrl);
    try {
      const [one, two] = await Promise.all([claim(w.pool), claim(second)]);
      const live = [one, two].map((c) => (c as Claim).jobId).sort();
      expect(live).toEqual([bJob.jobId, a1.jobId].sort());
      expect(new Set([one, two].map((c) => (c as Claim).repositoryId))).toEqual(
        new Set([w.b.r0, w.a.r0]),
      );
      expect(new Set([one, two].map((c) => (c as Claim).tenantId))).toEqual(
        new Set([w.a.tenantId, w.b.tenantId]),
      );

      const third = await claim(w.pool);
      expect(third?.jobId).toBe(a3.jobId);
      expect(await claim(w.pool)).toBeNull(); // a2's repository is running a1

      const running = [one, two].find((c) => c?.jobId === a1.jobId) as Claim;
      await inClaimTransaction(w.pool, running, (c) =>
        endJob(
          c,
          { tenantId: running.tenantId, repositoryId: running.repositoryId },
          running.jobId,
          running.claimedBy,
          {
            state: 'succeeded',
          },
        ),
      );
      expect((await claim(w.pool))?.jobId).toBe(a2.jobId);
    } finally {
      await second.end();
    }
  });
});

describe('run → publish → resolve, and the tenant boundary while jobs flow', () => {
  let w: World;
  const commits = { a1: sha(), x: sha(), y: sha() };
  let aBefore: Record<string, string>;
  let rowsBefore: Map<string, Set<string>>;

  beforeAll(async () => {
    w = await world();
  });

  afterAll(async () => {
    await w.close();
  });

  it('a claimed job run by the worker ends succeeded and resolves to exactly the tarball’s map', async () => {
    const { jobId, result } = await index(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r0,
      clientId: w.fx.readerId,
      tree: TREE_A1,
      commit: commits.a1,
    });
    expect(result.outcome).toBe('succeeded');
    const row = await jobRow(w, jobId);
    expect(row?.state).toBe('succeeded');
    expect(row?.fetch_url).toBeNull();
    const resolution = await resolvedMap(w, w.a.tenantId, w.fx.readerId, w.a.r0, commits.a1);
    expect(resolution.state).toBe('indexed');
    expect(resolution.state === 'indexed' ? resolution.paths : null).toEqual(mapOf(TREE_A1));
    expect(await readdir(scratch)).toEqual([]);
  });

  it('tenant A publishes commit X in its other repository, and every A table is digested', async () => {
    const { result } = await index(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r1,
      clientId: w.fx.readerId,
      tree: TREE_X,
      commit: commits.x,
    });
    expect(result.outcome).toBe('succeeded');
    aBefore = await digest(w.owner, w.a.tenantId);
    // A holds rows for BOTH its repositories in the layer tables and its blobs.
    const repos = await queryRows<{ repository_id: string }>(
      w.owner,
      'SELECT DISTINCT repository_id FROM codegraph.commit_layers WHERE tenant_id = $1',
      [w.a.tenantId],
    );
    expect(repos.map((r) => r.repository_id).sort()).toEqual([w.a.r0, w.a.r1].sort());
    for (const table of ['commit_layers', 'layer_paths', 'ref_heads', 'blob', 'index_jobs']) {
      expect(aBefore[table], table).not.toMatch(/^0:/);
    }
    rowsBefore = await allRows(w.owner);
  });

  it('B’s job naming A’s commit X as its only ancestor publishes a base, and writes only B rows', async () => {
    expect(await layerCount(w.owner, commits.x)).toBe(1); // X is indexed in A only
    const { result } = await index(w, {
      tenantId: w.b.tenantId,
      repositoryId: w.b.r0,
      clientId: w.bClient,
      kind: 'push',
      candidateAncestors: [commits.x],
      tree: TREE_Y,
      commit: commits.y,
    });
    expect(result.outcome).toBe('succeeded');
    const [layer] = await queryRows<{ kind: string; parent_layer_id: string | null }>(
      w.owner,
      `SELECT kind, parent_layer_id FROM codegraph.commit_layers
        WHERE tenant_id = $1 AND commit_sha = $2 AND state = 'published'`,
      [w.b.tenantId, commits.y],
    );
    expect(layer).toEqual({ kind: 'base', parent_layer_id: null });

    const after = await allRows(w.owner);
    let written = 0;
    for (const [table, rows] of after) {
      for (const text of rows) {
        if (rowsBefore.get(table)?.has(text) === true) continue;
        const row = JSON.parse(text) as { tenant_id: string; repository_id?: string };
        written += 1;
        expect(row.tenant_id, `${table} ${text}`).toBe(w.b.tenantId);
        if ('repository_id' in row) expect(row.repository_id, table).toBe(w.b.r0);
      }
    }
    expect(written).toBeGreaterThan(0);
    for (const table of ['commit_layers', 'layer_paths', 'ref_heads', 'blob']) {
      expect(
        [...(after.get(table) ?? [])].some((r) => r.includes(w.b.tenantId)),
        table,
      ).toBe(true);
    }
  });

  it('leaves every A table byte-for-byte as it was, and a session bound to A sees and changes none of B’s queue', async () => {
    expect(await digest(w.owner, w.a.tenantId)).toEqual(aBefore);

    // Give B a batch row too, so the attempts below have one to aim at.
    const [bJob] = await queryRows<{ id: string }>(
      w.owner,
      'SELECT id FROM codegraph.index_jobs WHERE tenant_id = $1',
      [w.b.tenantId],
    );
    await w.owner.query(
      `INSERT INTO codegraph.index_job_batches (tenant_id, repository_id, job_id, ordinal, paths, git_blob_hashes)
       VALUES ($1, $2, $3, 1, ARRAY['p'], ARRAY[$4])`,
      [w.b.tenantId, w.b.r0, bJob?.id, sha()],
    );
    const bRows = await queryRows<{ id: string }>(
      w.owner,
      `SELECT id FROM codegraph.index_jobs WHERE tenant_id = $1
       UNION ALL SELECT id FROM codegraph.index_job_batches WHERE tenant_id = $1`,
      [w.b.tenantId],
    );
    const bIds = bRows.map((r) => r.id);
    expect(bIds.length).toBeGreaterThanOrEqual(2);

    await withClient(w.db.appUrl, async (c) => {
      await c.query('BEGIN');
      await c.query(BIND_TENANT_SQL, [w.fx.readerId, w.a.tenantId]);
      const seen = await queryRows<{ tenant_id: string }>(
        c,
        'SELECT tenant_id FROM codegraph.index_jobs',
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map((r) => r.tenant_id))).toEqual(new Set([w.a.tenantId]));
      for (const table of ['index_jobs', 'index_job_batches']) {
        expect(
          await queryRows(c, `SELECT id FROM codegraph.${table} WHERE id = ANY($1::uuid[])`, [
            bIds,
          ]),
        ).toEqual([]);
        expect(
          (
            await c.query(
              `UPDATE codegraph.${table} SET failure_message = NULL WHERE id = ANY($1::uuid[])`,
              [bIds],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (await c.query(`DELETE FROM codegraph.${table} WHERE id = ANY($1::uuid[])`, [bIds]))
            .rowCount,
        ).toBe(0);
      }
      await c.query('SAVEPOINT forge');
      await expect(
        c.query(
          `INSERT INTO codegraph.index_jobs (tenant_id, repository_id, client_id, kind)
           VALUES ($1, $2, $3, 'discard_stale')`,
          [w.b.tenantId, w.b.r0, w.fx.readerId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    expect(
      (
        await queryRows(
          w.owner,
          'SELECT id FROM codegraph.index_job_batches WHERE tenant_id = $1',
          [w.b.tenantId],
        )
      ).length,
    ).toBe(1);
  });
});

describe('the refusals', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });

  afterAll(async () => {
    await w.close();
  });

  it('a job whose client lost its grant before the claim ends binding_refused and publishes nothing', async () => {
    const previous = await index(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r0,
      clientId: w.fx.readerId,
      tree: TREE_A1,
    });
    expect(previous.result.outcome).toBe('succeeded');
    const blobsBefore = await blobCount(w.owner, w.a.tenantId);

    const next = sha();
    const { jobId } = await enqueue(w, {
      tenantId: w.a.tenantId,
      repositoryId: w.a.r0,
      clientId: w.fx.readerId,
      kind: 'push',
      commit: next,
      candidateAncestors: [previous.commit],
      fetchUrl: serveTree({ ...TREE_A1, 'src/new.ts': 'export const n = 1;\n' }, next),
    });
    await asOperator(w.db.appUrl, w.fx.operatorId, 'codegraph.codegraph_revoke_access($1, $2)', [
      w.fx.readerId,
      w.a.tenantId,
    ]);

    // The claim reaches the job, finds no live grant, and ends it rather than handing it out.
    const claimed = await claim(w.pool);
    if (claimed !== null) {
      expect(claimed.jobId).toBe(jobId);
      await runJob(deps(w), claimed);
    }
    const row = await jobRow(w, jobId);
    expect(row?.state).toBe('failed');
    expect(row?.failure_reason_code).toBe('binding_refused');
    expect(row?.fetch_url).toBeNull();
    expect(await layerCount(w.owner, next)).toBe(0);
    expect(await blobCount(w.owner, w.a.tenantId)).toBe(blobsBefore);
    // The ref still names the previous commit, which still resolves.
    const [head] = await queryRows<{ commit_sha: string }>(
      w.owner,
      `SELECT l.commit_sha FROM codegraph.ref_heads h
         JOIN codegraph.commit_layers l ON l.id = h.layer_id
        WHERE h.tenant_id = $1 AND h.repository_id = $2 AND h.ref_name = $3`,
      [w.a.tenantId, w.a.r0, REF],
    );
    expect(head?.commit_sha).toBe(previous.commit);
    const still = await resolveCommit(w.owner, w.a.tenantId, w.a.r0, previous.commit);
    expect(still.state).toBe('indexed');
  });

  it('a supplied pre-layer check that refuses ends the job with its code, before any layer or blob', async () => {
    const refusing: PreLayerCheck = () => ({
      ok: false,
      reasonCode: 'gate_refused',
      message: 'The gate refuses this tree.',
    });
    const blobsBefore = await blobCount(w.owner, w.b.tenantId);
    const { jobId, commit, result } = await index(
      w,
      { tenantId: w.b.tenantId, repositoryId: w.b.r0, clientId: w.bClient, tree: TREE_Y },
      { checks: [refusing] },
    );
    expect(result).toEqual({ outcome: 'failed', reasonCode: 'gate_refused' });
    const row = await jobRow(w, jobId);
    expect(row?.state).toBe('failed');
    expect(row?.failure_reason_code).toBe('gate_refused');
    expect(await layerCount(w.owner, commit)).toBe(0);
    expect(await blobCount(w.owner, w.b.tenantId)).toBe(blobsBefore);
  });
});

describe('the cross-tenant read guard', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });

  afterAll(async () => {
    await w.close();
  });

  it('the SECURITY DEFINER functions that name the queue tables are exactly the claim and the metrics counter', async () => {
    const rows = await queryRows<{ proname: string }>(
      w.owner,
      `SELECT p.proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'codegraph' AND p.prosecdef
          AND p.prosrc ~ '\\m(index_jobs|index_job_batches)\\M'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'codegraph_claim_index_job',
      'codegraph_index_queue_metrics',
    ]);
  });
});

/**
 * The pool, with every statement its connections run probed first on the
 * database itself: which tenant and client the session has bound at that
 * moment. `set_config(..., true)` is transaction-local, so a statement that
 * sees the binding is inside a bound transaction.
 */
function probedPool(url: string) {
  const pool = createAppPool(url);
  const probes: { text: string; tenant: string; client: string }[] = [];
  const unprobed: string[] = [];
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const wrapped = new WeakSet<pg.PoolClient>();
  const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
  (pool as { connect: unknown }).connect = async (...args: unknown[]) => {
    if (args.length > 0) throw new Error('the probed pool takes no callback');
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const raw = client.query.bind(client) as (...a: unknown[]) => Promise<pg.QueryResult>;
      (client as { query: unknown }).query = async (...a: unknown[]) => {
        const text = typeof a[0] === 'string' ? a[0] : String((a[0] as { text?: string }).text);
        if (typeof a[a.length - 1] === 'function') {
          unprobed.push(text);
          return raw(...a);
        }
        if (!CONTROL.test(text) && text !== BIND_TENANT_SQL && text !== BIND_CLIENT_SQL) {
          const { rows } = await raw(
            `SELECT current_setting('app.tenant_id', true) AS tenant,
                    current_setting('app.client_id', true) AS client`,
          );
          const bound = rows[0] as { tenant: string | null; client: string | null };
          probes.push({ text, tenant: bound.tenant ?? '', client: bound.client ?? '' });
        }
        return raw(...a);
      };
    }
    return client;
  };
  return { pool, probes, unprobed };
}

describe('maintenance through the queue', () => {
  let w: World;
  let probed: ReturnType<typeof probedPool>;
  let published: string;

  beforeAll(async () => {
    w = await world();
    probed = probedPool(w.db.appUrl);
    published = (
      await index(w, {
        tenantId: w.a.tenantId,
        repositoryId: w.a.r0,
        clientId: w.fx.readerId,
        tree: TREE_A1,
      })
    ).commit;
  });

  afterAll(async () => {
    await probed.pool.end();
    await w.close();
  });

  it('runs each of the three kinds to an end, and never as an unhandled kind', async () => {
    for (const kind of ['compact', 'discard_stale', 'release'] as const) {
      const { jobId } = await enqueue(w, {
        tenantId: w.a.tenantId,
        repositoryId: w.a.r0,
        clientId: w.fx.readerId,
        kind,
        commit: kind === 'compact' ? published : null,
      });
      const claimed = await claim(w.pool);
      expect(claimed?.jobId, kind).toBe(jobId);
      const result = await runJob(deps(w, { pool: probed.pool }), claimed as Claim);
      const row = await jobRow(w, jobId);
      expect(['succeeded', 'failed'], kind).toContain(row?.state);
      expect(row?.failure_message ?? '', kind).not.toMatch(/No runner is registered/);
      expect(row?.failure_reason_code, kind).not.toBe('internal_error');
      expect(result.outcome, kind).not.toBe('lease_lost');
    }
  });

  it('issued every statement of those runs inside a transaction bound to the job’s tenant, observed on the database', () => {
    expect(probed.unprobed).toEqual([]);
    expect(probed.probes.length).toBeGreaterThan(0);
    const outside = probed.probes.filter(
      (p) => p.tenant !== w.a.tenantId || p.client !== w.fx.readerId,
    );
    expect(outside, outside.map((p) => p.text).join('\n')).toEqual([]);
  });
});
