-- ============================================================================
-- ENT-1D (4 of 4) — owner-bound swing video source guard
-- ============================================================================
--
-- Why
-- ---
-- Every upload flow writes its own swing_videos row, and the insert policy
-- checks only that user_id is the caller. storage_path and video_url were
-- therefore whatever the client sent: a key in another golfer's folder, or a
-- URL the server would later have fetched. The application no longer reads
-- video_url as a source at all and re-validates storage_path at every use
-- (lib/swing-video-source.ts); this guard makes new and changed rows
-- canonical, so the stored value is right as well as never trusted.
--
-- The rule (BEFORE INSERT OR UPDATE on public.swing_videos, all roles)
-- --------------------------------------------------------------------
--   storage_path  a canonical key in the row owner's folder of the
--                 swing-videos bucket:
--                   <user_id>/<file>  or  <user_id>/<uuid>/<file>
--                 user_id exactly as stored; uuid 8-4-4-4-12 hex, either case;
--                 file 1-255 of [A-Za-z0-9._-], not "." or "..".
--                 Nothing is decoded or normalised; anything else is refused.
--   video_url     equal to storage_path. It is metadata, never a source; a
--                 signed URL is minted on demand, never stored.
--
-- Matches lib/swing-video-source.ts parseOwnedSwingVideoPath, and every
-- working upload flow: the analyze page and the V1 upload routes write
-- <user>/<uuid>/<file> with video_url = storage_path, and the legacy server
-- action writes <user>/<millis>_<file> (it now records video_url = key). All of
-- them build the file name with canonicalUploadFileName before uploading, so
-- the rule never refuses a row whose object is already in Storage.
-- /api/v1/swing-data inserts storage_path '' with no video_url; that insert
-- already failed before this rule (video_url is NOT NULL) and is refused here.
--
-- Object existence is a separate question, answered by Storage where an
-- analysis is requested (/api/v1/analyses). This rule never consults
-- storage.objects: no cross-service transaction is assumed.
--
-- Historical rows (compatibility policy)
-- --------------------------------------
-- Nothing is deleted, rewritten or backfilled. A row that predates this guard
-- and is not canonical keeps working for every write that leaves storage_path,
-- video_url and user_id unchanged; it simply has no video source: the
-- application refuses to sign or download a non-canonical key, so it has no
-- inline analysis video and no replay. The preflight reports how many there
-- are; the diagnostic query is in docs/ENT1D_ROLLOUT_NOTES.md.
--
-- RLS and grants are unchanged. public.ent1d_is_canonical_swing_video_key is
-- IMMUTABLE, SECURITY INVOKER, with an empty search_path; it is executable by
-- authenticated and service_role because their inserts evaluate it.
--
-- Prerequisite: the application that writes canonical rows (every upload flow
-- as of ENT-1D) is deployed, and older instances drained; an older server
-- action wrote a public URL into video_url and would now be refused.
--
-- Rollback: drop the trigger and both functions. That only removes the rule;
-- no data was changed.
--
-- This migration contains no transaction control; the runner owns the
-- transaction.

-- ── Lock timeout ─────────────────────────────────────────────────────────────
-- Each lock request below waits at most 3 s. A timeout aborts the runner's
-- transaction with SQLSTATE 55P03, nothing in this file is applied, and the
-- file is safe to retry. SET LOCAL ends with that transaction and never
-- changes the session or role defaults. Outside a transaction SET LOCAL does
-- nothing, so the check below refuses to continue unless the limit is active.

set local lock_timeout = '3s';

do $lock_timeout$
begin
  if pg_catalog.current_setting('lock_timeout') <> '3s' then
    raise exception 'ENT1D-LOCK-TIMEOUT: lock_timeout is %, expected 3s; apply this file inside one transaction.',
      pg_catalog.current_setting('lock_timeout');
  end if;
end;
$lock_timeout$;

do $preflight$
begin
  if (select count(*) from pg_catalog.pg_attribute
       where attrelid = 'public.swing_videos'::regclass and not attisdropped
         and ((attname = 'user_id' and atttypid = 'uuid'::regtype)
           or (attname = 'storage_path' and atttypid = 'text'::regtype)
           or (attname = 'video_url' and atttypid = 'text'::regtype))) <> 3 then
    raise exception 'ENT1D-VIDEO-PRE-1: public.swing_videos does not have the expected user_id, storage_path and video_url columns.';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.swing_videos'::regclass) then
    raise exception 'ENT1D-VIDEO-PRE-2: row level security must be enabled on public.swing_videos.';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger
              where tgrelid = 'public.swing_videos'::regclass and tgname = 'swing_videos_source_guard')
     or pg_catalog.to_regprocedure('public.ent1d_is_canonical_swing_video_key(text, uuid)') is not null
     or pg_catalog.to_regprocedure('public.ent1d_swing_videos_source_guard()') is not null then
    raise exception 'ENT1D-VIDEO-PRE-3: the swing video source guard already exists.';
  end if;
end;
$preflight$;

create function public.ent1d_is_canonical_swing_video_key(p_key text, p_owner uuid)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $fn$
  select p_key is not null and p_owner is not null
     and p_key ~ ('^' || p_owner::text
                  || '/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)?[A-Za-z0-9._-]{1,255}$')
     and pg_catalog.reverse(pg_catalog.split_part(pg_catalog.reverse(p_key), '/', 1)) not in ('.', '..')
$fn$;

revoke all on function public.ent1d_is_canonical_swing_video_key(text, uuid) from public, anon;
grant execute on function public.ent1d_is_canonical_swing_video_key(text, uuid) to authenticated, service_role;

create function public.ent1d_swing_videos_source_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if tg_op = 'UPDATE'
     and new.storage_path is not distinct from old.storage_path
     and new.video_url is not distinct from old.video_url
     and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  if not public.ent1d_is_canonical_swing_video_key(new.storage_path, new.user_id) then
    raise exception using errcode = '23514',
      message = 'ENT1D-VIDEO-1: storage_path must be a canonical key in the owner''s swing-videos folder.';
  end if;
  if new.video_url is distinct from new.storage_path then
    raise exception using errcode = '23514',
      message = 'ENT1D-VIDEO-2: video_url must equal storage_path; it is metadata, never a source.';
  end if;
  return new;
end;
$fn$;

revoke all on function public.ent1d_swing_videos_source_guard() from public, anon, authenticated, service_role;

create trigger swing_videos_source_guard
  before insert or update on public.swing_videos
  for each row execute function public.ent1d_swing_videos_source_guard();

do $postflight$
declare
  v_check oid := pg_catalog.to_regprocedure('public.ent1d_is_canonical_swing_video_key(text, uuid)');
  v_guard oid := pg_catalog.to_regprocedure('public.ent1d_swing_videos_source_guard()');
  v_owner uuid := '0a000000-0000-4000-8000-000000000001';
  v_count bigint;
begin
  if exists (select 1 from pg_catalog.pg_proc
              where oid in (v_check, v_guard) and (prosecdef or proconfig is distinct from array['search_path=""'])) then
    raise exception 'ENT1D-VIDEO-POST-1: guard functions must be SECURITY INVOKER with an empty search_path.';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgrelid = 'public.swing_videos'::regclass and tgname = 'swing_videos_source_guard'
                    and tgfoid = v_guard and tgenabled = 'O'
                    and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 4) = 4 and (tgtype & 16) = 16) then
    raise exception 'ENT1D-VIDEO-POST-2: swing_videos_source_guard is not an enabled BEFORE INSERT OR UPDATE row trigger.';
  end if;
  if pg_catalog.has_function_privilege('anon', v_check, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_check, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_guard, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', v_check, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_check, 'EXECUTE') then
    raise exception 'ENT1D-VIDEO-POST-3: guard function EXECUTE privileges are not exactly as intended.';
  end if;
  -- Self-test of the key rule (no table access).
  if not public.ent1d_is_canonical_swing_video_key(v_owner::text || '/0b000000-0000-4000-8000-000000000001/clip.mp4', v_owner)
     or not public.ent1d_is_canonical_swing_video_key(v_owner::text || '/1793000000000_clip.mov', v_owner)
     or public.ent1d_is_canonical_swing_video_key('0a000000-0000-4000-8000-000000000002/clip.mp4', v_owner)
     or public.ent1d_is_canonical_swing_video_key(v_owner::text || '/../x.mp4', v_owner)
     or public.ent1d_is_canonical_swing_video_key(v_owner::text || '/..', v_owner)
     or public.ent1d_is_canonical_swing_video_key('https://example.invalid/' || v_owner::text || '/x.mp4', v_owner)
     or public.ent1d_is_canonical_swing_video_key(v_owner::text || '/x.mp4' || chr(10), v_owner) then
    raise exception 'ENT1D-VIDEO-POST-4: the canonical key rule self-test failed.';
  end if;
  select count(*) into v_count from public.swing_videos
   where not public.ent1d_is_canonical_swing_video_key(storage_path, user_id) or video_url is distinct from storage_path;
  raise notice 'ENT1D-VIDEO-DIAG: % existing swing_videos row(s) are not canonical (kept unchanged; never a video source).', v_count;
end;
$postflight$;
