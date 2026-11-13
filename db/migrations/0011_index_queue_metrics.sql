-- 0011: the indexing queue's four numbers, read across every tenant.
--
-- The worker publishes how deep the queue is so a scaling policy and an alarm
-- can act on it. Every codegraph_app query is bound to one tenant under forced
-- row-level security, so no statement the service can write counts the whole
-- queue. docs/schema-contract.md §4 licenses one escape, a SECURITY DEFINER
-- function owned by codegraph_owner (whose policy is USING (true)), and §6
-- fixes its shape. This is the queue's SECOND such function, after 0010's
-- claim, and its only aggregate one: it answers four whole numbers and no
-- identifier, path, commit, ref, URL or per-tenant breakdown, so nothing any
-- tenant wrote crosses the boundary through it.
--
--   queued_jobs              index_jobs in 'queued'. A job being worked is
--                            not depth.
--   queued_batches           index_job_batches in 'queued' or 'running': the
--                            work the fleet still owes. Claiming a batch must
--                            not drop the gauge mid-job, and neither terminal
--                            state counts — 'stored' is done, and 'failed' is
--                            work nobody will do, which would hold the depth
--                            above zero for ever.
--   oldest_queued_job_age_seconds
--                            whole seconds from the oldest queued job's
--                            enqueued_at to now(), 0 when nothing waits. A
--                            re-queued job keeps its enqueued_at, so its real
--                            age.
--   failed_jobs_recent       jobs that ended 'failed' at or after now() minus
--                            the window, read off ended_at: a job that waited
--                            an hour and failed a minute ago is counted.
--
-- It adds no table, column or index: one aggregate per publishing interval is
-- not a per-request cost.

CREATE FUNCTION codegraph.codegraph_index_queue_metrics(p_failed_window_ms bigint)
RETURNS TABLE (
  queued_jobs integer,
  queued_batches integer,
  oldest_queued_job_age_seconds integer,
  failed_jobs_recent integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = codegraph, pg_temp
AS $$
BEGIN
  IF p_failed_window_ms IS NULL OR p_failed_window_ms < 1 THEN
    RAISE EXCEPTION 'p_failed_window_ms must be a positive number of milliseconds'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM codegraph.index_jobs j WHERE j.state = 'queued'),
    (SELECT count(*)::integer FROM codegraph.index_job_batches b
      WHERE b.state IN ('queued', 'running')),
    (SELECT COALESCE(floor(extract(epoch FROM now() - min(j.enqueued_at)))::integer, 0)
       FROM codegraph.index_jobs j WHERE j.state = 'queued'),
    (SELECT count(*)::integer FROM codegraph.index_jobs j
      WHERE j.state = 'failed'
        AND j.ended_at >= now() - make_interval(secs => p_failed_window_ms / 1000.0));
END
$$;

REVOKE EXECUTE ON FUNCTION codegraph.codegraph_index_queue_metrics(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION codegraph.codegraph_index_queue_metrics(bigint) TO codegraph_app;
