# Indexing capacity

Written by `pnpm bench:indexing` from the run started 2026-11-13T16:42:50.996Z; every number below is that run's own.

Overall: **met**.

## Configuration

- Seed: `indexing-bench`
- Workers: 10; `BLOB_STORE_BATCH_SIZE` 500; `WORKER_POLL_MS` 100; `JOB_LEASE_MS` 60000; `MAX_ATTEMPTS` 3
- Per-file cap: 1048576 bytes
- Targets: push 60.0 s, first index 600.0 s
- Sampler: every 100 ms, bound `MAX_INDEXING_TX_MS` 60000 ms

## Push arm — a 50-file push

- Target: 60.0 s from the call's 202 to the first tenant-bound `resolveCommit` answering the full expected map.
- Measured: median **13.5 s** over 3 passes after one discarded warm-up (12.6 s); readings 13.5 s, 13.5 s, 13.8 s; min 13.5 s, max 13.8 s.
- Verdict: **met**.
- Tree `base`: 20000 paths, 20000 files, 588890 bytes of text, largest file 30 bytes, tarball 386518 bytes deflated.
- Tree `successor`: 20000 paths, 20000 files, 589920 bytes of text, largest file 50 bytes, tarball 391116 bytes deflated.
- Longest indexing transaction observed: 491 ms (bound `MAX_INDEXING_TX_MS` 60000 ms, within it), over 3273 samples every 100 ms. Statement: `SELECT p.path, p.git_blob_hash AS "gitBlobHash" FROM codegraph.layer_paths p WHERE p.tenant_id = $1 AND p.repository_id = $2 AND p.layer_id = $3 AND ($4::text IS NULL OR p.path COLLATE "C" > $4::text…`.
  A sample shows a long transaction was present at that instant; the samples are not proof that none occurred between two of them.
- Liveness (not a read target): 1291 resolutions of the other repository's published commit during the arm, 0 failed.

## First-index arm — a motir-core-sized tree

- Target: 600.0 s from the call's 202 to the first tenant-bound `resolveCommit` answering the full expected map.
- Measured: median **120.0 s** over 3 passes after one discarded warm-up (108.5 s); readings 122.1 s, 120.0 s, 114.1 s; min 114.1 s, max 122.1 s.
- Verdict: **met**.
- Tree `large`: 9524 paths, 9524 files, 207.0 MiB (217059659 bytes) of text, largest file 40955 bytes, tarball 43.9 MiB (46080273 bytes) deflated.
- Longest indexing transaction observed: 2348 ms (bound `MAX_INDEXING_TX_MS` 60000 ms, within it), over 4780 samples every 100 ms. Statement: `COMMIT`.
  A sample shows a long transaction was present at that instant; the samples are not proof that none occurred between two of them.
- Liveness (not a read target): 1875 resolutions of the other repository's published commit during the arm, 0 failed.
