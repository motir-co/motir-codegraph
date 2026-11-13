-- 0010: the indexing queue. A /v1 first-index, push or refresh call writes a
-- JOB row; a worker claims it, fetches the source, stores the blobs the
-- database lacks and publishes the commit's layer. A job too large for one
-- pass is fanned out into BATCH rows, one per slice of its missing blobs, so
-- several workers can store one commit at once.
--
-- Two tables, both per-repository (docs/schema-contract.md §2 and §3): each
-- carries tenant_id and repository_id, references the repository PAIR with ON
-- DELETE CASCADE, and is removed with its repository or its tenant. Row-level
-- security and the two policies follow §4, with the foundation's policy text
-- repeated verbatim; grants follow §5, per verb and per column, with no
-- default privilege.
--
-- ONE function, codegraph_claim_index_job. Every codegraph_app query is bound
-- to one tenant, so no statement the service can write sees two tenants'
-- queues, and a worker pool must. §4 licenses exactly one escape: a SECURITY
-- DEFINER function owned by codegraph_owner, whose policy is USING (true). The
-- claim is that function, and it answers ids and the token it minted —
-- nothing a tenant wrote crosses the boundary. Every later write of a job runs
-- in a transaction bound to the job's own tenant and client
-- (src/db/indexJobs.ts).
--
-- No trigger. The state machine is CHECK constraints, for the reason 0007
-- records: a trigger that rewrote a row would act inside another module's unit
-- of work. Each state's timestamps, lease and fetch URL are pinned by a check,
-- so a row cannot be ended still holding the URL it was fetched from.
--
-- No service knob appears here: the lease length and the attempt bound are
-- the claim's arguments, read from the worker's configuration.

-- ── index_jobs ─────────────────────────────────────────────────────────────
-- One row per unit of queued work.
--
--   kind      a REQUEST kind — 'first_index', 'push', 'refresh' — carries the
--             commit, the ref and (while queued or running) the fetch URL a
--             /v1 call named. A MAINTENANCE kind carries none of the three,
--             except that 'compact' carries the commit it compacts:
--             'discard_stale' is tenant-scoped and 'release' takes the tenant
--             with its repository, so neither names a commit or a ref.
--             Re-extraction is not a queue kind: it binds no tenant and runs on
--             the owner login only.
--   client_id the client that enqueued. The libraries a job drives require a
--             transaction bound to a client holding a live grant on the
--             tenant, and only the row knows which client that was.
--   candidate_ancestors
--             on a push, the previous head the call named, and nothing more.
--   state     'queued' → 'running' → 'succeeded' | 'failed'; a queued push
--             replaced by a newer push of its ref ends 'superseded' without
--             ever running.
--   attempts  how many times a lease expired under this job. A job that
--             fails cleanly records its reason and consumes none.
--   lease_expires_at, claimed_by
--             the lease a run holds and the token the claim minted for it. A
--             'running' job fanned out to its batches holds NEITHER: its
--             batches own it, each under its own lease.
--   fetch_url present exactly while a request kind is queued or running, and
--             cleared by every end, so the row is the only place a URL ever
--             lives and it cannot outlive the job that carried it.
CREATE TABLE codegraph.index_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  client_id uuid NOT NULL,
  kind text NOT NULL,
  commit_sha text,
  ref_name text,
  is_default_branch boolean NOT NULL DEFAULT false,
  candidate_ancestors text[] NOT NULL DEFAULT '{}',
  changed_paths text[] NOT NULL DEFAULT '{}',
  fetch_url text,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  claimed_by text,
  failure_reason_code text,
  failure_message text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT index_jobs_repository_fkey
    FOREIGN KEY (tenant_id, repository_id)
    REFERENCES codegraph.repositories (tenant_id, id) ON DELETE CASCADE,
  -- The key a batch's job key points at, so a batch can never name a job of
  -- another repository. It leads with the pair, so it is also the index §3
  -- asks for on the foreign-key columns.
  CONSTRAINT index_jobs_tenant_repository_id_key UNIQUE (tenant_id, repository_id, id),
  CONSTRAINT index_jobs_kind_check CHECK (
    kind IN ('first_index', 'push', 'refresh', 'compact', 'discard_stale', 'release')
  ),
  CONSTRAINT index_jobs_state_check CHECK (
    state IN ('queued', 'running', 'succeeded', 'failed', 'superseded')
  ),
  -- A SHA-1 (40) or SHA-256 (64) git object id, lowercase, as commit_layers'.
  CONSTRAINT index_jobs_commit_sha_check
    CHECK (commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- 0009's blank set, verbatim: a ref of only whitespace is refused.
  CONSTRAINT index_jobs_ref_name_check
    CHECK (ref_name !~ '^[ \t\n\v\f\r   -     　﻿]*$'),
  CONSTRAINT index_jobs_attempts_check CHECK (attempts >= 0),
  -- Each kind carries exactly the columns its library call takes. Neither
  -- array is multi-dimensional or holds a NULL member.
  CONSTRAINT index_jobs_kind_columns_check CHECK (
    COALESCE(array_ndims(candidate_ancestors), 1) = 1
    AND array_position(candidate_ancestors, NULL) IS NULL
    AND COALESCE(array_ndims(changed_paths), 1) = 1
    AND array_position(changed_paths, NULL) IS NULL
    AND CASE
      WHEN kind IN ('first_index', 'push', 'refresh') THEN
        commit_sha IS NOT NULL AND ref_name IS NOT NULL
      WHEN kind = 'compact' THEN
        commit_sha IS NOT NULL AND ref_name IS NULL AND NOT is_default_branch
        AND cardinality(candidate_ancestors) = 0 AND cardinality(changed_paths) = 0
      ELSE
        commit_sha IS NULL AND ref_name IS NULL AND NOT is_default_branch
        AND cardinality(candidate_ancestors) = 0 AND cardinality(changed_paths) = 0
    END
  ),
  -- queued: neither a start nor an end. running: a start, no end. An ended
  -- state carries its end, keeps the start it was claimed with (none if it
  -- never ran), and never ends before it started.
  CONSTRAINT index_jobs_state_times_check CHECK (
    CASE state
      WHEN 'queued' THEN started_at IS NULL AND ended_at IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL
      ELSE ended_at IS NOT NULL AND (started_at IS NULL OR ended_at >= started_at)
    END
  ),
  -- running: both the lease and its token, or neither (fanned out to its
  -- batches); never one without the other. Every other state: neither.
  CONSTRAINT index_jobs_state_lease_check CHECK (
    CASE state
      WHEN 'running' THEN (lease_expires_at IS NULL) = (claimed_by IS NULL)
      ELSE lease_expires_at IS NULL AND claimed_by IS NULL
    END
  ),
  -- A fetch URL exactly while a request kind is queued or running.
  CONSTRAINT index_jobs_fetch_url_check CHECK (
    CASE
      WHEN kind IN ('first_index', 'push', 'refresh') AND state IN ('queued', 'running')
        THEN fetch_url IS NOT NULL AND fetch_url <> ''
      ELSE fetch_url IS NULL
    END
  ),
  -- failed carries a reason code (a snake_case word); no other state carries
  -- a code or a message.
  CONSTRAINT index_jobs_failure_check CHECK (
    CASE state
      WHEN 'failed' THEN failure_reason_code IS NOT NULL AND failure_reason_code ~ '^[a-z][a-z0-9_]*$'
      ELSE failure_reason_code IS NULL AND failure_message IS NULL
    END
  )
);

-- A repository's jobs by state: the status read and the "is one running" test.
CREATE INDEX index_jobs_repository_state_idx
  ON codegraph.index_jobs (tenant_id, repository_id, state);

-- The claim's order: queued jobs, oldest first.
CREATE INDEX index_jobs_queued_idx
  ON codegraph.index_jobs (enqueued_at, id)
  WHERE state = 'queued';

-- The claim's lease sweep: running jobs by when their lease ends.
CREATE INDEX index_jobs_lease_idx
  ON codegraph.index_jobs (lease_expires_at)
  WHERE state = 'running';

-- The enqueue's supersede: a repository's queued pushes of one ref.
CREATE INDEX index_jobs_queued_push_ref_idx
  ON codegraph.index_jobs (tenant_id, repository_id, ref_name)
  WHERE kind = 'push' AND state = 'queued';

-- At most ONE running job per repository. The claim's advisory lock is what
-- keeps two claims from racing for it; this index is what makes the rule a
-- schema fact, so it holds even for a writer that forgets the lock.
CREATE UNIQUE INDEX index_jobs_one_running_per_repository
  ON codegraph.index_jobs (tenant_id, repository_id)
  WHERE state = 'running';

-- ── index_job_batches ──────────────────────────────────────────────────────
-- One row per slice of one job's missing blobs: the paths and their git blob
-- hashes, position for position. A slice is claimed, leased and retried on its
-- own, by workers other than the one that opened the job's layer. A batch has
-- no existence apart from its job, so the key to index_jobs CASCADES.
--
--   state         'queued' → 'running' → 'stored' | 'failed'.
--   stored_count  how many of the slice's blobs the run stored.
CREATE TABLE codegraph.index_job_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  job_id uuid NOT NULL,
  ordinal integer NOT NULL,
  paths text[] NOT NULL,
  git_blob_hashes text[] NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  claimed_by text,
  stored_count integer NOT NULL DEFAULT 0,
  failure_reason_code text,
  failure_message text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT index_job_batches_repository_fkey
    FOREIGN KEY (tenant_id, repository_id)
    REFERENCES codegraph.repositories (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT index_job_batches_job_fkey
    FOREIGN KEY (tenant_id, repository_id, job_id)
    REFERENCES codegraph.index_jobs (tenant_id, repository_id, id) ON DELETE CASCADE,
  -- One slice per position of a job. It leads with the pair, so it is also
  -- the index §3 asks for on the foreign-key columns, and it backs the job key.
  CONSTRAINT index_job_batches_job_ordinal_key UNIQUE (tenant_id, repository_id, job_id, ordinal),
  CONSTRAINT index_job_batches_state_check CHECK (
    state IN ('queued', 'running', 'stored', 'failed')
  ),
  -- Paths and hashes pair up position for position: equal, non-zero length,
  -- one-dimensional, no NULL member.
  CONSTRAINT index_job_batches_slice_check CHECK (
    array_ndims(paths) = 1
    AND array_ndims(git_blob_hashes) = 1
    AND cardinality(paths) = cardinality(git_blob_hashes)
    AND cardinality(paths) >= 1
    AND array_position(paths, NULL) IS NULL
    AND array_position(git_blob_hashes, NULL) IS NULL
  ),
  CONSTRAINT index_job_batches_ordinal_check CHECK (ordinal >= 1),
  CONSTRAINT index_job_batches_stored_count_check
    CHECK (stored_count >= 0 AND stored_count <= cardinality(paths)),
  CONSTRAINT index_job_batches_attempts_check CHECK (attempts >= 0),
  -- A batch has no start column: queued and running carry no end; an ended
  -- batch carries one, never before it was enqueued.
  CONSTRAINT index_job_batches_state_times_check CHECK (
    CASE state
      WHEN 'queued' THEN ended_at IS NULL
      WHEN 'running' THEN ended_at IS NULL
      ELSE ended_at IS NOT NULL AND ended_at >= enqueued_at
    END
  ),
  CONSTRAINT index_job_batches_state_lease_check CHECK (
    CASE state
      WHEN 'running' THEN (lease_expires_at IS NULL) = (claimed_by IS NULL)
      ELSE lease_expires_at IS NULL AND claimed_by IS NULL
    END
  ),
  CONSTRAINT index_job_batches_failure_check CHECK (
    CASE state
      WHEN 'failed' THEN failure_reason_code IS NOT NULL AND failure_reason_code ~ '^[a-z][a-z0-9_]*$'
      ELSE failure_reason_code IS NULL AND failure_message IS NULL
    END
  )
);

-- The batch claim's order: a job's queued slices by position.
CREATE INDEX index_job_batches_queued_idx
  ON codegraph.index_job_batches (state, job_id, ordinal)
  WHERE state = 'queued';

-- The claim's lease sweep over batches.
CREATE INDEX index_job_batches_lease_idx
  ON codegraph.index_job_batches (lease_expires_at)
  WHERE state = 'running';

-- ── row-level security ─────────────────────────────────────────────────────
ALTER TABLE codegraph.index_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.index_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY index_jobs_tenant ON codegraph.index_jobs
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY index_jobs_owner ON codegraph.index_jobs
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

ALTER TABLE codegraph.index_job_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE codegraph.index_job_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY index_job_batches_tenant ON codegraph.index_job_batches
  AS PERMISSIVE FOR ALL TO codegraph_app
  USING (tenant_id = (SELECT codegraph.codegraph_bound_tenant()))
  WITH CHECK (tenant_id = (SELECT codegraph.codegraph_bound_tenant()));
CREATE POLICY index_job_batches_owner ON codegraph.index_job_batches
  AS PERMISSIVE FOR ALL TO codegraph_owner
  USING (true) WITH CHECK (true);

-- ── codegraph_app's least grants ───────────────────────────────────────────
-- A job is inserted by the enqueue, deleted by nothing but a caller cleaning
-- up, and updated in exactly the columns an END and a lease renewal write:
-- the state, its end time, the cleared fetch URL, the failure, and the lease
-- and its token. Nothing the service runs may forge an attempt count or a
-- start time: only the claim, as the owner, writes those.
GRANT SELECT, INSERT, DELETE ON codegraph.index_jobs TO codegraph_app;
GRANT UPDATE (state, ended_at, fetch_url, failure_reason_code, failure_message,
              lease_expires_at, claimed_by) ON codegraph.index_jobs TO codegraph_app;

-- A batch is inserted by the fan-out and updated by its end: the state, the
-- stored count, the end time, the failure, and the lease and its token.
GRANT SELECT, INSERT, DELETE ON codegraph.index_job_batches TO codegraph_app;
GRANT UPDATE (state, stored_count, ended_at, failure_reason_code, failure_message,
              lease_expires_at, claimed_by) ON codegraph.index_job_batches TO codegraph_app;

-- ── the claim ──────────────────────────────────────────────────────────────
-- One call, its own short transaction, in three steps:
--
--   (a) end stale rows. A running BATCH whose lease expired returns to queued
--       with one more attempt; at max_attempts it fails 'attempts_exhausted',
--       failing its job with the same code and ending the job's other
--       unfinished batches 'job_failed'. A running JOB whose lease expired
--       fails 'binding_refused' when its client no longer holds a live grant
--       on its tenant; otherwise it returns to queued with one more attempt
--       and its start, lease and token cleared, or at max_attempts fails
--       'attempts_exhausted' and ends its unfinished batches 'job_failed'.
--   (b) claim at most one queued BATCH of a running job, oldest first. Batch
--       claims take no repository lock: parallel slices of one job are the
--       point of a batch.
--   (c) failing that, claim at most one queued JOB, oldest first, of a
--       repository with no running job. A queued job whose client holds no
--       live grant fails 'binding_refused' as it is reached and is never
--       claimed.
--
-- One running job per repository needs two mechanisms. FOR UPDATE SKIP
-- LOCKED keeps two claims off the SAME row and says nothing about two claims
-- taking two rows of one repository. So (c) takes a transaction-scoped,
-- try-only advisory lock keyed on the repository — the hashtext idiom
-- src/db/layers.ts uses, under its own prefix — and a loser skips the
-- repository rather than waiting; index_jobs_one_running_per_repository
-- underneath refuses a second running row outright. The lock is released when
-- the claim's transaction ends, so the caller must COMMIT the claim before it
-- starts the work (a caller that worked inside it would hold the repository
-- for the whole index).
--
-- The answer is a closed list of ids and the minted token. No fetch URL,
-- commit, path, ancestor or failure text crosses the tenant boundary: the
-- caller binds the answer's tenant and client (BIND_TENANT_SQL) and reads the
-- row under the tenant policy.
CREATE FUNCTION codegraph.codegraph_claim_index_job(lease_ms integer, max_attempts integer)
RETURNS TABLE (
  claim_kind text,
  tenant_id uuid,
  repository_id uuid,
  client_id uuid,
  job_id uuid,
  batch_id uuid,
  claimed_by text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  lease interval;
  token text;
  stale record;
  candidate record;
  claimed record;
BEGIN
  IF lease_ms IS NULL OR lease_ms < 1 THEN
    RAISE EXCEPTION 'lease_ms must be a positive number of milliseconds'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF max_attempts IS NULL OR max_attempts < 1 THEN
    RAISE EXCEPTION 'max_attempts must be a positive number of attempts'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  lease := make_interval(secs => codegraph_claim_index_job.lease_ms / 1000.0);
  token := gen_random_uuid()::text;

  -- (a) stale batches.
  FOR stale IN
    SELECT b.id, b.tenant_id, b.repository_id, b.job_id, b.attempts
    FROM codegraph.index_job_batches b
    WHERE b.state = 'running' AND b.lease_expires_at < now()
    ORDER BY b.lease_expires_at
    FOR UPDATE SKIP LOCKED
  LOOP
    IF stale.attempts + 1 >= codegraph_claim_index_job.max_attempts THEN
      UPDATE codegraph.index_job_batches b
      SET state = 'failed', attempts = b.attempts + 1, ended_at = now(),
          lease_expires_at = NULL, claimed_by = NULL,
          failure_reason_code = 'attempts_exhausted',
          failure_message = 'The batch''s lease expired on its last allowed attempt.'
      WHERE b.id = stale.id;
      UPDATE codegraph.index_jobs j
      SET state = 'failed', ended_at = now(), fetch_url = NULL,
          lease_expires_at = NULL, claimed_by = NULL,
          failure_reason_code = 'attempts_exhausted',
          failure_message = 'A batch of the job exhausted its attempts.'
      WHERE j.tenant_id = stale.tenant_id AND j.repository_id = stale.repository_id
        AND j.id = stale.job_id AND j.state IN ('queued', 'running');
      UPDATE codegraph.index_job_batches b
      SET state = 'failed', ended_at = now(), lease_expires_at = NULL, claimed_by = NULL,
          failure_reason_code = 'job_failed',
          failure_message = 'A batch of the job exhausted its attempts.'
      WHERE b.tenant_id = stale.tenant_id AND b.repository_id = stale.repository_id
        AND b.job_id = stale.job_id AND b.state IN ('queued', 'running');
    ELSE
      UPDATE codegraph.index_job_batches b
      SET state = 'queued', attempts = b.attempts + 1,
          lease_expires_at = NULL, claimed_by = NULL
      WHERE b.id = stale.id;
    END IF;
  END LOOP;

  -- (a) stale jobs. A fanned-out job holds no lease, so it is never taken
  -- here: its batches are.
  FOR stale IN
    SELECT j.id, j.tenant_id, j.repository_id, j.client_id, j.attempts,
           EXISTS (
             SELECT 1 FROM codegraph.grants g
             WHERE g.client_id = j.client_id AND g.tenant_id = j.tenant_id
               AND g.revoked_at IS NULL
           ) AS granted
    FROM codegraph.index_jobs j
    WHERE j.state = 'running' AND j.lease_expires_at < now()
    ORDER BY j.lease_expires_at
    FOR UPDATE SKIP LOCKED
  LOOP
    IF NOT stale.granted THEN
      UPDATE codegraph.index_jobs j
      SET state = 'failed', attempts = j.attempts + 1, ended_at = now(), fetch_url = NULL,
          lease_expires_at = NULL, claimed_by = NULL,
          failure_reason_code = 'binding_refused',
          failure_message = 'The client that enqueued the job holds no live grant on its tenant.'
      WHERE j.id = stale.id;
    ELSIF stale.attempts + 1 >= codegraph_claim_index_job.max_attempts THEN
      UPDATE codegraph.index_jobs j
      SET state = 'failed', attempts = j.attempts + 1, ended_at = now(), fetch_url = NULL,
          lease_expires_at = NULL, claimed_by = NULL,
          failure_reason_code = 'attempts_exhausted',
          failure_message = 'The job''s lease expired on its last allowed attempt.'
      WHERE j.id = stale.id;
    ELSE
      UPDATE codegraph.index_jobs j
      SET state = 'queued', attempts = j.attempts + 1, started_at = NULL,
          lease_expires_at = NULL, claimed_by = NULL
      WHERE j.id = stale.id;
      CONTINUE;
    END IF;
    UPDATE codegraph.index_job_batches b
    SET state = 'failed', ended_at = now(), lease_expires_at = NULL, claimed_by = NULL,
        failure_reason_code = 'job_failed',
        failure_message = 'The job the batch belongs to failed.'
    WHERE b.tenant_id = stale.tenant_id AND b.repository_id = stale.repository_id
      AND b.job_id = stale.id AND b.state IN ('queued', 'running');
  END LOOP;

  -- (b) one batch of a running job, oldest first.
  SELECT b.id, b.tenant_id, b.repository_id, b.job_id, j.client_id
  INTO claimed
  FROM codegraph.index_job_batches b
  JOIN codegraph.index_jobs j
    ON j.tenant_id = b.tenant_id AND j.repository_id = b.repository_id AND j.id = b.job_id
  WHERE b.state = 'queued' AND j.state = 'running'
  ORDER BY b.enqueued_at, b.job_id, b.ordinal
  LIMIT 1
  FOR UPDATE OF b SKIP LOCKED;
  IF FOUND THEN
    UPDATE codegraph.index_job_batches b
    SET state = 'running', lease_expires_at = now() + lease, claimed_by = token
    WHERE b.id = claimed.id;
    RETURN QUERY SELECT 'batch'::text, claimed.tenant_id, claimed.repository_id,
      claimed.client_id, claimed.job_id, claimed.id, token;
    RETURN;
  END IF;

  -- (c) one queued job, oldest first, of a repository with no running job.
  FOR candidate IN
    SELECT j.id, j.tenant_id, j.repository_id, j.client_id
    FROM codegraph.index_jobs j
    WHERE j.state = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM codegraph.index_jobs r
        WHERE r.tenant_id = j.tenant_id AND r.repository_id = j.repository_id
          AND r.state = 'running'
      )
    ORDER BY j.enqueued_at, j.id
  LOOP
    -- Another claim holds this repository: skip it, never wait.
    IF NOT pg_try_advisory_xact_lock(
      hashtext('codegraph.index_jobs.repository:' || candidate.tenant_id::text || ':'
               || candidate.repository_id::text)
    ) THEN
      CONTINUE;
    END IF;
    -- Re-read under the lock: a claim that held it may have committed a
    -- running job of this repository, or taken this row.
    SELECT j.id, j.state,
           EXISTS (
             SELECT 1 FROM codegraph.grants g
             WHERE g.client_id = j.client_id AND g.tenant_id = j.tenant_id
               AND g.revoked_at IS NULL
           ) AS granted,
           EXISTS (
             SELECT 1 FROM codegraph.index_jobs r
             WHERE r.tenant_id = j.tenant_id AND r.repository_id = j.repository_id
               AND r.state = 'running'
           ) AS busy
    INTO claimed
    FROM codegraph.index_jobs j
    WHERE j.id = candidate.id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR claimed.state <> 'queued' OR claimed.busy THEN
      CONTINUE;
    END IF;
    IF NOT claimed.granted THEN
      UPDATE codegraph.index_jobs j
      SET state = 'failed', ended_at = now(), fetch_url = NULL,
          failure_reason_code = 'binding_refused',
          failure_message = 'The client that enqueued the job holds no live grant on its tenant.'
      WHERE j.id = candidate.id;
      CONTINUE;
    END IF;
    UPDATE codegraph.index_jobs j
    SET state = 'running', started_at = now(), lease_expires_at = now() + lease,
        claimed_by = token
    WHERE j.id = candidate.id;
    RETURN QUERY SELECT 'job'::text, candidate.tenant_id, candidate.repository_id,
      candidate.client_id, candidate.id, NULL::uuid, token;
    RETURN;
  END LOOP;
END
$$;

REVOKE EXECUTE ON FUNCTION codegraph.codegraph_claim_index_job(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION codegraph.codegraph_claim_index_job(integer, integer) TO codegraph_app;
