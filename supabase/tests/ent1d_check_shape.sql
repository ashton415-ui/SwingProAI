-- ============================================================================
-- ENT-1D — claim-shape CHECK probe (DISPOSABLE LOCAL STACK ONLY)
-- ============================================================================
--
-- Run with psql inside the run's own database container. One transaction,
-- rolled back. Records which partial lease clears the CHECK refuses and which
-- it accepts, so the R1 correction's "clear all four together" and the rule
-- "never clear a dispatch" are each traced to what actually enforces them.
-- Each line is a NOTICE: CHECK_SHAPE <case> : <refused|accepted>.

begin;
insert into auth.users (id, email) values ('0a000000-0000-4000-8000-0000000000c9', 'ent1d-check@example.test');
insert into public.swing_videos (id, user_id, status, storage_path, video_url)
values ('0b000000-0000-4000-8000-0000000000c9', '0a000000-0000-4000-8000-0000000000c9', 'uploaded', 'x', '');
insert into public.swing_analysis (id, swing_video_id, user_id)
values ('0b000000-0000-4000-8000-0000000000c9', '0b000000-0000-4000-8000-0000000000c9', '0a000000-0000-4000-8000-0000000000c9');
set role service_role;
update public.swing_analysis
   set status = 'processing', processing_claim_id = gen_random_uuid(), processing_started_at = now(),
       processing_heartbeat_at = now(), provider_dispatched_at = now()
 where id = '0b000000-0000-4000-8000-0000000000c9';

do $c$
declare
  c text;
begin
  foreach c in array array['processing_claim_id', 'processing_started_at', 'processing_heartbeat_at', 'provider_dispatched_at'] loop
    begin
      execute format('update public.swing_analysis set status = ''failed'', %I = null where id = ''0b000000-0000-4000-8000-0000000000c9''', c);
      raise notice 'CHECK_SHAPE clearing only % : accepted', c;
      raise exception using errcode = 'P0001', message = 'undo';
    exception
      when check_violation then raise notice 'CHECK_SHAPE clearing only % : refused', c;
      when raise_exception then null;
    end;
  end loop;
  update public.swing_analysis
     set status = 'failed', processing_claim_id = null, processing_started_at = null,
         processing_heartbeat_at = null, provider_dispatched_at = null
   where id = '0b000000-0000-4000-8000-0000000000c9';
  raise notice 'CHECK_SHAPE clearing all four together : accepted';
end;
$c$;

rollback;
