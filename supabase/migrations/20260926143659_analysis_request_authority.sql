-- ============================================================================
-- Analysis request authority — server-authoritative swing_analysis writes
-- ============================================================================
--
-- Makes the creation of an analysis request, and every status or result on it,
-- a server statement rather than something a signed-in browser or native
-- client can author directly.
--
-- What this migration does
-- ------------------------
-- 1. Revokes INSERT and UPDATE on public.swing_analysis from anon and
--    authenticated. Requests are created only by POST /api/v1/analyses, after
--    it has authenticated the caller and proved ownership, readiness, club and
--    entitlement; status and results are written only by the server-only
--    trusted writer in the analysis route. Without this, a golfer could create
--    requests that skip those checks, or write their own score, feedback,
--    metrics or status through PostgREST.
-- 2. Enforces one analysis per swing video with a unique index on
--    public.swing_analysis(swing_video_id). It refuses to run if duplicates
--    already exist: it never deletes, merges or picks a winner.
-- 3. Revokes UPDATE on public.swing_videos from anon and authenticated. No live
--    product path edits a video after creation, and the analysis request route
--    relies on status and storage_path meaning what they meant when the row
--    was created.
--
-- What this migration does NOT do
-- -------------------------------
-- It changes no RLS policy, creates no function, adds no trigger and rewrites
-- no row. SELECT and owner DELETE on swing_analysis, and INSERT, SELECT and
-- owner DELETE on swing_videos, are left exactly as they were. The trusted
-- server writer runs as service_role, which none of these revokes touch.

begin;

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed on a divergent database rather than adapting to it.

do $preflight$
begin
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis' and c.relkind = 'r'
  ) then
    raise exception 'ARA-PRE-1: public.swing_analysis is missing.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_videos' and c.relkind = 'r'
  ) then
    raise exception 'ARA-PRE-2: public.swing_videos is missing.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis_swing_video_id_unique_idx'
  ) then
    raise exception 'ARA-PRE-3: swing_analysis_swing_video_id_unique_idx already exists.';
  end if;
end;
$preflight$;

-- ── Direct client writes ────────────────────────────────────────────────────

revoke insert, update on table public.swing_analysis from anon, authenticated;

revoke update on table public.swing_videos from anon, authenticated;

-- ── One analysis per swing video ────────────────────────────────────────────
-- Writes are held off while duplicates are checked and the index is built, so
-- the check and the constraint describe the same table state.

lock table public.swing_analysis in share row exclusive mode;

do $duplicates$
declare
  v_duplicate_videos bigint;
begin
  select count(*) into v_duplicate_videos
    from (
      select swing_video_id
        from public.swing_analysis
       where swing_video_id is not null
       group by swing_video_id
      having count(*) > 1
    ) as duplicates;

  if v_duplicate_videos > 0 then
    raise exception 'ARA-DUP-1: % swing video(s) already have more than one analysis; refusing to enforce uniqueness over existing duplicates. Resolve them explicitly before applying this migration.', v_duplicate_videos;
  end if;
end;
$duplicates$;

create unique index swing_analysis_swing_video_id_unique_idx
  on public.swing_analysis (swing_video_id);

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the resulting privileges rather than assuming the statements above
-- had the intended effect, including through any column-level grant.

do $postflight$
begin
  if pg_catalog.has_any_column_privilege('anon', 'public.swing_analysis', 'INSERT')
     or pg_catalog.has_any_column_privilege('authenticated', 'public.swing_analysis', 'INSERT') then
    raise exception 'ARA-POST-1: a browser role can still INSERT into public.swing_analysis.';
  end if;

  if pg_catalog.has_any_column_privilege('anon', 'public.swing_analysis', 'UPDATE')
     or pg_catalog.has_any_column_privilege('authenticated', 'public.swing_analysis', 'UPDATE') then
    raise exception 'ARA-POST-2: a browser role can still UPDATE public.swing_analysis.';
  end if;

  if pg_catalog.has_any_column_privilege('anon', 'public.swing_videos', 'UPDATE')
     or pg_catalog.has_any_column_privilege('authenticated', 'public.swing_videos', 'UPDATE') then
    raise exception 'ARA-POST-3: a browser role can still UPDATE public.swing_videos.';
  end if;

  if not pg_catalog.has_table_privilege('authenticated', 'public.swing_analysis', 'SELECT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.swing_analysis', 'DELETE') then
    raise exception 'ARA-POST-4: authenticated SELECT/DELETE on public.swing_analysis must be unchanged.';
  end if;

  if not pg_catalog.has_table_privilege('authenticated', 'public.swing_videos', 'INSERT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.swing_videos', 'SELECT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.swing_videos', 'DELETE') then
    raise exception 'ARA-POST-5: authenticated INSERT/SELECT/DELETE on public.swing_videos must be unchanged.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_index i
      join pg_catalog.pg_class ic on ic.oid = i.indexrelid
      join pg_catalog.pg_class tc on tc.oid = i.indrelid
      join pg_catalog.pg_namespace n on n.oid = tc.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = tc.oid and a.attnum = i.indkey[0]
     where n.nspname = 'public' and tc.relname = 'swing_analysis'
       and ic.relname = 'swing_analysis_swing_video_id_unique_idx'
       and i.indisunique and i.indnkeyatts = 1 and a.attname = 'swing_video_id'
  ) then
    raise exception 'ARA-POST-6: the unique index on public.swing_analysis(swing_video_id) is missing or malformed.';
  end if;
end;
$postflight$;

commit;
