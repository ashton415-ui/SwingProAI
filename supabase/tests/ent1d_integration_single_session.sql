-- ============================================================================
-- ENT-1D — supplementary single-session integration checks (local only)
-- ============================================================================
--
-- DISPOSABLE LOCAL STACK ONLY. Run with psql -v ON_ERROR_STOP=1 inside the
-- run's own database container. One transaction, rolled back. Every check
-- raises on failure; denials are asserted by SQLSTATE 42501
-- (insufficient_privilege, which includes RLS WITH CHECK refusals) or
-- check_violation, never by "any error". Each block emits a PASS notice.

begin;

insert into auth.users (id, email)
values ('0a000000-0000-4000-8000-0000000000a1', 'ent1d-owner@example.test'),
       ('0a000000-0000-4000-8000-0000000000a2', 'ent1d-other@example.test');

insert into public.swing_videos (id, user_id, status, storage_path, video_url)
values ('0b000000-0000-4000-8000-0000000000b1', '0a000000-0000-4000-8000-0000000000a1', 'uploaded',
        '0a000000-0000-4000-8000-0000000000a1/clip.mp4', '0a000000-0000-4000-8000-0000000000a1/clip.mp4');

insert into public.swing_analysis (id, swing_video_id, user_id, status, score, feedback, metrics, swing_highlights)
values ('0b000000-0000-4000-8000-0000000000b1', '0b000000-0000-4000-8000-0000000000b1',
        '0a000000-0000-4000-8000-0000000000a1', 'complete', 72, 'core summary',
        '{"drills":[{"name":"Chair drill"}]}', '[{"positive_movement":"Quiet head"}]');

-- ── S1. Owner (authenticated) ───────────────────────────────────────────────

set local role authenticated;
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"0a000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

do $s1$
declare
  v_score numeric;
  v_rows integer;
begin
  -- Core columns readable.
  select score into v_score from public.swing_analysis where id = '0b000000-0000-4000-8000-0000000000b1';
  if v_score is distinct from 72 then raise exception 'S1: owner cannot read core score'; end if;

  -- A restricted column in a filter is refused, not silently evaluated.
  begin
    perform id from public.swing_analysis where metrics is not null;
    raise exception 'S1: a filter on metrics was evaluated';
  exception when insufficient_privilege then null;
  end;
  begin
    perform id from public.swing_analysis order by provider_dispatched_at;
    raise exception 'S1: ordering by a lease column was evaluated';
  exception when insufficient_privilege then null;
  end;

  -- Client writes on swing_analysis are refused.
  begin
    update public.swing_analysis set score = 99 where id = '0b000000-0000-4000-8000-0000000000b1';
    raise exception 'S1: the owner could update swing_analysis';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.swing_analysis (id, swing_video_id, user_id) values
      ('0b000000-0000-4000-8000-0000000000b9', '0b000000-0000-4000-8000-0000000000b1', '0a000000-0000-4000-8000-0000000000a1');
    raise exception 'S1: the owner could insert into swing_analysis';
  exception when insufficient_privilege then null;
  end;

  -- swing_videos: the owner may insert their own upload row ...
  insert into public.swing_videos (id, user_id, status, storage_path, video_url)
  values ('0b000000-0000-4000-8000-0000000000b2', '0a000000-0000-4000-8000-0000000000a1', 'pending',
          '0a000000-0000-4000-8000-0000000000a1/second.mp4', '0a000000-0000-4000-8000-0000000000a1/second.mp4');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'S1: owner upload insert failed'; end if;

  -- ... but never one for another golfer (RLS WITH CHECK).
  begin
    insert into public.swing_videos (id, user_id, status, storage_path, video_url)
    values ('0b000000-0000-4000-8000-0000000000b3', '0a000000-0000-4000-8000-0000000000a2', 'pending',
            '0a000000-0000-4000-8000-0000000000a2/forged.mp4', '0a000000-0000-4000-8000-0000000000a2/forged.mp4');
    raise exception 'S1: the owner inserted a video for another golfer';
  exception when insufficient_privilege then null;
  end;

  -- swing_videos UPDATE and DELETE are refused.
  begin
    update public.swing_videos set status = 'uploaded' where id = '0b000000-0000-4000-8000-0000000000b2';
    raise exception 'S1: the owner could update swing_videos';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.swing_videos where id = '0b000000-0000-4000-8000-0000000000b2';
    raise exception 'S1: the owner could delete swing_videos';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate public.swing_videos;
    raise exception 'S1: truncate swing_videos succeeded';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS S1 owner: core read, restricted filters/order, writes, upload insert, forged owner, video update/delete/truncate';
end;
$s1$;

reset role;

-- ── S2. Another golfer ──────────────────────────────────────────────────────

set local role authenticated;
select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"0a000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);

do $s2$
declare
  v_count integer;
begin
  select count(*) into v_count from public.swing_videos where user_id = '0a000000-0000-4000-8000-0000000000a1';
  if v_count <> 0 then raise exception 'S2: another golfer sees the owner''s videos'; end if;
  select count(*) into v_count from public.swing_analysis where user_id = '0a000000-0000-4000-8000-0000000000a1';
  if v_count <> 0 then raise exception 'S2: another golfer sees the owner''s analysis'; end if;
  raise notice 'PASS S2 cross-user isolation (videos, analyses)';
end;
$s2$;

reset role;
select pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);

-- ── S3. anon ────────────────────────────────────────────────────────────────

set local role anon;
do $s3$
begin
  begin
    insert into public.swing_videos (id, user_id, status, storage_path, video_url)
    values ('0b000000-0000-4000-8000-0000000000b4', '0a000000-0000-4000-8000-0000000000a1', 'pending', 'x/y.mp4', '');
    raise exception 'S3: anon inserted a video';
  exception when insufficient_privilege then null;
  end;
  begin
    perform score from public.swing_analysis;
    raise exception 'S3: anon read a core column';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS S3 anon insert and read refused';
end;
$s3$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── S4. service_role keeps full server functionality ────────────────────────

set local role service_role;
do $s4$
declare
  v_metrics jsonb;
  v_rows integer;
  v_msg text;
  v_constraint text;
begin
  select metrics into v_metrics from public.swing_analysis where id = '0b000000-0000-4000-8000-0000000000b1';
  if v_metrics is null then raise exception 'S4: service_role cannot read the payload'; end if;

  insert into public.swing_analysis (id, swing_video_id, user_id)
  values ('0b000000-0000-4000-8000-0000000000b2', '0b000000-0000-4000-8000-0000000000b2', '0a000000-0000-4000-8000-0000000000a1');

  -- Application claim predicate (lib/analysis-execution-claim.ts fresh claim).
  update public.swing_analysis
     set status = 'processing', processing_claim_id = '0d000000-0000-4000-8000-0000000000c1',
         processing_started_at = now(), processing_heartbeat_at = now(), provider_dispatched_at = null
   where id = '0b000000-0000-4000-8000-0000000000b2' and user_id = '0a000000-0000-4000-8000-0000000000a1'
     and (analysis_family is null or analysis_family = 'full_swing')
     and status in ('pending', 'failed');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'S4: service_role claim failed'; end if;

  -- The holder records its dispatch before completing (the execution guard
  -- admits a completion only after a recorded dispatch).
  update public.swing_analysis set provider_dispatched_at = now(), processing_heartbeat_at = now(),
         processing_claim_proof = '0d000000-0000-4000-8000-0000000000c1'
   where id = '0b000000-0000-4000-8000-0000000000b2' and processing_claim_id = '0d000000-0000-4000-8000-0000000000c1'
     and provider_dispatched_at is null;
  update public.swing_analysis set status = 'complete', score = 80,
         processing_claim_proof = '0d000000-0000-4000-8000-0000000000c1'  -- the holder's proof (execution guard)
   where id = '0b000000-0000-4000-8000-0000000000b2' and user_id = '0a000000-0000-4000-8000-0000000000a1'
     and status = 'processing' and processing_claim_id = '0d000000-0000-4000-8000-0000000000c1';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'S4: service_role completion failed'; end if;

  delete from public.swing_analysis where id = '0b000000-0000-4000-8000-0000000000b2';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'S4: service_role delete failed'; end if;

  -- A lease without a start on a completed row is refused: by the execution
  -- guard (ENT1D-CLAIM-2: a completed analysis is never rewritten) once it is
  -- active, and by the claim-shape CHECK otherwise. Both are check_violation.
  begin
    update public.swing_analysis set processing_claim_id = '0d000000-0000-4000-8000-0000000000c2'
     where id = '0b000000-0000-4000-8000-0000000000b1';
    raise exception 'S4: a claim without a start was accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text, v_constraint = constraint_name;
    if v_msg not like 'ENT1D-CLAIM-2:%' and v_constraint is distinct from 'swing_analysis_processing_claim_shape' then
      raise exception 'S4: refused for an unexpected reason: %', v_msg;
    end if;
  end;
  raise notice 'PASS S4 service_role payload read, claim, completion, delete; claim-shape CHECK';
end;
$s4$;
reset role;

rollback;
