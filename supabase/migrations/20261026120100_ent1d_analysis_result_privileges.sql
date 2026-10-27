-- ============================================================================
-- ENT-1D (2 of 2) — analysis result privileges
-- ============================================================================
--
-- Why
-- ---
-- anon and authenticated still hold the baseline table grant on
-- public.swing_analysis minus INSERT and UPDATE: SELECT on every column,
-- DELETE, TRUNCATE, REFERENCES, TRIGGER and (PostgreSQL 17) MAINTAIN. So a
-- signed-in browser can read every stored result payload directly through
-- PostgREST — including premium putting envelopes after a downgrade — whatever
-- the server serializes; can delete its own analysis and re-request it for a
-- fresh model call; and, because TRUNCATE ignores row level security, could
-- empty the table for every golfer. public.swing_videos carries the same
-- destructive grants.
--
-- What this migration does
-- ------------------------
-- public.swing_analysis
--   Revokes every privilege from PUBLIC, anon and authenticated, at table
--   level and on every column, then grants authenticated SELECT on exactly the
--   identity and core-summary columns the application reads on a golfer's own
--   session (lib/analysis-result-read-authority.ts ANALYSIS_OWNER_COLUMNS):
--
--     id, swing_video_id, user_id, club_id, status, analysis_family,
--     equipment_snapshot, analysis_mode, created_at, score, feedback,
--     tempo_ratio, swing_speed_mph, spine_angle, hip_rotation,
--     shoulder_rotation
--
--   Everything else becomes server-only: the result payload (metrics,
--   swing_highlights, mechanical_deficiencies, putting_analysis,
--   putting_score), the columns with no producer or contract (putt_analytics,
--   launch_monitor_summary, fusion_notes, ai_equipment_recommendations, ...),
--   the execution lease, and any column added later. The owner RLS read
--   policy still decides which rows are visible.
--
-- public.swing_videos
--   Revokes every privilege from PUBLIC and anon, and DELETE, TRUNCATE,
--   REFERENCES, TRIGGER and (PostgreSQL 17) MAINTAIN from authenticated, which
--   keeps SELECT and INSERT for the owner upload flow under the existing RLS
--   policies. Deleting a video cascades to its analysis, so a retained DELETE
--   would reopen the delete-and-re-request path. Controlled deletion is a
--   future server workflow, not a browser grant.
--
-- service_role is untouched: every server read and write in ENT-1C/ENT-1D
-- goes through it. No policy, column, constraint, trigger, function or row is
-- changed.
--
-- PostgreSQL versions
-- -------------------
-- MAINTAIN exists from PostgreSQL 17. REVOKE ALL covers it where it exists;
-- every check below includes it only when server_version_num >= 170000.
-- Column privileges are revoked explicitly and proved absent, rather than
-- assumed to follow the table-level revoke. Effective privileges are proved
-- with has_*_privilege, which accounts for PUBLIC and inherited roles.
--
-- Deployment order (required)
-- ---------------------------
--   1. 20261026120000_ent1d_analysis_execution_lease  (additive)
--   2. deploy the ENT-1C + ENT-1D application
--   3. this migration
-- Applying this before step 2 breaks every build that still reads payload
-- columns on the golfer's session (select("*") pages, the putting
-- recommendation source read). The preflight refuses to run before step 1.
--
-- Rollback
-- --------
-- Security-preserving: no rollback restores payload SELECT, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER or MAINTAIN to browser roles. If the application must be
-- rolled back, roll back to an ENT-1C/ENT-1D-compatible build. If a new
-- consumer genuinely needs another non-payload column on the session, grant
-- that one column to authenticated in a reviewed migration.
--
-- This migration contains no transaction control; the runner owns the
-- transaction.

-- Accepted starting states
-- -------------------------
-- Exactly two browser-role starting profiles are accepted, and all four
-- (anon, authenticated) x (swing_analysis, swing_videos) sets must match the
-- SAME profile, without grant option:
--
--   production  the baseline grant minus the ARA INSERT/UPDATE revoke on
--               swing_analysis and the UPDATE revoke on swing_videos:
--                 swing_analysis  DELETE, MAINTAIN, REFERENCES, SELECT,
--                                 TRIGGER, TRUNCATE
--                 swing_videos    DELETE, INSERT, MAINTAIN, REFERENCES,
--                                 SELECT, TRIGGER, TRUNCATE
--   sec0a       the production profile after PRICING-2 SEC0A
--               (pricing2_sec0a_harden_seven_table_privileges, recorded on
--               the staging ledger only) revoked TRUNCATE, REFERENCES,
--               TRIGGER and MAINTAIN:
--                 swing_analysis  DELETE, SELECT
--                 swing_videos    DELETE, INSERT, SELECT
--
-- Any other set, a mix of profiles, a grant option, a table owner other than
-- postgres, a grantor other than the owner, a column-level privilege, a
-- membership of anon or authenticated in another role, a table grantee other
-- than the owner, anon, authenticated and service_role, or a superuser or
-- BYPASSRLS browser role fails closed. Both profiles end in the
-- identical state below; the postflight does not depend on the profile.

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

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed unless an exact accepted starting state is present.

do $preflight$
declare
  v_pg17 boolean := pg_catalog.current_setting('server_version_num')::integer >= 170000;
  v_profile text;
  v_browser_analysis text;
  v_browser_videos text;
  v_service text;
  v_rls_analysis boolean;
  v_rls_videos boolean;
  v_role text;
  v_set text;
  v_col text;
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'public.swing_analysis'::regclass
       and a.attname = 'processing_claim_id'
       and not a.attisdropped
  ) then
    raise exception 'ENT1D-PRIV-PRE-1: apply 20261026120000_ent1d_analysis_execution_lease (and deploy the ENT-1D application) first.';
  end if;

  select c.relrowsecurity into v_rls_analysis from pg_catalog.pg_class c where c.oid = 'public.swing_analysis'::regclass;
  select c.relrowsecurity into v_rls_videos from pg_catalog.pg_class c where c.oid = 'public.swing_videos'::regclass;
  if not coalesce(v_rls_analysis, false) or not coalesce(v_rls_videos, false) then
    raise exception 'ENT1D-PRIV-PRE-2: row level security must be enabled on public.swing_analysis and public.swing_videos.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy p
     where p.polrelid = 'public.swing_analysis'::regclass and p.polcmd = 'r'
  ) then
    raise exception 'ENT1D-PRIV-PRE-3: public.swing_analysis has no SELECT policy; owner reads would be refused.';
  end if;

  foreach v_col in array array[
    'id', 'swing_video_id', 'user_id', 'club_id', 'status', 'analysis_family',
    'equipment_snapshot', 'analysis_mode', 'created_at', 'score', 'feedback',
    'tempo_ratio', 'swing_speed_mph', 'spine_angle', 'hip_rotation', 'shoulder_rotation'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
       where a.attrelid = 'public.swing_analysis'::regclass and a.attname = v_col and not a.attisdropped
    ) then
      raise exception 'ENT1D-PRIV-PRE-4: public.swing_analysis.% is missing.', v_col;
    end if;
  end loop;

  v_service := case when v_pg17
    then 'DELETE:false,INSERT:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false,UPDATE:false'
    else 'DELETE:false,INSERT:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false,UPDATE:false' end;

  -- The profile is chosen once, from anon on swing_analysis, and every other
  -- set must then match that same profile. (No CASE inside an IF condition:
  -- the Supabase CLI statement splitter mis-ends the DO block on that shape.)
  v_browser_analysis := case when v_pg17
    then 'DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false'
    else 'DELETE:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false' end;
  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_set
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.swing_analysis'::regclass and x.grantee = 'anon'::regrole;
  if v_set = v_browser_analysis then
    v_profile := 'production';
    v_browser_videos := case when v_pg17
      then 'DELETE:false,INSERT:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false'
      else 'DELETE:false,INSERT:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false' end;
  elsif v_set = 'DELETE:false,SELECT:false' then
    v_profile := 'sec0a';
    v_browser_analysis := v_set;
    v_browser_videos := 'DELETE:false,INSERT:false,SELECT:false';
  else
    raise exception 'ENT1D-PRIV-PRE-5: anon privileges on public.swing_analysis are % (expected the production or sec0a profile).', v_set;
  end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
      into v_set
      from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid = 'public.swing_analysis'::regclass and x.grantee = v_role::regrole;
    if v_set <> v_browser_analysis then
      raise exception 'ENT1D-PRIV-PRE-5: % privileges on public.swing_analysis are % (expected % profile %).', v_role, v_set, v_profile, v_browser_analysis;
    end if;

    select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
      into v_set
      from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid = 'public.swing_videos'::regclass and x.grantee = v_role::regrole;
    if v_set <> v_browser_videos then
      raise exception 'ENT1D-PRIV-PRE-6: % privileges on public.swing_videos are % (expected % profile %).', v_role, v_set, v_profile, v_browser_videos;
    end if;
  end loop;

  foreach v_col in array array['public.swing_analysis', 'public.swing_videos'] loop
    select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
      into v_set
      from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid = v_col::regclass and x.grantee = 'service_role'::regrole;
    if v_set <> v_service then
      raise exception 'ENT1D-PRIV-PRE-7: service_role privileges on % are % (expected %).', v_col, v_set, v_service;
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass) and x.grantee = 0
  ) then
    raise exception 'ENT1D-PRIV-PRE-8: PUBLIC holds a table privilege on public.swing_analysis or public.swing_videos.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c
     where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
       and c.relowner <> 'postgres'::regrole
  ) or exists (
    select 1 from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass) and x.grantor <> c.relowner
  ) then
    raise exception 'ENT1D-PRIV-PRE-9: public.swing_analysis or public.swing_videos is not owned by postgres, or a table privilege was granted by a role other than the owner.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x
     where a.attrelid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
       and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'ENT1D-PRIV-PRE-10: public.swing_analysis or public.swing_videos carries column-level privileges.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_auth_members m
     where m.member in ('anon'::regrole, 'authenticated'::regrole)
  ) then
    raise exception 'ENT1D-PRIV-PRE-11: anon or authenticated is a member of another role.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
       and x.grantee not in (c.relowner, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
  ) then
    raise exception 'ENT1D-PRIV-PRE-12: public.swing_analysis or public.swing_videos has a table grantee other than its owner, anon, authenticated and service_role.';
  end if;

  -- Row level security is what limits the columns authenticated keeps to the
  -- golfer's own rows; a browser role that bypasses it is not a known state.
  if exists (
    select 1 from pg_catalog.pg_roles r
     where r.rolname in ('anon', 'authenticated') and (r.rolsuper or r.rolbypassrls)
  ) then
    raise exception 'ENT1D-PRIV-PRE-13: anon or authenticated is a superuser or bypasses row level security.';
  end if;
end;
$preflight$;

-- ── Table-level revokes ─────────────────────────────────────────────────────

revoke all privileges on table public.swing_analysis from public, anon, authenticated;

revoke all privileges on table public.swing_videos from public, anon;

revoke delete, truncate, references, trigger on table public.swing_videos from authenticated;

do $maintain$
begin
  if pg_catalog.current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on table public.swing_videos from authenticated';
  end if;
end;
$maintain$;

-- ── Column-level revokes ────────────────────────────────────────────────────
-- Any column privilege a browser role or PUBLIC holds on either table is
-- revoked explicitly, whatever the table-level revoke did with it.

do $columns$
declare
  r record;
begin
  for r in
    select c.relname, a.attname, x.privilege_type,
           case when x.grantee = 0 then 'public' else pg_catalog.quote_ident(g.rolname) end as grantee
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      cross join lateral pg_catalog.aclexplode(a.attacl) x
      left join pg_catalog.pg_roles g on g.oid = x.grantee
     where n.nspname = 'public'
       and c.relname in ('swing_analysis', 'swing_videos')
       and a.attnum > 0 and not a.attisdropped
       and (x.grantee = 0 or g.rolname in ('anon', 'authenticated'))
  loop
    execute pg_catalog.format(
      'revoke %s (%I) on table public.%I from %s',
      r.privilege_type, r.attname, r.relname, r.grantee
    );
  end loop;
end;
$columns$;

-- ── The owner-readable columns ──────────────────────────────────────────────

grant select (
  id, swing_video_id, user_id, club_id, status, analysis_family,
  equipment_snapshot, analysis_mode, created_at, score, feedback,
  tempo_ratio, swing_speed_mph, spine_angle, hip_rotation, shoulder_rotation
) on table public.swing_analysis to authenticated;

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the exact resulting state, effective privileges included.

do $postflight$
declare
  v_pg17 boolean := pg_catalog.current_setting('server_version_num')::integer >= 170000;
  v_privs text[];
  v_role text;
  v_priv text;
  v_col text;
  v_set text;
  v_owner_cols text[] := array[
    'id', 'swing_video_id', 'user_id', 'club_id', 'status', 'analysis_family',
    'equipment_snapshot', 'analysis_mode', 'created_at', 'score', 'feedback',
    'tempo_ratio', 'swing_speed_mph', 'spine_angle', 'hip_rotation', 'shoulder_rotation'
  ];
begin
  v_privs := array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  if v_pg17 then
    v_privs := pg_catalog.array_append(v_privs, 'MAINTAIN');
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.swing_analysis'::regclass)
     or not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.swing_videos'::regclass) then
    raise exception 'ENT1D-PRIV-POST-1: row level security is no longer enabled.';
  end if;

  -- No table-level ACL entry for a browser role or PUBLIC on swing_analysis.
  if exists (
    select 1 from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid = 'public.swing_analysis'::regclass
       and (x.grantee = 0 or x.grantee in ('anon'::regrole, 'authenticated'::regrole))
  ) then
    raise exception 'ENT1D-PRIV-POST-2: a browser role or PUBLIC still holds a table privilege on public.swing_analysis.';
  end if;

  -- Column ACLs on swing_analysis: authenticated SELECT on exactly the owner
  -- columns, without grant option; nothing for anon or PUBLIC.
  select coalesce(string_agg(a.attname || ':' || x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by a.attname), '')
    into v_set
    from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x
   where a.attrelid = 'public.swing_analysis'::regclass and a.attnum > 0 and not a.attisdropped
     and (x.grantee = 0 or x.grantee in ('anon'::regrole, 'authenticated'::regrole));
  if v_set <> (
    select string_agg(c || ':SELECT:false', ',' order by c)
      from pg_catalog.unnest(v_owner_cols) as c
  ) then
    raise exception 'ENT1D-PRIV-POST-3: browser column privileges on public.swing_analysis are %.', v_set;
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x
     where a.attrelid = 'public.swing_analysis'::regclass and a.attnum > 0 and not a.attisdropped
       and x.grantee = 'authenticated'::regrole
       and a.attname::text <> all (v_owner_cols)
  ) then
    raise exception 'ENT1D-PRIV-POST-4: authenticated holds a privilege on a server-only swing_analysis column.';
  end if;

  -- Effective privileges, PUBLIC and inherited roles included.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array v_privs loop
      if pg_catalog.has_table_privilege(v_role, 'public.swing_analysis', v_priv) then
        raise exception 'ENT1D-PRIV-POST-5: % holds % on public.swing_analysis.', v_role, v_priv;
      end if;
      if v_priv <> 'INSERT' and pg_catalog.has_table_privilege(v_role, 'public.swing_videos', v_priv) then
        raise exception 'ENT1D-PRIV-POST-6: % holds % on public.swing_videos.', v_role, v_priv;
      end if;
    end loop;
    if pg_catalog.has_table_privilege(v_role, 'public.swing_analysis', 'SELECT') then
      raise exception 'ENT1D-PRIV-POST-7: % holds table-level SELECT on public.swing_analysis.', v_role;
    end if;
    if pg_catalog.has_any_column_privilege(v_role, 'public.swing_analysis', 'INSERT')
       or pg_catalog.has_any_column_privilege(v_role, 'public.swing_analysis', 'UPDATE') then
      raise exception 'ENT1D-PRIV-POST-8: % can write a swing_analysis column.', v_role;
    end if;
  end loop;

  foreach v_col in array (
    select array_agg(a.attname::text)
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.swing_analysis'::regclass and a.attnum > 0 and not a.attisdropped
  ) loop
    if pg_catalog.has_column_privilege('anon', 'public.swing_analysis', v_col, 'SELECT') then
      raise exception 'ENT1D-PRIV-POST-9: anon can read public.swing_analysis.%.', v_col;
    end if;
    if pg_catalog.has_column_privilege('authenticated', 'public.swing_analysis', v_col, 'SELECT')
       <> (v_col = any (v_owner_cols)) then
      raise exception 'ENT1D-PRIV-POST-10: authenticated SELECT on public.swing_analysis.% is not as specified.', v_col;
    end if;
  end loop;

  -- swing_videos: authenticated keeps exactly SELECT and INSERT; anon nothing.
  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_set
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.swing_videos'::regclass and x.grantee = 'authenticated'::regrole;
  if v_set <> 'INSERT:false,SELECT:false' then
    raise exception 'ENT1D-PRIV-POST-11: authenticated privileges on public.swing_videos are % (expected INSERT:false,SELECT:false).', v_set;
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
     where c.oid = 'public.swing_videos'::regclass and (x.grantee = 0 or x.grantee = 'anon'::regrole)
  ) or exists (
    select 1 from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x
     where a.attrelid = 'public.swing_videos'::regclass and a.attnum > 0 and not a.attisdropped
       and (x.grantee = 0 or x.grantee in ('anon'::regrole, 'authenticated'::regrole))
  ) then
    raise exception 'ENT1D-PRIV-POST-12: PUBLIC or anon holds a privilege on public.swing_videos, or a browser column grant remains.';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.swing_videos', 'SELECT')
     or pg_catalog.has_table_privilege('anon', 'public.swing_videos', 'INSERT') then
    raise exception 'ENT1D-PRIV-POST-13: anon can read or insert public.swing_videos.';
  end if;

  -- The server keeps everything it needs.
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not pg_catalog.has_table_privilege('service_role', 'public.swing_analysis', v_priv)
       or not pg_catalog.has_table_privilege('service_role', 'public.swing_videos', v_priv) then
      raise exception 'ENT1D-PRIV-POST-14: service_role lost % on swing_analysis or swing_videos.', v_priv;
    end if;
  end loop;
end;
$postflight$;
