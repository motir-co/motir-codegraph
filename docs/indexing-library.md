# Indexing library

The per-blob layer of indexing, called as a library on files an indexer worker
has already fetched and hashed. A tenant, a git blob hash, a path and a file's
bytes go in; the blob is stored once for that tenant, with exactly what its
outcome allows, and the outcome comes back. A second entry point rebuilds a
language's stored blobs from their stored contents when that language's
extractor changes.

This page is the layer's contract, for two readers:

- **whoever writes the indexing workers**, who needs what to pass, what comes
  back, what a second store of the same blob does, and which behaviours they
  may build on;
- **whoever adds a language or bumps a grammar**, who needs the steps and what
  happens to the blobs already stored afterwards.

The rules for the tables themselves are in
[`docs/schema-contract.md`](schema-contract.md); the rules for routes are in
[`docs/api-contract.md`](api-contract.md). This layer adds no route.

## 1. The two entry points

### `storeBlob(db, input, options?)` — [`src/indexing/storeBlob.ts`](../src/indexing/storeBlob.ts)

| Parameter           | What it is                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `db`                | The caller's own connection (a `pg` client), as `codegraph_app`, at READ COMMITTED and not inside a transaction. |
| `input.tenantId`    | The tenant the blob belongs to.                                                                                  |
| `input.clientId`    | The client the tenant is bound with.                                                                             |
| `input.gitBlobHash` | The blob's git object id (40 or 64 lowercase hex characters).                                                    |
| `input.path`        | A path the blob was found at. It picks the language and is never written to a row.                               |
| `input.bytes`       | The file's bytes.                                                                                                |
| `options.capBytes`  | The per-file cap to apply; `perFileCapBytes()` (§5) when omitted.                                                |

The caller supplies the client id beside the tenant id because the tenant
policy admits a row only when the bound client holds a live grant on the bound
tenant: [`docs/schema-contract.md`](schema-contract.md) §4 states the rule.
`storeBlob` binds both with `BIND_TENANT_SQL` before its first statement, so a
store for a tenant the client holds no grant on is refused by the policy and
writes nothing.

It opens one transaction on `db` (`BEGIN` … `COMMIT`, `ROLLBACK` and re-raise
on any failure) and decides, in this order:

1. **Already stored.** The blob row for this tenant and hash exists: nothing is
   written, and the outcome on record is answered, with two exceptions that
   correct the row in the same transaction (§3). Bytes whose length is not the
   row's recorded size raise `BlobBytesMismatchError` and write nothing.
2. **Over the cap.** More bytes than the cap: `refused`.
3. **Binary.** A NUL byte anywhere in the payload (the first 8,000 bytes,
   `BINARY_SNIFF_BYTES`, are git's own look and are checked first): `binary`.
4. **No registry entry.** The path resolves to no language this service can
   extract: `unsupported`.
5. **Otherwise** the bytes are decoded as UTF-8 and extracted: `indexed`.

It answers a `StoredBlob`:

| Field              | What it holds                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `outcome`          | One of the four outcomes (§2), the `BlobOutcome` union.                                                |
| `alreadyStored`    | `true` when the row existed before this call.                                                          |
| `sizeBytes`        | The file's size in bytes.                                                                              |
| `parsedWithErrors` | Whether the parse met a syntax error; `null` unless `indexed`.                                         |
| `lossy`            | Whether decoding replaced invalid UTF-8; `null` unless contents were stored.                           |
| `refusedCapBytes`  | The cap that refused the file; `null` unless `refused`.                                                |
| `language`         | The language id; `null` for `refused`, `binary`, and an `unsupported` file of a language nobody knows. |
| `extractorVersion` | The extractor version the facts were made with; `null` unless `indexed`.                               |

### `reextractLanguage(language, options?)` — [`src/indexing/reextract.ts`](../src/indexing/reextract.ts)

Rebuilds every stale blob of one language, across every tenant, from its
stored contents, to the registry entry's current extractor version. A blob is
stale when it is `indexed` at another extractor version, or stored
`unsupported` under that language. No source is fetched and no path is needed.

| Option             | What it is                                                                        |
| ------------------ | --------------------------------------------------------------------------------- |
| `connectionString` | The owner login's URL; `DATABASE_URL` when omitted.                               |
| `batchSize`        | Stale blobs per page; `DEFAULT_REEXTRACT_BATCH_SIZE` when omitted.                |
| `registry`         | The language entries to resolve `language` in; the shipped registry when omitted. |

It runs on the owner connection and refuses any other: before its first page
it checks the login is `codegraph_owner` and raises if not. The owner's policy
is unconditional, which is how one call reaches the stale blobs of every
tenant; a tenant-bound session would sweep one tenant and report a finished run
while every other tenant stayed stale.

It takes the language's run lock (a session-level advisory lock on its own
connection, so a run that dies leaves no lock behind), then pages over the
stale blobs and re-extracts each in a transaction of its own, so a blob's facts
and its recorded version always move together. A call that stops part-way
leaves the next one exactly the blobs still stale. A stale blob with no stored
contents raises `ReextractError`, which names it and how many blobs were
re-extracted before it.

It answers a `ReextractReport`:

| Field                  | What it holds                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `language`             | The language asked for.                                                                                                 |
| `extractorVersion`     | The version re-extracted to; `null` when the language has no registry entry, and nothing was written.                   |
| `anotherRunInProgress` | `true` when another run held this language's lock, so this one wrote nothing.                                           |
| `batches`              | One `ReextractBatch` per page: its 1-based `ordinal`, and its `blobs` — each `tenantId`, `gitBlobHash` and `factCount`. |
| `blobCount`            | The blobs re-extracted.                                                                                                 |
| `factCount`            | The facts now recorded for them.                                                                                        |

## 2. The four outcomes

Exactly one outcome is recorded per blob, on its row in `codegraph.blob`, and
a check constraint couples each outcome to the columns it uses.

| `outcome`     | What is stored                                                                                                                              | What the caller receives                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `indexed`     | The row with `size_bytes`, `language`, `extractor_version`, `parsed_with_errors` and `lossy`; the contents; the facts.                      | All of those fields; `refusedCapBytes` is `null`.            |
| `unsupported` | The row with `size_bytes`, `lossy` and, when the registry knows the language but has no grammar for it, `language`; the contents. No facts. | `sizeBytes`, `lossy` and `language` (or `null`).             |
| `binary`      | The row with `size_bytes` only. No contents, no facts.                                                                                      | `sizeBytes`; every other field `null`.                       |
| `refused`     | The row with `size_bytes` and `refused_cap_bytes`, the cap that refused it. No contents, no facts.                                          | `sizeBytes` and `refusedCapBytes`; every other field `null`. |

`indexed` with `parsedWithErrors` set is still `indexed`: tree-sitter recovers
from a syntax error and the facts it could read are stored. `lossy` means
decoding replaced invalid UTF-8 with U+FFFD, so grep still reaches the rest of
the file.

## 3. What a caller may rely on

- **A second store of an already-stored blob writes nothing** and answers the
  outcome on record, with `alreadyStored` set. The exceptions are the two rows
  the configuration in force would now decide differently and that only the
  bytes in hand can fix: a `refused` blob whose recorded size now fits the cap
  is re-classified from the bytes (to `indexed`, `unsupported` or `binary`),
  and an `unsupported` blob that records no language, whose path now resolves
  to one, gains it (and its facts, when the language can be extracted). Both
  happen in the store's one transaction, and the call answers the corrected
  outcome. A row is never demoted: no store writes `refused` over a stored row.
- **A blob's contents, its facts and its recorded extractor version are written
  in one transaction**, the one `storeBlob` opens on `db`; in a re-extraction,
  the one each blob's rebuild opens. A failure rolls all of them back.
- **Blobs are tenant-scoped and never shared between tenants.** The same bytes
  stored by two tenants are two rows, each readable only under its own tenant's
  binding.
- **Two concurrent stores of one blob leave one copy.** The blob row's insert
  does nothing on conflict, so the store that loses the race writes no contents
  and no facts and answers the winner's outcome; two concurrent corrections
  converge on one contents row and one fact set.

## 4. What a caller may not rely on

- **No read and no route.** The layer stores and answers outcomes; it serves no
  query over the stored facts or contents, and nothing here is reachable over
  HTTP.
- **Nothing about when to run it.** Which files to fetch, when, and from which
  job belongs to the indexing workers and the queue.
- **Nothing about which blobs are still referenced.** A blob row carries no
  repository, path or commit, so whether any commit still points at it is the
  commit layer's question.

## 5. Configuration

The layer adds one setting, `PER_FILE_CAP_BYTES`: the largest file, in bytes,
the store indexes or keeps contents for. It defaults to 1048576 (1 MiB,
`DEFAULT_PER_FILE_CAP_BYTES`) when unset or blank. A file over it is stored
`refused`, recording its size and this cap, with no contents and no facts. A
value that is not a whole number of 1 or more is a configuration error naming
the variable. [`src/config.ts`](../src/config.ts) (`perFileCapBytes`) reads it
and [`.env.example`](../.env.example) documents it.

The re-extraction page size is **not** a configuration key: it is the module
constant `DEFAULT_REEXTRACT_BATCH_SIZE` (100), overridden per call with the
`batchSize` option. No environment variable sets it.

## 6. The tables it owns

| Table                     | What it holds                                                                                | Created by                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `codegraph.blob`          | One row per tenant and git blob hash: its size and its outcome with that outcome's columns.  | [`0005_blob_and_contents.sql`](../db/migrations/0005_blob_and_contents.sql) |
| `codegraph.blob_contents` | One lz4-compressed text row per blob that stores contents, behind a trigram index for grep.  | [`0005_blob_and_contents.sql`](../db/migrations/0005_blob_and_contents.sql) |
| `codegraph.blob_fact`     | One row per definition, reference, import and inheritance, per producer, for every language. | [`0006_blob_fact.sql`](../db/migrations/0006_blob_fact.sql)                 |

All three are content-addressed: they carry `tenant_id` and the git blob hash,
and no repository, path or commit. Their isolation, removal and grants follow
[`docs/schema-contract.md`](schema-contract.md) §10.

## 7. Adding a language

A language is one module under [`src/indexer/languages/`](../src/indexer/languages),
listed in [`src/indexer/registry.ts`](../src/indexer/registry.ts):

1. **Pin the grammar.** Add the grammar's npm package to `package.json` at an
   exact version, and name the package, its `.wasm` file and that version in
   the module (`grammarPackage`, `grammarFile`, `grammarVersion`).
2. **Write the tags query** in tree-sitter's
   [code-navigation convention](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html):
   `@definition.<kind>` and `@reference.<kind>` on the node, `@name` on its
   identifier. Where the grammar ships a `queries/tags.scm`, copy it verbatim
   and credit it.
3. **Add this service's own captures** for imports (`@import.module`,
   `@import.name`) and inheritance (`@inheritance.extends`,
   `@inheritance.implements`). The vocabulary is defined once, in
   [`src/extract/captures.ts`](../src/extract/captures.ts).
4. **Fill the extension and filename map** (`extensions`, `filenames`). A key
   declared by two languages throws when the registry loads, naming it. A
   language that had no grammar moves out of
   [`unavailable.ts`](../src/indexer/languages/unavailable.ts), taking its map
   with it.
5. **Set the query revision.** The extractor version is derived, never written:
   `composeExtractorVersion(grammarVersion, queryRevision)` in
   [`src/extract/version.ts`](../src/extract/version.ts). Bump `queryRevision`
   whenever the query text changes; a grammar bump moves `grammarVersion`.

The current grammar and extractor version of every language are whatever
`listLanguages()` answers; this page prints none of them.

**What happens afterwards.** The language leaves the no-grammar list, and its
new files are `indexed` on their next store. Its blobs already stored
`unsupported` under its id are stale, as are its `indexed` blobs whenever the
version moves: `reextractLanguage('<id>')` rebuilds them from their stored
contents, each blob's facts and recorded state moving in one transaction. No
re-store and no fetch is needed.

**A language with no maintained grammar** is registered as having none, in
[`unavailable.ts`](../src/indexer/languages/unavailable.ts), with the reason.
Its files return `unsupported` with their contents stored and its id recorded
on the blob row, which the registry's second path lookup,
`unavailableLanguageForPath`, provides. That recorded id is what lets
`reextractLanguage` find those blobs on the day the language gains a grammar.
[`docs/tree-sitter-runtime.md`](tree-sitter-runtime.md) lists which languages
are in that state and why.

## 8. Where to look next

- [`docs/schema-contract.md`](schema-contract.md) — the rules the three tables
  follow, §10 for content-addressed tables.
- [`src/extract/captures.ts`](../src/extract/captures.ts) — the capture
  vocabulary a tags query is written in.
- [`src/indexer/registry.ts`](../src/indexer/registry.ts) — every language,
  its grammar pin and its current extractor version.
- [`README.md`](../README.md) — bringing the service up.
