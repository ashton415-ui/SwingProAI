-- ============================================================================
-- PI-0 — Practice Intelligence foundation
-- ============================================================================
--
-- Four owner-scoped tables that record what a golfer planned to practise and
-- what they say happened when they did:
--
--   practice_plans            a golfer-authored plan (origin 'golfer' only)
--   practice_plan_items       the ordered canonical drills in a plan
--   practice_sessions         one practice session, optionally against a plan
--   practice_session_results  one user-entered result for one drill; immutable
--
-- Evidence standard
-- -----------------
-- Every result is user_entered and says so in evidence_type, whose CHECK admits
-- no other value. Nothing here is measured, inferred or recommended, and no
-- column stores a derived percentage: progress is computed from these rows by
-- the application and never persisted.
--
-- Write authority
-- ---------------
-- Browser roles never write. anon holds nothing; authenticated holds SELECT
-- only, and one SELECT policy per table limits it to its own rows. Every write
-- is made by the server with the service role, from a verified identity:
--
--   * plan creation and result recording go through the two functions below,
--     so a plan and its items, or a result and its ownership checks, commit
--     together or not at all;
--   * archive, session start and session end are single guarded statements
--     issued by the route handlers.
--
-- The functions are SECURITY INVOKER with an empty search_path. EXECUTE is
-- revoked from PUBLIC, anon and authenticated and granted to service_role
-- only. They bind every read and write to p_user_id, which the routes take
-- only from verified auth.
--
-- What this migration does NOT do
-- -------------------------------
-- It changes no existing table, policy, grant or function, touches no drill
-- row, adds no trigger and no SECURITY DEFINER function, and rewrites no data.

begin;

-- ── Preflight ───────────────────────────────────────────────────────────────

do $preflight$
begin
  if (select count(*) from pg_catalog.pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'PI0-PRE-1: the anon, authenticated and service_role roles must all exist.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('practice_plans', 'practice_plan_items',
                         'practice_sessions', 'practice_session_results')
  ) then
    raise exception 'PI0-PRE-2: a practice relation already exists; refusing to adapt to it.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'pi\_%'
  ) then
    raise exception 'PI0-PRE-3: a public pi_ function already exists; refusing to adapt to it.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint k
     where k.conrelid = 'public.drills'::regclass
       and k.contype = 'p'
       and k.conkey = array[(
         select a.attnum from pg_catalog.pg_attribute a
          where a.attrelid = 'public.drills'::regclass and a.attname = 'id'
       )]::smallint[]
  ) then
    raise exception 'PI0-PRE-4: public.drills must exist with id as its primary key.';
  end if;
end;
$preflight$;

-- ── Tables ──────────────────────────────────────────────────────────────────

create table public.practice_plans (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  focus text,
  origin text not null default 'golfer',
  status text not null default 'active',
  archived_at timestamptz,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint practice_plans_pkey primary key (id),
  constraint practice_plans_title_check check (pg_catalog.length(pg_catalog.btrim(title)) between 1 and 120),
  constraint practice_plans_focus_check check (focus is null or pg_catalog.length(focus) <= 500),
  constraint practice_plans_origin_check check (origin = 'golfer'),
  constraint practice_plans_status_check check (status in ('active', 'archived')),
  constraint practice_plans_archived_at_check check ((status = 'archived') = (archived_at is not null)),
  constraint practice_plans_fingerprint_check check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint practice_plans_user_idempotency_key unique (user_id, idempotency_key),
  constraint practice_plans_id_user_key unique (id, user_id)
);

create index practice_plans_user_status_created_idx
  on public.practice_plans (user_id, status, created_at desc);

create table public.practice_plan_items (
  id uuid not null default gen_random_uuid(),
  plan_id uuid not null,
  user_id uuid not null,
  drill_id uuid not null references public.drills(id) on delete restrict,
  position integer not null,
  target_reps integer,
  target_note text,
  created_at timestamptz not null default now(),
  constraint practice_plan_items_pkey primary key (id),
  constraint practice_plan_items_plan_owner_fkey foreign key (plan_id, user_id)
    references public.practice_plans (id, user_id) on delete cascade,
  constraint practice_plan_items_position_check check (position >= 1),
  constraint practice_plan_items_target_reps_check check (target_reps is null or target_reps between 1 and 500),
  constraint practice_plan_items_target_note_check check (target_note is null or pg_catalog.length(target_note) <= 500),
  constraint practice_plan_items_plan_position_key unique (plan_id, position),
  constraint practice_plan_items_id_user_key unique (id, user_id),
  constraint practice_plan_items_id_plan_key unique (id, plan_id),
  constraint practice_plan_items_id_drill_key unique (id, drill_id)
);

create index practice_plan_items_drill_idx on public.practice_plan_items (drill_id);

create table public.practice_sessions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid,
  status text not null default 'in_progress',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  notes text,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint practice_sessions_pkey primary key (id),
  constraint practice_sessions_plan_owner_fkey foreign key (plan_id, user_id)
    references public.practice_plans (id, user_id) on delete restrict,
  constraint practice_sessions_status_check check (status in ('in_progress', 'completed', 'abandoned')),
  constraint practice_sessions_ended_at_check check ((status = 'in_progress') = (ended_at is null)),
  constraint practice_sessions_ended_after_started_check check (ended_at is null or ended_at >= started_at),
  constraint practice_sessions_notes_check check (notes is null or pg_catalog.length(notes) <= 1000),
  constraint practice_sessions_fingerprint_check check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint practice_sessions_user_idempotency_key unique (user_id, idempotency_key),
  constraint practice_sessions_id_user_key unique (id, user_id),
  constraint practice_sessions_id_plan_key unique (id, plan_id)
);

-- At most one session in progress per golfer.
create unique index practice_sessions_one_in_progress_idx
  on public.practice_sessions (user_id) where status = 'in_progress';

create table public.practice_session_results (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  plan_id uuid,
  plan_item_id uuid,
  drill_id uuid not null references public.drills(id) on delete restrict,
  evidence_type text not null default 'user_entered',
  attempts integer,
  successes integer,
  self_rating smallint,
  note text,
  recorded_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint practice_session_results_pkey primary key (id),
  constraint practice_session_results_session_owner_fkey foreign key (session_id, user_id)
    references public.practice_sessions (id, user_id) on delete cascade,
  constraint practice_session_results_session_plan_fkey foreign key (session_id, plan_id)
    references public.practice_sessions (id, plan_id),
  constraint practice_session_results_item_plan_fkey foreign key (plan_item_id, plan_id)
    references public.practice_plan_items (id, plan_id),
  constraint practice_session_results_item_drill_fkey foreign key (plan_item_id, drill_id)
    references public.practice_plan_items (id, drill_id),
  constraint practice_session_results_evidence_type_check check (evidence_type = 'user_entered'),
  constraint practice_session_results_attempts_check check (attempts is null or attempts between 0 and 1000),
  constraint practice_session_results_successes_check
    check (successes is null or (successes >= 0 and (attempts is null or successes <= attempts))),
  constraint practice_session_results_self_rating_check check (self_rating is null or self_rating between 1 and 5),
  constraint practice_session_results_note_check check (note is null or pg_catalog.length(note) <= 1000),
  constraint practice_session_results_has_evidence_check
    check (attempts is not null or self_rating is not null or note is not null),
  constraint practice_session_results_item_needs_plan_check check (plan_item_id is null or plan_id is not null),
  constraint practice_session_results_fingerprint_check check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint practice_session_results_user_idempotency_key unique (user_id, idempotency_key)
);

create index practice_session_results_session_idx
  on public.practice_session_results (session_id);
create index practice_session_results_user_drill_recorded_idx
  on public.practice_session_results (user_id, drill_id, recorded_at desc);

-- ── Row level security ──────────────────────────────────────────────────────

alter table public.practice_plans enable row level security;
alter table public.practice_plan_items enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.practice_session_results enable row level security;

create policy "practice_plans_owner_select" on public.practice_plans
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "practice_plan_items_owner_select" on public.practice_plan_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "practice_sessions_owner_select" on public.practice_sessions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "practice_session_results_owner_select" on public.practice_session_results
  for select to authenticated using ((select auth.uid()) = user_id);

-- ── Table privileges ────────────────────────────────────────────────────────
-- Stated explicitly rather than inherited from default privileges, so the
-- result is the same in every environment.

revoke all on table public.practice_plans from anon;
revoke all on table public.practice_plan_items from anon;
revoke all on table public.practice_sessions from anon;
revoke all on table public.practice_session_results from anon;

revoke all on table public.practice_plans from authenticated;
revoke all on table public.practice_plan_items from authenticated;
revoke all on table public.practice_sessions from authenticated;
revoke all on table public.practice_session_results from authenticated;

grant select on table public.practice_plans to authenticated;
grant select on table public.practice_plan_items to authenticated;
grant select on table public.practice_sessions to authenticated;
grant select on table public.practice_session_results to authenticated;

grant select, insert, update, delete on table public.practice_plans to service_role;
grant select, insert, update, delete on table public.practice_plan_items to service_role;
grant select, insert, update, delete on table public.practice_sessions to service_role;
grant select, insert, update, delete on table public.practice_session_results to service_role;

-- ── Plan creation ───────────────────────────────────────────────────────────
-- Creates a plan and its 1..20 items in one transaction, or answers the
-- earlier outcome of the same idempotency key. Outcomes:
--   created | replayed | idempotency_conflict | drill_not_found

create function public.pi_create_practice_plan(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_title text,
  p_focus text,
  p_items jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $create_plan$
declare
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_plan_id uuid;
  v_item_count integer;
begin
  if p_user_id is null or p_idempotency_key is null or p_request_fingerprint is null then
    raise exception 'PI0-PLAN-1: user, idempotency key and fingerprint are required.'
      using errcode = '22023';
  end if;

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'PI0-PLAN-2: items must be an array.' using errcode = '22023';
  end if;

  v_item_count := pg_catalog.jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 20 then
    raise exception 'PI0-PLAN-3: a plan holds 1 to 20 items.' using errcode = '22023';
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) as e(item)
     where pg_catalog.jsonb_typeof(e.item) <> 'object'
        or pg_catalog.jsonb_typeof(e.item -> 'drillId') is distinct from 'string'
  ) then
    raise exception 'PI0-PLAN-4: every item names a drill.' using errcode = '22023';
  end if;

  -- The same key answers the same way it answered the first time.
  select pp.id, pp.request_fingerprint into v_existing_id, v_existing_fingerprint
    from public.practice_plans pp
   where pp.user_id = p_user_id and pp.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_fingerprint = p_request_fingerprint then
      return pg_catalog.jsonb_build_object('outcome', 'replayed', 'plan_id', v_existing_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  -- Every drill must be canonical. Nothing is written otherwise.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) as e(item)
     where not exists (
       select 1 from public.drills d where d.id = (e.item ->> 'drillId')::uuid
     )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'drill_not_found');
  end if;

  insert into public.practice_plans (user_id, title, focus, idempotency_key, request_fingerprint)
  values (p_user_id, p_title, p_focus, p_idempotency_key, p_request_fingerprint)
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_plan_id;

  if v_plan_id is null then
    -- A concurrent request with the same key committed first.
    select pp.id, pp.request_fingerprint into v_existing_id, v_existing_fingerprint
      from public.practice_plans pp
     where pp.user_id = p_user_id and pp.idempotency_key = p_idempotency_key;
    if not found then
      raise exception 'PI0-PLAN-5: idempotency conflict without a committed plan.';
    end if;
    if v_existing_fingerprint = p_request_fingerprint then
      return pg_catalog.jsonb_build_object('outcome', 'replayed', 'plan_id', v_existing_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  insert into public.practice_plan_items (plan_id, user_id, drill_id, position, target_reps, target_note)
  select v_plan_id,
         p_user_id,
         (e.item ->> 'drillId')::uuid,
         e.ord::integer,
         (e.item ->> 'targetReps')::integer,
         e.item ->> 'targetNote'
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as e(item, ord);

  return pg_catalog.jsonb_build_object('outcome', 'created', 'plan_id', v_plan_id);
end;
$create_plan$;

-- ── Result recording ────────────────────────────────────────────────────────
-- Records one user-entered result in the caller's own in-progress session. The
-- session row is locked so it cannot end while the result is written; plan_id
-- comes from the session, never from the request. Outcomes:
--   created | replayed | idempotency_conflict | session_not_found |
--   session_not_active | drill_not_found | plan_item_invalid

create function public.pi_record_practice_result(
  p_user_id uuid,
  p_session_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_plan_item_id uuid,
  p_drill_id uuid,
  p_attempts integer,
  p_successes integer,
  p_self_rating smallint,
  p_note text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $record_result$
declare
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_session_plan_id uuid;
  v_session_status text;
  v_result_id uuid;
begin
  if p_user_id is null or p_session_id is null or p_idempotency_key is null
     or p_request_fingerprint is null or p_drill_id is null then
    raise exception 'PI0-RESULT-1: user, session, idempotency key, fingerprint and drill are required.'
      using errcode = '22023';
  end if;

  select r.id, r.request_fingerprint into v_existing_id, v_existing_fingerprint
    from public.practice_session_results r
   where r.user_id = p_user_id and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_fingerprint = p_request_fingerprint then
      return pg_catalog.jsonb_build_object('outcome', 'replayed', 'result_id', v_existing_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  select s.plan_id, s.status into v_session_plan_id, v_session_status
    from public.practice_sessions s
   where s.id = p_session_id and s.user_id = p_user_id
     for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'session_not_found');
  end if;
  if v_session_status <> 'in_progress' then
    return pg_catalog.jsonb_build_object('outcome', 'session_not_active');
  end if;

  if not exists (select 1 from public.drills d where d.id = p_drill_id) then
    return pg_catalog.jsonb_build_object('outcome', 'drill_not_found');
  end if;

  if p_plan_item_id is not null then
    if v_session_plan_id is null or not exists (
      select 1 from public.practice_plan_items i
       where i.id = p_plan_item_id
         and i.plan_id = v_session_plan_id
         and i.user_id = p_user_id
         and i.drill_id = p_drill_id
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'plan_item_invalid');
    end if;
  end if;

  insert into public.practice_session_results (
    user_id, session_id, plan_id, plan_item_id, drill_id,
    attempts, successes, self_rating, note,
    idempotency_key, request_fingerprint
  ) values (
    p_user_id, p_session_id, v_session_plan_id, p_plan_item_id, p_drill_id,
    p_attempts, p_successes, p_self_rating, p_note,
    p_idempotency_key, p_request_fingerprint
  )
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_result_id;

  if v_result_id is null then
    select r.id, r.request_fingerprint into v_existing_id, v_existing_fingerprint
      from public.practice_session_results r
     where r.user_id = p_user_id and r.idempotency_key = p_idempotency_key;
    if not found then
      raise exception 'PI0-RESULT-2: idempotency conflict without a committed result.';
    end if;
    if v_existing_fingerprint = p_request_fingerprint then
      return pg_catalog.jsonb_build_object('outcome', 'replayed', 'result_id', v_existing_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'created', 'result_id', v_result_id);
end;
$record_result$;

-- ── Function privileges ─────────────────────────────────────────────────────

revoke execute on function public.pi_create_practice_plan(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.pi_record_practice_result(uuid, uuid, uuid, text, uuid, uuid, integer, integer, smallint, text)
  from public, anon, authenticated;

grant execute on function public.pi_create_practice_plan(uuid, uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.pi_record_practice_result(uuid, uuid, uuid, text, uuid, uuid, integer, integer, smallint, text)
  to service_role;

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the resulting boundary rather than assuming the statements above had
-- the intended effect. PostgreSQL has no column-level DELETE, TRUNCATE or
-- TRIGGER privilege, so those are proved at table level only.

do $postflight$
declare
  target text;
  targets constant text[] := array[
    'public.practice_plans',
    'public.practice_plan_items',
    'public.practice_sessions',
    'public.practice_session_results'
  ];
  priv text;
  fn regprocedure;
  fns constant regprocedure[] := array[
    'public.pi_create_practice_plan(uuid, uuid, text, text, text, jsonb)'::regprocedure,
    'public.pi_record_practice_result(uuid, uuid, uuid, text, uuid, uuid, integer, integer, smallint, text)'::regprocedure
  ];
begin
  foreach target in array targets loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = target::regclass) then
      raise exception 'PI0-POST-1: row level security is not enabled on %.', target;
    end if;

    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if pg_catalog.has_table_privilege('anon', target, priv) then
        raise exception 'PI0-POST-2: anon holds % on %.', priv, target;
      end if;
    end loop;

    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if pg_catalog.has_any_column_privilege('anon', target, priv) then
        raise exception 'PI0-POST-3: anon holds column-level % on %.', priv, target;
      end if;
    end loop;

    if not pg_catalog.has_table_privilege('authenticated', target, 'SELECT') then
      raise exception 'PI0-POST-4: authenticated must hold SELECT on %.', target;
    end if;

    foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if pg_catalog.has_table_privilege('authenticated', target, priv) then
        raise exception 'PI0-POST-5: authenticated holds % on %.', priv, target;
      end if;
    end loop;

    foreach priv in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if pg_catalog.has_any_column_privilege('authenticated', target, priv) then
        raise exception 'PI0-POST-6: authenticated holds column-level % on %.', priv, target;
      end if;
    end loop;

    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not pg_catalog.has_table_privilege('service_role', target, priv) then
        raise exception 'PI0-POST-7: service_role must hold % on %.', priv, target;
      end if;
    end loop;

    -- Exactly one policy: permissive, SELECT, authenticated only, owner-bound.
    if (select count(*) from pg_catalog.pg_policy p where p.polrelid = target::regclass) <> 1
       or not exists (
         select 1 from pg_catalog.pg_policy p
          where p.polrelid = target::regclass
            and p.polcmd = 'r'
            and p.polpermissive
            and p.polroles = array['authenticated'::regrole::oid]
            and p.polwithcheck is null
            and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ 'auth\.uid\(\)'
            and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ '\muser_id\M'
       ) then
      raise exception 'PI0-POST-8: % must carry exactly one owner-bound SELECT policy for authenticated.', target;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_attribute a,
           lateral pg_catalog.aclexplode(a.attacl) as x
     where a.attrelid in (
             'public.practice_plans'::regclass,
             'public.practice_plan_items'::regclass,
             'public.practice_sessions'::regclass,
             'public.practice_session_results'::regclass
           )
       and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'PI0-POST-9: a practice table carries a column-level privilege.';
  end if;

  if (select count(*) from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'pi\_%') <> 2 then
    raise exception 'PI0-POST-10: exactly two public pi_ functions must exist.';
  end if;

  foreach fn in array fns loop
    if exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = fn
         and (p.prosecdef or p.proconfig is distinct from array['search_path=""']::text[])
    ) then
      raise exception 'PI0-POST-11: % must be SECURITY INVOKER with an empty search_path.', fn;
    end if;

    if pg_catalog.has_function_privilege('anon', fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'PI0-POST-12: a browser role can execute %.', fn;
    end if;

    if exists (
      select 1 from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(p.proacl) as x
       where p.oid = fn and x.grantee = 0
    ) or (select p.proacl is null from pg_catalog.pg_proc p where p.oid = fn) then
      raise exception 'PI0-POST-13: PUBLIC can execute %.', fn;
    end if;

    if not pg_catalog.has_function_privilege('service_role', fn, 'EXECUTE') then
      raise exception 'PI0-POST-14: service_role must be able to execute %.', fn;
    end if;
  end loop;
end;
$postflight$;

commit;
