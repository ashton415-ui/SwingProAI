-- ============================================================================
-- SEC-COACH1 — coach write authority closure
-- ============================================================================
--
-- Five coach-to-golfer tables granted anon and authenticated table-level
-- INSERT, UPDATE and DELETE, and each was guarded by a catch-all FOR ALL
-- policy whose only predicate is auth.uid() = coach_id. Any signed-in user
-- could therefore write rows naming themselves as coach of any golfer:
-- declare an active coach_student_relationships row (which the users and
-- launch_monitor_sessions coach-read policies then trust), declare an active
-- coach_golfer_relationships row, or write prescriptions, feedback and lesson
-- plans for an unrelated golfer. Nothing proved the caller was a coach, that
-- the golfer consented, or that a referenced resource belonged to the golfer.
--
-- What this migration does
-- ------------------------
-- 1. Revokes INSERT, UPDATE and DELETE on the five tables from anon and
--    authenticated. No live root-application path writes them from the
--    browser; all five tables hold zero rows.
-- 2. Downgrades each catch-all coach policy from FOR ALL to FOR SELECT, keeping
--    its name, its role target and its exact auth.uid() = coach_id predicate,
--    so coach-side read behaviour is unchanged. The historical "manage"/"_all"
--    names are kept deliberately to avoid policy-name churn in this slice.
--
-- What this migration does NOT do
-- -------------------------------
-- It does not touch the golfer/student read policies or the golfer UPDATE
-- policy on coach_golfer_relationships (inert once UPDATE is revoked). It does
-- not touch public.launch_monitor_sessions, public.users or the invite-code
-- function (which runs as its owner and keeps creating consented
-- relationships). It revokes no SELECT, does not touch service_role, leaves
-- REFERENCES/TRIGGER/TRUNCATE for a separate hygiene slice, creates no
-- function or trigger, changes no column or constraint and rewrites no row.
--
-- PostgreSQL has no column-level DELETE privilege, so column-level proofs cover
-- INSERT and UPDATE; DELETE is proved at table level.

begin;

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed on a divergent database rather than adapting to it.

do $preflight$
declare
  target text;
  targets constant text[] := array[
    'public.coach_student_relationships',
    'public.coach_golfer_relationships',
    'public.automated_prescriptions',
    'public.coach_feedback',
    'public.lesson_plans'
  ];
  browser_role text;
  dml text;
begin
  foreach target in array targets loop
    if not exists (
      select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname || '.' || c.relname = target and c.relkind = 'r'
    ) then
      raise exception 'SEC-COACH1-PRE-1: % is missing or is not an ordinary table.', target;
    end if;
  end loop;

  if (select count(*) from pg_catalog.pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'SEC-COACH1-PRE-2: the anon, authenticated and service_role roles must all exist.';
  end if;

  foreach target in array targets loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = target::regclass) then
      raise exception 'SEC-COACH1-PRE-3: row level security is not enabled on %.', target;
    end if;
  end loop;

  -- The expected starting authority: both browser roles hold table-level DML.
  foreach target in array targets loop
    foreach browser_role in array array['anon', 'authenticated'] loop
      foreach dml in array array['INSERT', 'UPDATE', 'DELETE'] loop
        if not pg_catalog.has_table_privilege(browser_role, target, dml) then
          raise exception 'SEC-COACH1-PRE-4: % does not hold table-level % on %; live authority has drifted.', browser_role, dml, target;
        end if;
      end loop;
    end loop;
  end loop;

  -- A table-level REVOKE does not remove an explicit column grant. If one
  -- exists, revoking the table privilege would leave a silent bypass.
  if exists (
    select 1
      from pg_catalog.pg_attribute a,
           lateral pg_catalog.aclexplode(a.attacl) as x
     where a.attrelid in (
             'public.coach_student_relationships'::regclass,
             'public.coach_golfer_relationships'::regclass,
             'public.automated_prescriptions'::regclass,
             'public.coach_feedback'::regclass,
             'public.lesson_plans'::regclass
           )
       and a.attnum > 0 and not a.attisdropped
       and x.grantee in (
         select oid from pg_catalog.pg_roles where rolname in ('anon', 'authenticated')
       )
       and x.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'SEC-COACH1-PRE-5: an explicit column-level DML grant to anon or authenticated exists on a target table; refusing to leave a bypass.';
  end if;

  -- Each catch-all coach policy must exist as FOR ALL before it is replaced.
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public'
                  and tablename = 'coach_student_relationships' and policyname = 'csr_coach_all' and cmd = 'ALL')
     or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public'
                  and tablename = 'automated_prescriptions' and policyname = 'ap_coach_all' and cmd = 'ALL')
     or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public'
                  and tablename = 'coach_feedback' and policyname = 'Coach can manage their feedback' and cmd = 'ALL')
     or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public'
                  and tablename = 'coach_golfer_relationships' and policyname = 'Coach can manage their relationships' and cmd = 'ALL')
     or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public'
                  and tablename = 'lesson_plans' and policyname = 'Coach can manage lesson plans' and cmd = 'ALL') then
    raise exception 'SEC-COACH1-PRE-6: an expected catch-all coach FOR ALL policy is missing or has drifted.';
  end if;
end;
$preflight$;

-- ── Direct client write closure ─────────────────────────────────────────────

revoke insert, update, delete on table public.coach_student_relationships from anon, authenticated;
revoke insert, update, delete on table public.coach_golfer_relationships from anon, authenticated;
revoke insert, update, delete on table public.automated_prescriptions from anon, authenticated;
revoke insert, update, delete on table public.coach_feedback from anon, authenticated;
revoke insert, update, delete on table public.lesson_plans from anon, authenticated;

-- ── Catch-all coach policies: FOR ALL → FOR SELECT, same name and predicate ─

drop policy "csr_coach_all" on public.coach_student_relationships;
create policy "csr_coach_all" on public.coach_student_relationships
  for select using (auth.uid() = coach_id);

drop policy "ap_coach_all" on public.automated_prescriptions;
create policy "ap_coach_all" on public.automated_prescriptions
  for select using (auth.uid() = coach_id);

drop policy "Coach can manage their feedback" on public.coach_feedback;
create policy "Coach can manage their feedback" on public.coach_feedback
  for select using (auth.uid() = coach_id);

drop policy "Coach can manage their relationships" on public.coach_golfer_relationships;
create policy "Coach can manage their relationships" on public.coach_golfer_relationships
  for select using (auth.uid() = coach_id);

drop policy "Coach can manage lesson plans" on public.lesson_plans;
create policy "Coach can manage lesson plans" on public.lesson_plans
  for select using (auth.uid() = coach_id);

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the resulting boundary rather than assuming the statements above had
-- the intended effect.

do $postflight$
declare
  target text;
  targets constant text[] := array[
    'public.coach_student_relationships',
    'public.coach_golfer_relationships',
    'public.automated_prescriptions',
    'public.coach_feedback',
    'public.lesson_plans'
  ];
  browser_role text;
  dml text;
  col_dml text;
begin
  foreach target in array targets loop
    foreach browser_role in array array['anon', 'authenticated'] loop
      foreach dml in array array['INSERT', 'UPDATE', 'DELETE'] loop
        if pg_catalog.has_table_privilege(browser_role, target, dml) then
          raise exception 'SEC-COACH1-POST-1: % still holds table-level % on %.', browser_role, dml, target;
        end if;
      end loop;
      -- Column privileges exist only for SELECT/INSERT/UPDATE/REFERENCES.
      foreach col_dml in array array['INSERT', 'UPDATE'] loop
        if pg_catalog.has_any_column_privilege(browser_role, target, col_dml) then
          raise exception 'SEC-COACH1-POST-2: % can still % a column of %.', browser_role, col_dml, target;
        end if;
      end loop;
    end loop;

    if not pg_catalog.has_table_privilege('authenticated', target, 'SELECT') then
      raise exception 'SEC-COACH1-POST-3: authenticated SELECT on % must be unchanged.', target;
    end if;

    foreach dml in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not pg_catalog.has_table_privilege('service_role', target, dml) then
        raise exception 'SEC-COACH1-POST-4: service_role % on % must be unchanged.', dml, target;
      end if;
    end loop;
  end loop;

  -- Each former catch-all policy now exists exactly once, as SELECT, with the
  -- original coach-ownership predicate.
  if (select count(*) from pg_catalog.pg_policies
       where schemaname = 'public' and cmd = 'SELECT' and qual = '(auth.uid() = coach_id)'
         and (tablename, policyname) in (
           ('coach_student_relationships', 'csr_coach_all'),
           ('automated_prescriptions', 'ap_coach_all'),
           ('coach_feedback', 'Coach can manage their feedback'),
           ('coach_golfer_relationships', 'Coach can manage their relationships'),
           ('lesson_plans', 'Coach can manage lesson plans')
         )) <> 5 then
    raise exception 'SEC-COACH1-POST-5: a downgraded coach policy is not SELECT-only with the coach-ownership predicate.';
  end if;

  if exists (select 1 from pg_catalog.pg_policies
              where schemaname = 'public' and cmd <> 'SELECT'
                and (tablename, policyname) in (
                  ('coach_student_relationships', 'csr_coach_all'),
                  ('automated_prescriptions', 'ap_coach_all'),
                  ('coach_feedback', 'Coach can manage their feedback'),
                  ('coach_golfer_relationships', 'Coach can manage their relationships'),
                  ('lesson_plans', 'Coach can manage lesson plans')
                )) then
    raise exception 'SEC-COACH1-POST-6: a former catch-all coach policy still carries a write command.';
  end if;

  -- The pre-existing golfer/student policies are untouched.
  if (select count(*) from pg_catalog.pg_policies
       where schemaname = 'public'
         and (tablename, policyname, cmd) in (
           ('coach_student_relationships', 'csr_student_select', 'SELECT'),
           ('automated_prescriptions', 'ap_student_select', 'SELECT'),
           ('coach_feedback', 'Golfer can view feedback on their swings', 'SELECT'),
           ('coach_golfer_relationships', 'Coach or golfer can view their relationships', 'SELECT'),
           ('coach_golfer_relationships', 'Golfer can update their own relationship status', 'UPDATE'),
           ('lesson_plans', 'Golfer can view their lesson plans', 'SELECT')
         )) <> 6 then
    raise exception 'SEC-COACH1-POST-7: a preserved golfer/student policy is missing or changed command.';
  end if;
end;
$postflight$;

commit;
