-- ============================================================================
-- EQ5F-E — versioned putting score persistence
-- ============================================================================
--
-- Adds public.swing_analysis.putting_score (jsonb, nullable, no default) and the
-- guard that protects it. Nothing else is touched: no existing column, no
-- policy, no grant, no historical row.
--
-- What the guard is for
-- ---------------------
-- The analysis route runs as the signed-in golfer. Under the table's existing
-- RLS an owner may update their own row, so a new column would by default be
-- authorable from a browser. A putting score is a server-derived statement
-- about a stroke, not a user-supplied field, so the database refuses a first
-- write that did not come from the trusted server role.
--
-- PostgREST impersonates the request's database role, so a signed-in request
-- executes as `authenticated` and the server-only service-role client executes
-- as `service_role`; `current_user` reports whichever one is in force. That
-- platform behaviour is the release-managed premise of this guard. It is
-- asserted here as source and is exercised for real by the separate staging
-- database gate — this migration does not and cannot prove it by itself.
--
-- What the guard is NOT
-- ---------------------
-- It does not compute, re-derive or second-guess the score. There is no point
-- mapping, no classification table and no arithmetic here. lib/putting-score-
-- eq5f-d.ts owns the algorithm; this file validates the shape of what was
-- stored and who stored it, so a future v2 is a TypeScript change plus a new
-- version, not a rewrite of SQL that quietly disagrees with it.

begin;

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed on a divergent database rather than adapting to it. Each object
-- this migration owns must be absent, and the table it extends must be present.

do $preflight$
begin
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis' and c.relkind = 'r'
  ) then
    raise exception 'EQ5FE-PRE-1: public.swing_analysis is missing.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis'
       and a.attname = 'putting_score' and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'EQ5FE-PRE-2: public.swing_analysis.putting_score already exists.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'guard_swing_analysis_putting_score'
  ) then
    raise exception 'EQ5FE-PRE-3: public.guard_swing_analysis_putting_score() already exists.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'swing_analysis'
       and t.tgname = 'swing_analysis_guard_putting_score' and not t.tgisinternal
  ) then
    raise exception 'EQ5FE-PRE-4: trigger swing_analysis_guard_putting_score already exists.';
  end if;
end;
$preflight$;

-- ── Column ──────────────────────────────────────────────────────────────────
-- Nullable, no default, no backfill. Every row written before this migration
-- keeps a NULL score, which is the correct historical answer: those analyses
-- were never scored, and inventing a number for them now would be a claim the
-- evidence does not support.

alter table public.swing_analysis
  add column putting_score jsonb;

-- ── Guard ───────────────────────────────────────────────────────────────────

create function public.guard_swing_analysis_putting_score()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_keys text[];
  v_coverage jsonb;
  v_coverage_keys text[];
  v_score jsonb;
  v_scorable integer;
  v_percent integer;
begin
  -- An unchanged value is not a write. The column appearing in an UPDATE
  -- statement must never be enough to fail one.
  if new.putting_score is not distinct from old.putting_score then
    return new;
  end if;

  -- Write-once, for every role including the trusted one. Replacement,
  -- clearing, an altered v1 and a future v2 on a historical row are all the
  -- same mistake: a score already told a golfer something, and changing it
  -- silently rewrites what they were told.
  if old.putting_score is not null then
    raise exception 'EQ5F-E: swing_analysis.putting_score is write-once and cannot be changed once recorded.';
  end if;

  -- old is null and the value changed, so this is the first write.
  if new.putting_score is null then
    return new;
  end if;

  -- Server authorship. The score is derived by the server from validated
  -- evidence; a golfer's own session may not author one for their own row.
  if current_user::text <> 'service_role' then
    raise exception 'EQ5F-E: swing_analysis.putting_score may only be authored by the trusted server role.';
  end if;

  if new.analysis_family is distinct from 'putting' then
    raise exception 'EQ5F-E: swing_analysis.putting_score is valid only on a putting analysis.';
  end if;

  if jsonb_typeof(new.putting_score) <> 'object' then
    raise exception 'EQ5F-E: swing_analysis.putting_score must be a JSON object.';
  end if;

  select array_agg(k order by k) into v_keys
    from jsonb_object_keys(new.putting_score) as k;

  if v_keys is distinct from
     array['basis', 'coverage', 'score', 'score_version', 'source_classification_version']::text[] then
    raise exception 'EQ5F-E: swing_analysis.putting_score has an unexpected key set.';
  end if;

  if (new.putting_score -> 'score_version') is distinct from '1'::jsonb then
    raise exception 'EQ5F-E: swing_analysis.putting_score.score_version must be 1.';
  end if;

  if (new.putting_score -> 'source_classification_version') is distinct from '1'::jsonb then
    raise exception 'EQ5F-E: swing_analysis.putting_score.source_classification_version must be 1.';
  end if;

  if (new.putting_score -> 'basis') is distinct from '"qualitative_classification_index"'::jsonb then
    raise exception 'EQ5F-E: swing_analysis.putting_score.basis is not the accepted basis.';
  end if;

  v_coverage := new.putting_score -> 'coverage';

  if jsonb_typeof(v_coverage) <> 'object' then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage must be a JSON object.';
  end if;

  select array_agg(k order by k) into v_coverage_keys
    from jsonb_object_keys(v_coverage) as k;

  if v_coverage_keys is distinct from
     array['percent', 'scorable_sections', 'total_sections']::text[] then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage has an unexpected key set.';
  end if;

  if (v_coverage -> 'total_sections') is distinct from '6'::jsonb then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage.total_sections must be 6.';
  end if;

  -- Integrality is checked as text before any cast, so a malformed value is
  -- refused by this guard rather than by a cast exception somewhere below it.
  if jsonb_typeof(v_coverage -> 'scorable_sections') <> 'number'
     or (v_coverage ->> 'scorable_sections') !~ '^[0-9]+$' then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage.scorable_sections must be a whole number.';
  end if;

  v_scorable := (v_coverage ->> 'scorable_sections')::integer;
  if v_scorable < 0 or v_scorable > 6 then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage.scorable_sections is out of range.';
  end if;

  if jsonb_typeof(v_coverage -> 'percent') <> 'number'
     or (v_coverage ->> 'percent') !~ '^[0-9]+$' then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage.percent must be a whole number.';
  end if;

  v_percent := (v_coverage ->> 'percent')::integer;
  if v_percent < 0 or v_percent > 100 then
    raise exception 'EQ5F-E: swing_analysis.putting_score.coverage.percent is out of range.';
  end if;

  v_score := new.putting_score -> 'score';

  -- A null score and zero scorable sections are the same fact stated twice, so
  -- an envelope asserting one without the other is internally inconsistent and
  -- is refused. This is a consistency check on what was stored; it derives no
  -- score and reproduces no part of the scoring algorithm.
  if jsonb_typeof(v_score) = 'null' then
    if v_scorable <> 0 then
      raise exception 'EQ5F-E: swing_analysis.putting_score.score is null while sections were scorable.';
    end if;
  elsif jsonb_typeof(v_score) = 'number' then
    if (new.putting_score ->> 'score') !~ '^[0-9]+$' then
      raise exception 'EQ5F-E: swing_analysis.putting_score.score must be a whole number.';
    end if;
    if (new.putting_score ->> 'score')::integer < 0
       or (new.putting_score ->> 'score')::integer > 100 then
      raise exception 'EQ5F-E: swing_analysis.putting_score.score is out of range.';
    end if;
    if v_scorable = 0 then
      raise exception 'EQ5F-E: swing_analysis.putting_score.score is present while no section was scorable.';
    end if;
  else
    raise exception 'EQ5F-E: swing_analysis.putting_score.score must be a number or null.';
  end if;

  return new;
end;
$function$;

create trigger swing_analysis_guard_putting_score
  before update of putting_score on public.swing_analysis
  for each row execute function public.guard_swing_analysis_putting_score();

-- The function is reached as a trigger, never as a Data API call. Direct
-- EXECUTE is withdrawn from the browser-reachable roles so it cannot become an
-- RPC by accident.
revoke all on function public.guard_swing_analysis_putting_score() from public;
revoke all on function public.guard_swing_analysis_putting_score() from anon;
revoke all on function public.guard_swing_analysis_putting_score() from authenticated;

-- ── Postflight ──────────────────────────────────────────────────────────────

do $postflight$
declare
  v_not_null boolean;
  v_has_default boolean;
  v_type text;
  v_secdef boolean;
  v_config text[];
  v_tgtype smallint;
begin
  select a.attnotnull, a.atthasdef, pg_catalog.format_type(a.atttypid, a.atttypmod)
    into v_not_null, v_has_default, v_type
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'swing_analysis'
     and a.attname = 'putting_score' and a.attnum > 0 and not a.attisdropped;

  if v_type is distinct from 'jsonb' then
    raise exception 'EQ5FE-POST-1: putting_score is not jsonb (found %).', coalesce(v_type, '<missing>');
  end if;
  if v_not_null then
    raise exception 'EQ5FE-POST-2: putting_score must remain nullable.';
  end if;
  if v_has_default then
    raise exception 'EQ5FE-POST-3: putting_score must have no default.';
  end if;

  select p.prosecdef, p.proconfig into v_secdef, v_config
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_swing_analysis_putting_score';

  if v_secdef is null then
    raise exception 'EQ5FE-POST-4: the guard function is missing.';
  end if;
  if v_secdef then
    raise exception 'EQ5FE-POST-5: the guard function must be SECURITY INVOKER.';
  end if;
  if v_config is null or not ('search_path=""' = any(v_config)) then
    raise exception 'EQ5FE-POST-6: the guard function must pin an empty search_path.';
  end if;

  select t.tgtype into v_tgtype
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'swing_analysis'
     and t.tgname = 'swing_analysis_guard_putting_score' and not t.tgisinternal;

  if v_tgtype is null then
    raise exception 'EQ5FE-POST-7: trigger swing_analysis_guard_putting_score is missing.';
  end if;
  -- bit 0 = ROW, bit 1 = BEFORE, bit 4 = UPDATE
  if (v_tgtype & 1) = 0 or (v_tgtype & 2) = 0 or (v_tgtype & 16) = 0 then
    raise exception 'EQ5FE-POST-8: the guard trigger must be BEFORE UPDATE FOR EACH ROW.';
  end if;

  if pg_catalog.has_function_privilege('anon', 'public.guard_swing_analysis_putting_score()', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.guard_swing_analysis_putting_score()', 'EXECUTE') then
    raise exception 'EQ5FE-POST-9: the guard function must not be directly executable by a browser role.';
  end if;

  if exists (
    select 1 from public.swing_analysis where putting_score is not null
  ) then
    raise exception 'EQ5FE-POST-10: no row may carry a putting score — this migration backfills nothing.';
  end if;
end;
$postflight$;

commit;
