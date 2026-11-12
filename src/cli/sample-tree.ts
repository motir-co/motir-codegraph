// `pnpm fixture:sample-tree <mode> [flags]`: drive the indexing library over
// the bundled sample tree, the way an indexer worker will, and print what it
// stored. Three modes:
//
//   store      --tenant <id> --client <id> --repository <id> [--tree <dir>]
//              Stores every file of the tree for the tenant, in sorted path
//              order, as codegraph_app (DATABASE_APP_URL), and prints one line
//              per file, then one summary line of what the tenant sees.
//   show       --tenant <id> --client <id> --path <path> [--tree <dir>]
//              Prints one file's stored outcome, its fact rows and its stored
//              contents, read under the same binding.
//   reextract  --language <id>
//              Runs the shipped re-extraction for one language on the owner
//              login (DATABASE_URL) and prints what it moved, batch by batch.
//              It takes no client and no tenant: the sweep binds nothing and
//              reaches every tenant, and refuses any other login.
//
// The store and show modes refuse, before writing or reading anything, a
// client that holds no live grant on the tenant: a tenant id alone binds
// nothing (docs/schema-contract.md §4).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import pg from 'pg';

import { requireEnv } from '../config.js';
import { reextractLanguage } from '../indexing/reextract.js';
import { storeBlob, type StoredBlob } from '../indexing/storeBlob.js';
import { BIND_TENANT_SQL } from '../server/binding.js';

/** The bundled tree, resolved from this module so any working directory works. */
const DEFAULT_TREE = fileURLToPath(new URL('../../fixtures/sample-tree/', import.meta.url));

const USAGE = `usage: pnpm fixture:sample-tree <mode> [flags]

modes:
  store      --tenant <id> --client <id> --repository <id> [--tree <dir>]
  show       --tenant <id> --client <id> --path <path> [--tree <dir>]
  reextract  --language <id>

  --tree defaults to the bundled fixtures/sample-tree.
  store and show connect as DATABASE_APP_URL; reextract as DATABASE_URL.
  -h, --help prints this text.`;

class UsageError extends Error {}

/** Every file under `root`, as a `/`-separated path relative to it, sorted. */
function walk(root: string): string[] {
  const entries = readdirSync(root, { recursive: true, encoding: 'utf8' });
  return entries
    .filter((entry) => statSync(join(root, entry)).isFile())
    .map((entry) => entry.split(sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `git hash-object`: SHA-1 over `blob <length>\0` and the bytes. */
function gitBlobHash(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

function required(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`--${name} is required.`);
  }
  return value;
}

const field = (value: string | number | boolean | null): string =>
  value === null ? '-' : String(value);

/** One stored file, as one line: path, hash, outcome, size, then the outcome's own fields. */
function storedLine(path: string, hash: string, stored: StoredBlob): string {
  return [
    path,
    hash,
    stored.outcome,
    `size=${String(stored.sizeBytes)}`,
    `already=${String(stored.alreadyStored)}`,
    `parsedWithErrors=${field(stored.parsedWithErrors)}`,
    `lossy=${field(stored.lossy)}`,
    `refusedCapBytes=${field(stored.refusedCapBytes)}`,
    `language=${field(stored.language)}`,
    `extractorVersion=${field(stored.extractorVersion)}`,
  ].join(' ');
}

/**
 * Opens a transaction bound to the tenant and client exactly as `storeBlob`
 * binds its own, and fails, naming both, when the policy resolves no tenant
 * from them: the client holds no live grant on it.
 */
async function bind(client: pg.Client, tenantId: string, clientId: string): Promise<void> {
  await client.query('BEGIN');
  await client.query(BIND_TENANT_SQL, [clientId, tenantId]);
  const bound = await client.query<{ tenant: string | null }>(
    'SELECT codegraph.codegraph_bound_tenant() AS tenant',
  );
  const tenant = bound.rows[0]?.tenant;
  if (tenant === undefined || tenant === null) {
    await client.query('ROLLBACK');
    throw new UsageError(
      `Cannot bind tenant ${tenantId} for client ${clientId}: the client holds no live grant on it.`,
    );
  }
}

async function withApp<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: requireEnv('DATABASE_APP_URL') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function store(values: Record<string, unknown>): Promise<void> {
  const tenantId = required(values, 'tenant');
  const clientId = required(values, 'client');
  const repositoryId = required(values, 'repository');
  const tree = typeof values.tree === 'string' ? values.tree : DEFAULT_TREE;
  const paths = walk(tree);
  await withApp(async (client) => {
    // Refuse an unbindable client before the first store writes anything.
    await bind(client, tenantId, clientId);
    await client.query('ROLLBACK');
    for (const path of paths) {
      const bytes = readFileSync(join(tree, path));
      const gitHash = gitBlobHash(bytes);
      // The repository is the worker's argument, not a column: blobs are
      // tenant-scoped, so it is printed and never written.
      const stored = await storeBlob(client, {
        tenantId,
        clientId,
        gitBlobHash: gitHash,
        path,
        bytes,
      });
      console.log(storedLine(path, gitHash, stored));
    }
    await bind(client, tenantId, clientId);
    const counts = await client.query<{ blobs: number; contents: number; facts: number }>(
      `SELECT (SELECT count(*)::int FROM codegraph.blob) AS blobs,
              (SELECT count(*)::int FROM codegraph.blob_contents) AS contents,
              (SELECT count(*)::int FROM codegraph.blob_fact) AS facts`,
    );
    await client.query('COMMIT');
    const row = counts.rows[0];
    console.log(
      `summary tenant=${tenantId} repository=${repositoryId} files=${String(paths.length)} ` +
        `blobs=${field(row?.blobs ?? null)} contents=${field(row?.contents ?? null)} ` +
        `facts=${field(row?.facts ?? null)}`,
    );
  });
}

interface FactRow {
  kind: string;
  name: string | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  language: string;
  producer: string;
  extractor_version: string;
  definition_kind: string | null;
  reference_kind: string | null;
  module_specifier: string | null;
  imported_names: string[] | null;
  parent_name: string | null;
  relation: string | null;
}

function factLine(fact: FactRow): string {
  const range =
    fact.start_line === null
      ? '-'
      : `${String(fact.start_line)}:${field(fact.start_column)}-${field(fact.end_line)}:${field(fact.end_column)}`;
  const detail =
    fact.kind === 'definition'
      ? `definitionKind=${field(fact.definition_kind)}`
      : fact.kind === 'reference'
        ? `referenceKind=${field(fact.reference_kind)}`
        : fact.kind === 'import'
          ? `module=${field(fact.module_specifier)} names=${(fact.imported_names ?? []).join(',') || '-'}`
          : `relation=${field(fact.relation)} parent=${field(fact.parent_name)}`;
  return [
    'fact',
    fact.kind,
    `name=${field(fact.name)}`,
    `range=${range}`,
    detail,
    `language=${fact.language}`,
    `producer=${fact.producer}`,
    `extractorVersion=${fact.extractor_version}`,
  ].join(' ');
}

async function show(values: Record<string, unknown>): Promise<void> {
  const tenantId = required(values, 'tenant');
  const clientId = required(values, 'client');
  const path = required(values, 'path');
  const tree = typeof values.tree === 'string' ? values.tree : DEFAULT_TREE;
  const gitHash = gitBlobHash(readFileSync(join(tree, path)));
  await withApp(async (client) => {
    await bind(client, tenantId, clientId);
    try {
      const blob = await client.query<{
        outcome: string;
        size_bytes: number;
        parsed_with_errors: boolean | null;
        lossy: boolean | null;
        refused_cap_bytes: number | null;
        language: string | null;
        extractor_version: string | null;
      }>(
        `SELECT outcome, size_bytes, parsed_with_errors, lossy, refused_cap_bytes, language,
                extractor_version
           FROM codegraph.blob WHERE tenant_id = $1 AND git_blob_hash = $2`,
        [tenantId, gitHash],
      );
      const row = blob.rows[0];
      if (row === undefined) {
        throw new UsageError(`${path} (${gitHash}) is not stored for tenant ${tenantId}.`);
      }
      console.log(
        [
          path,
          gitHash,
          row.outcome,
          `size=${String(row.size_bytes)}`,
          `parsedWithErrors=${field(row.parsed_with_errors)}`,
          `lossy=${field(row.lossy)}`,
          `refusedCapBytes=${field(row.refused_cap_bytes)}`,
          `language=${field(row.language)}`,
          `extractorVersion=${field(row.extractor_version)}`,
        ].join(' '),
      );
      const facts = await client.query<FactRow>(
        `SELECT kind, name, start_line, start_column, end_line, end_column, language, producer,
                extractor_version, definition_kind, reference_kind, module_specifier,
                imported_names, parent_name, relation
           FROM codegraph.blob_fact WHERE tenant_id = $1 AND git_blob_hash = $2
          ORDER BY start_line NULLS LAST, start_column NULLS LAST, kind, name`,
        [tenantId, gitHash],
      );
      for (const fact of facts.rows) console.log(factLine(fact));
      const contents = await client.query<{ contents: string }>(
        'SELECT contents FROM codegraph.blob_contents WHERE tenant_id = $1 AND git_blob_hash = $2',
        [tenantId, gitHash],
      );
      const text = contents.rows[0]?.contents;
      console.log(text === undefined ? 'contents: none' : 'contents:');
      if (text !== undefined) process.stdout.write(text);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

async function reextract(values: Record<string, unknown>): Promise<void> {
  const language = required(values, 'language');
  const report = await reextractLanguage(language, {
    connectionString: requireEnv('DATABASE_URL'),
  });
  if (report.anotherRunInProgress) {
    console.log(`reextract ${language}: another run holds this language's lock; nothing moved`);
    return;
  }
  for (const batch of report.batches) {
    for (const blob of batch.blobs) {
      console.log(
        `batch ${String(batch.ordinal)} tenant=${blob.tenantId} ${blob.gitBlobHash} ` +
          `facts=${String(blob.factCount)}`,
      );
    }
  }
  console.log(
    `reextract ${language} to ${field(report.extractorVersion)}: ` +
      `batches=${String(report.batches.length)} blobs=${String(report.blobCount)} ` +
      `facts=${String(report.factCount)}`,
  );
}

const MODES: Record<string, (values: Record<string, unknown>) => Promise<void>> = {
  store,
  show,
  reextract,
};

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tenant: { type: 'string' },
      client: { type: 'string' },
      repository: { type: 'string' },
      path: { type: 'string' },
      tree: { type: 'string' },
      language: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const mode = positionals[0];
  if (values.help === true) {
    console.log(USAGE);
  } else {
    const run = mode === undefined ? undefined : MODES[mode];
    if (run === undefined) throw new UsageError(`Unknown mode ${String(mode)}.\n${USAGE}`);
    await run(values);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
