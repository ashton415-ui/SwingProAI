-- ============================================================================
-- ENT-1D — real PostgreSQL acceptance cases (single session + manual Part B)
-- ============================================================================
--
-- NON-PRODUCTION ONLY. Run against a disposable local stack after both
-- ENT-1D migrations have been applied (executed locally on PostgreSQL 17 in
-- the ENT-1D integration runs; see supabase/tests/evidence/). Never run
-- against staging or production data. Each block raises on failure and emits
-- a PASS notice on success.
--
-- Everything below runs in one transaction that is rolled back. Fixture rows
-- use synthetic identifiers. Each check raises on failure.
--
-- Part A runs in a single session. Part B (concurrency) needs two sessions
-- and is described as a manual script at the end.

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────

-- Two synthetic auth users and their profiles are assumed to be creatable in
-- the target environment; adapt to its auth fixture helpers if needed.
insert into auth.users (id, email)
values ('0a000000-0000-4000-8000-0000000000a1', 'ent1d-owner@example.test'),
       ('0a000000-0000-4000-8000-0000000000a2', 'ent1d-other@example.test');

insert into public.swing_videos (id, user_id, status, storage_path, video_url)
values ('0b000000-0000-4000-8000-0000000000b1', '0a000000-0000-4000-8000-0000000000a1', 'uploaded',
        '0a000000-0000-4000-8000-0000000000a1/clip.mp4', '0a000000-0000-4000-8000-0000000000a1/clip.mp4');

insert into public.swing_analysis (id, swing_video_id, user_id, status, score, feedback, metrics,
                                   swing_highlights, launch_monitor_summary, putting_analysis)
values ('0b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000b1',
        '0a000000-0000-4000-8000-0000000000a1', 'complete', 72, 'core summary',
        '{"drills":[{"name":"Chair drill"}]}', '[{"positive_movement":"Quiet head"}]',
        '{"note":"LAUNCH-SECRET"}', null);

-- ── A1. Effective privileges (no session needed) ────────────────────────────

do $a1$
declare
  v_col text;
begin
  foreach v_col in array array['metrics', 'swing_highlights', 'mechanical_deficiencies', 'putting_analysis',
                               'putting_score', 'putt_analytics', 'launch_monitor_summary', 'fusion_notes',
                               'ai_equipment_recommendations', 'processing_claim_id', 'processing_started_at',
                               'processing_heartbeat_at', 'provider_dispatched_at'] loop
    if pg_catalog.has_column_privilege('authenticated', 'public.swing_analysis', v_col, 'SELECT') then
      raise exception 'A1: authenticated can read %', v_col;
    end if;
  end loop;
  if not pg_catalog.has_column_privilege('authenticated', 'public.swing_analysis', 'score', 'SELECT') then
    raise exception 'A1: authenticated cannot read score';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'public.swing_analysis', 'TRUNCATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.swing_analysis', 'DELETE')
     or pg_catalog.has_table_privilege('authenticated', 'public.swing_videos', 'DELETE')
     or pg_catalog.has_table_privilege('authenticated', 'public.swing_videos', 'TRUNCATE') then
    raise exception 'A1: a destructive privilege remains';
  end if;
  foreach v_col in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    if pg_catalog.has_table_privilege('anon', 'public.swing_analysis', v_col)
       or pg_catalog.has_table_privilege('anon', 'public.swing_videos', v_col)
       or pg_catalog.has_any_column_privilege('anon', 'public.swing_analysis', 'SELECT') then
      raise exception 'A1: anon holds % on an analysis table', v_col;
    end if;
  end loop;
  raise notice 'PASS A1 effective privileges (payload + lease columns, destructive, anon matrix)';
end;
$a1$;

-- ── A2. As the owner (authenticated, RLS applies) ───────────────────────────

set local role authenticated;
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"0a000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

do $a2$
declare
  v_count integer;
begin
  select count(*) into v_count
    from public.swing_analysis
   where id = '0b000000-0000-4000-8000-0000000000b1';
  if v_count <> 1 then
    raise exception 'A2: the owner cannot see their own analysis through the granted columns';
  end if;

  begin
    perform metrics from public.swing_analysis;
    raise exception 'A2: the owner could read metrics directly';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from public.swing_analysis;
    raise exception 'A2: select * succeeded on the session';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.swing_analysis where id = '0b000000-0000-4000-8000-0000000000b1';
    raise exception 'A2: the owner could delete their analysis';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.swing_videos where id = '0b000000-0000-4000-8000-0000000000b1';
    raise exception 'A2: the owner could delete their video';
  exception when insufficient_privilege then null;
  end;

  begin
    truncate public.swing_analysis;
    raise exception 'A2: truncate succeeded';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS A2 owner core read; metrics, select *, delete, truncate refused';
end;
$a2$;

-- ── A3. As another golfer ───────────────────────────────────────────────────

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"0a000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);

do $a3$
declare
  v_count integer;
begin
  select count(*) into v_count from public.swing_analysis where id = '0b000000-0000-4000-8000-0000000000b1';
  if v_count <> 0 then
    raise exception 'A3: another golfer can see the analysis';
  end if;
  raise notice 'PASS A3 cross-user isolation';
end;
$a3$;

reset role;
select pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);

-- ── A4. As anon ─────────────────────────────────────────────────────────────

set local role anon;
do $a4$
begin
  begin
    perform id from public.swing_analysis;
    raise exception 'A4: anon can select swing_analysis';
  exception when insufficient_privilege then null;
  end;
  begin
    perform id from public.swing_videos;
    raise exception 'A4: anon can select swing_videos';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS A4 anon refused on both tables';
end;
$a4$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── A5. Lease semantics (service role) ──────────────────────────────────────

-- Fixture: reopen the completed row as an operator would (the execution guard,
-- 20261027120000, keeps a completed status otherwise).
select pg_catalog.set_config('swingproai.execution_guard', 'operator_override:' || pg_catalog.txid_current(), true);
update public.swing_analysis set status = 'pending' where id = '0b000000-0000-4000-8000-0000000000b1';
select pg_catalog.set_config('swingproai.execution_guard', '', true);

set local role service_role;
do $a5$
declare
  v_rows integer;
begin

  -- Fresh claim succeeds once.
  update public.swing_analysis
     set status = 'processing', processing_claim_id = '0d000000-0000-4000-8000-0000000000c1',
         processing_started_at = now(), processing_heartbeat_at = now(), provider_dispatched_at = null
   where id = '0b000000-0000-4000-8000-0000000000b1' and user_id = '0a000000-0000-4000-8000-0000000000a1' and (analysis_family is null or analysis_family = 'full_swing') and status in ('pending', 'failed');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'A5: fresh claim did not take the row'; end if;

  -- A second fresh claim affects nothing.
  update public.swing_analysis set processing_claim_id = '0d000000-0000-4000-8000-0000000000c2'
   where id = '0b000000-0000-4000-8000-0000000000b1' and user_id = '0a000000-0000-4000-8000-0000000000a1' and (analysis_family is null or analysis_family = 'full_swing') and status in ('pending', 'failed');
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'A5: a second claim took a held row'; end if;

  -- A dispatched claim with an expired lease cannot be taken over.
  update public.swing_analysis
     set provider_dispatched_at = now() - interval '20 minutes', processing_heartbeat_at = now() - interval '20 minutes',
         processing_claim_proof = '0d000000-0000-4000-8000-0000000000c1'  -- the holder's proof (execution guard)
   where id = '0b000000-0000-4000-8000-0000000000b1';
  update public.swing_analysis set processing_claim_id = '0d000000-0000-4000-8000-0000000000c3'
   where id = '0b000000-0000-4000-8000-0000000000b1' and user_id = '0a000000-0000-4000-8000-0000000000a1' and (analysis_family is null or analysis_family = 'full_swing') and status = 'processing'
     and provider_dispatched_at is null and processing_heartbeat_at < now() - interval '900 seconds';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'A5: a dispatched claim was taken over'; end if;

  -- A stale holder's completion is fenced out.
  update public.swing_analysis set status = 'complete'
   where id = '0b000000-0000-4000-8000-0000000000b1' and user_id = '0a000000-0000-4000-8000-0000000000a1' and status = 'processing'
     and processing_claim_id = '0d000000-0000-4000-8000-0000000000c9';  -- a claim id that never held the row
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'A5: a stale holder completed the row'; end if;

  -- The coherence CHECK refuses a claim without its start. The write carries
  -- the holder's proof, so the execution guard admits it and the CHECK decides.
  begin
    update public.swing_analysis set processing_started_at = null, processing_claim_proof = '0d000000-0000-4000-8000-0000000000c1'
     where id = '0b000000-0000-4000-8000-0000000000b1';
    raise exception 'A5: the claim-shape CHECK accepted an incoherent claim';
  exception when check_violation then null;
  end;
  raise notice 'PASS A5 lease predicates and claim-shape CHECK';
end;
$a5$;
reset role;

rollback;

-- ============================================================================
-- Part B — concurrency (two sessions, manual; non-production only)
-- ============================================================================
--
-- B1. Fresh claim race. In sessions S1 and S2, as service_role, on a pending
--     row R:
--       S1: begin; update ... set status='processing', processing_claim_id=<c1>, ...
--             where id=R and status in ('pending','failed');   -- 1 row
--       S2: begin; update ... same with <c2> ...;                -- blocks on the row lock
--       S1: commit;
--       S2: (unblocks) -> must report 0 rows; commit.
--     Expect processing_claim_id = <c1>.
--
-- B2. Takeover race on an expired, undispatched claim: repeat B1 with both
--     sessions using the takeover predicate (status='processing' and
--     provider_dispatched_at is null and processing_heartbeat_at < cutoff).
--     Exactly one session reports 1 row.
--
-- B3. Dispatch vs takeover. S1 holds <c1> (expired, undispatched). S1 runs the
--     dispatch update (processing_claim_id=<c1> and provider_dispatched_at is
--     null) while S2 runs the takeover. Whichever commits first wins; the other
--     reports 0 rows. If S2 won, S1 must not call the provider.
--
-- B4. PostgREST end-to-end: through the REST endpoint with a real
--     authenticated JWT, select=* and select=metrics on swing_analysis must
--     return 401/42501; select=id,score,feedback must return the owner's row
--     only; DELETE on swing_analysis and swing_videos must be refused.
