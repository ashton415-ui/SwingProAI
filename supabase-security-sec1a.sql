-- ============================================================================
-- SwingProAI — SEC1A Security Policy Correction
-- ============================================================================
--
-- THIS MIGRATION IS UNAPPLIED. IT IS SOURCE ONLY.
--
-- Do not run this file against any Supabase project without a separate,
-- explicit staging-verification pass and a separate, explicit production
-- authorization. See docs/SECURITY_HARDENING_ROLLOUT.md for the full
-- vulnerability write-up, effective-access analysis, and approval gates.
--
-- PURPOSE
-- -------
-- Removes exactly three weak, over-permissive RLS policies identified during
-- the GP1R read-only reconciliation audit and confirmed unchanged during the
-- SEC1A design review:
--
--   1. storage.objects  — "Allow Anonymous Uploads xuww7b_0"
--      Let the anon role INSERT into the private swing-videos bucket with no
--      folder-ownership check at all.
--
--   2. public.user_goals — "Allow authenticated inserts"
--      Let any authenticated user INSERT a user_goals row with an arbitrary
--      (including another user's, or null) user_id.
--
--   3. public.user_goals — "Allow users to view own goals"
--      Let any authenticated user SELECT every row where user_id IS NULL, in
--      addition to their own rows.
--
-- Because PostgreSQL combines multiple PERMISSIVE policies for the same
-- command with OR, each of these weak policies neutralizes the correct,
-- owner-scoped policy that coexists with it — the stricter policy narrows
-- nothing once a broader permissive policy also matches.
--
-- WHY TABLE GRANTS ARE NOT TOUCHED
-- ---------------------------------
-- anon/authenticated/service_role all hold the standard Supabase blanket
-- table-level grants (SELECT/INSERT/UPDATE/DELETE/...) on both relations.
-- That is expected and is not the security boundary here: RLS policies are
-- the actual access-control layer. Removing a table grant would be both
-- unnecessary and out of scope for this correction — the fix belongs
-- entirely at the policy layer, which is why this contract touches nothing
-- else (no GRANT/REVOKE, no column change, no bucket configuration change).
--
-- SCOPE
-- -----
-- This file drops exactly the three named policies above and nothing else.
-- It creates no new policy, changes no grant, RLS-enablement flag, column,
-- constraint, index, trigger, function, or storage bucket configuration.
-- Drill-video storage policies and all other buckets are explicitly out of
-- scope and are verified untouched by both preflight and postflight.
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail loud on any drift from the approved SEC1A contract
-- ============================================================================
do $$
declare
  v_server_version_num int;
  v_schema_count        int;
  v_rel                 record;
  v_role_exists         boolean;
  v_has_authority       boolean;
  v_pol                 record;
  v_count               int;
begin
  -- --------------------------------------------------------------------
  -- SEC1A-PRE-A: platform and object existence
  -- --------------------------------------------------------------------
  select current_setting('server_version_num')::int into v_server_version_num;
  if v_server_version_num < 130000 then
    raise exception 'SEC1A-PRE-A1: unsupported PostgreSQL server_version_num % — this contract requires >= 130000 (PostgreSQL 13). Verify compatibility before proceeding.', v_server_version_num;
  end if;

  select count(*) into v_schema_count
    from pg_namespace
    where nspname in ('public', 'storage');
  if v_schema_count <> 2 then
    raise exception 'SEC1A-PRE-A2: expected schemas "public" and "storage" to both exist, found %.', v_schema_count;
  end if;

  select c.relkind, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
    into v_rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_goals';
  if not found then
    raise exception 'SEC1A-PRE-A3: public.user_goals does not exist. Stop.';
  end if;
  if v_rel.relkind <> 'r' then
    raise exception 'SEC1A-PRE-A4: public.user_goals is not an ordinary table (relkind=%). Stop.', v_rel.relkind;
  end if;
  if not v_rel.relrowsecurity then
    raise exception 'SEC1A-PRE-A5: RLS is not enabled on public.user_goals. Stop.';
  end if;
  if v_rel.owner <> 'postgres' then
    raise exception 'SEC1A-PRE-B1: unexpected owner drift on public.user_goals — expected "postgres", found "%". Live ownership no longer matches the GP1R/SEC1A baseline. Stop.', v_rel.owner;
  end if;

  select c.relkind, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
    into v_rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects';
  if not found then
    raise exception 'SEC1A-PRE-A6: storage.objects does not exist. Stop.';
  end if;
  if v_rel.relkind <> 'r' then
    raise exception 'SEC1A-PRE-A7: storage.objects is not an ordinary table (relkind=%). Stop.', v_rel.relkind;
  end if;
  if not v_rel.relrowsecurity then
    raise exception 'SEC1A-PRE-A8: RLS is not enabled on storage.objects. Stop.';
  end if;
  if v_rel.owner <> 'supabase_storage_admin' then
    raise exception 'SEC1A-PRE-B2: unexpected owner drift on storage.objects — expected "supabase_storage_admin", found "%". Live ownership no longer matches the GP1R/SEC1A baseline. Stop.', v_rel.owner;
  end if;

  select exists(select 1 from pg_roles where rolname = 'anon') into v_role_exists;
  if not v_role_exists then
    raise exception 'SEC1A-PRE-A9: role "anon" does not exist. Stop.';
  end if;

  select exists(select 1 from pg_roles where rolname = 'authenticated') into v_role_exists;
  if not v_role_exists then
    raise exception 'SEC1A-PRE-A10: role "authenticated" does not exist. Stop.';
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-PRE-B: execution authority
  --
  -- CREATE/DROP POLICY requires the current role to own the target
  -- relation, be a superuser, or be a member of the owning role.
  -- BYPASSRLS only affects row visibility during DML/SELECT and is
  -- deliberately NOT treated as sufficient authority to alter policies.
  -- If this check fails, the correct response is to apply this contract
  -- under whatever execution role Supabase provides for managing
  -- storage-schema policies (verified in staging), not to weaken this
  -- check.
  -- --------------------------------------------------------------------
  select (pg_has_role(current_user, 'postgres', 'MEMBER')
          or exists (select 1 from pg_roles where rolname = current_user and rolsuper))
    into v_has_authority;
  if not v_has_authority then
    raise exception 'SEC1A-PRE-B3: current role "%" is neither the owner of, a superuser, nor a member of the owning role "postgres" for public.user_goals. Policy DDL on this relation would fail. Stop.', current_user;
  end if;

  select (pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER')
          or exists (select 1 from pg_roles where rolname = current_user and rolsuper))
    into v_has_authority;
  if not v_has_authority then
    raise exception 'SEC1A-PRE-B4: current role "%" is neither the owner of, a superuser, nor a member of the owning role "supabase_storage_admin" for storage.objects. BYPASSRLS (if held) is not sufficient authority for policy DDL. This must be validated in staging under the actual execution role Supabase provides for storage-policy migrations before this contract can be applied. Stop.', current_user;
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-PRE-C: exact weak-policy contract — must match before removal
  -- Expressions are compared with all whitespace stripped so harmless
  -- formatting differences do not cause false drift; operators, casts,
  -- function names, literals, and parentheses are preserved verbatim.
  -- --------------------------------------------------------------------
  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow Anonymous Uploads xuww7b_0';
  if not found then
    raise exception 'SEC1A-PRE-C1: expected weak policy "Allow Anonymous Uploads xuww7b_0" on storage.objects is missing. Live policy state has drifted from the approved SEC1A contract. Stop.';
  end if;
  if v_pol.cmd <> 'INSERT' or v_pol.permissive <> 'PERMISSIVE' then
    raise exception 'SEC1A-PRE-C2: "Allow Anonymous Uploads xuww7b_0" no longer matches the approved contract (cmd=%, permissive=%). Stop.', v_pol.cmd, v_pol.permissive;
  end if;
  if v_pol.roles_sorted <> array['anon']::name[] then
    raise exception 'SEC1A-PRE-C3: "Allow Anonymous Uploads xuww7b_0" role set has drifted (found %). Stop.', v_pol.roles_sorted;
  end if;
  if v_pol.qual is not null then
    raise exception 'SEC1A-PRE-C4: "Allow Anonymous Uploads xuww7b_0" USING expression should be null, found "%". Stop.', v_pol.qual;
  end if;
  if regexp_replace(coalesce(v_pol.with_check, ''), '[[:space:]]+', '', 'g') <> '(bucket_id=''swing-videos''::text)' then
    raise exception 'SEC1A-PRE-C5: "Allow Anonymous Uploads xuww7b_0" WITH CHECK expression has drifted (found "%"). Stop.', v_pol.with_check;
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and policyname = 'Allow authenticated inserts';
  if not found then
    raise exception 'SEC1A-PRE-C6: expected weak policy "Allow authenticated inserts" on public.user_goals is missing. Live policy state has drifted from the approved SEC1A contract. Stop.';
  end if;
  if v_pol.cmd <> 'INSERT' or v_pol.permissive <> 'PERMISSIVE' then
    raise exception 'SEC1A-PRE-C7: "Allow authenticated inserts" no longer matches the approved contract (cmd=%, permissive=%). Stop.', v_pol.cmd, v_pol.permissive;
  end if;
  if v_pol.roles_sorted <> array['authenticated']::name[] then
    raise exception 'SEC1A-PRE-C8: "Allow authenticated inserts" role set has drifted (found %). Stop.', v_pol.roles_sorted;
  end if;
  if v_pol.qual is not null then
    raise exception 'SEC1A-PRE-C9: "Allow authenticated inserts" USING expression should be null, found "%". Stop.', v_pol.qual;
  end if;
  if regexp_replace(coalesce(v_pol.with_check, ''), '[[:space:]]+', '', 'g') <> 'true' then
    raise exception 'SEC1A-PRE-C10: "Allow authenticated inserts" WITH CHECK expression has drifted (found "%"). Stop.', v_pol.with_check;
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and policyname = 'Allow users to view own goals';
  if not found then
    raise exception 'SEC1A-PRE-C11: expected weak policy "Allow users to view own goals" on public.user_goals is missing. Live policy state has drifted from the approved SEC1A contract. Stop.';
  end if;
  if v_pol.cmd <> 'SELECT' or v_pol.permissive <> 'PERMISSIVE' then
    raise exception 'SEC1A-PRE-C12: "Allow users to view own goals" no longer matches the approved contract (cmd=%, permissive=%). Stop.', v_pol.cmd, v_pol.permissive;
  end if;
  if v_pol.roles_sorted <> array['authenticated']::name[] then
    raise exception 'SEC1A-PRE-C13: "Allow users to view own goals" role set has drifted (found %). Stop.', v_pol.roles_sorted;
  end if;
  if v_pol.with_check is not null then
    raise exception 'SEC1A-PRE-C14: "Allow users to view own goals" WITH CHECK expression should be null, found "%". Stop.', v_pol.with_check;
  end if;
  if regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g') <> '((auth.uid()=user_id)OR(user_idISNULL))' then
    raise exception 'SEC1A-PRE-C15: "Allow users to view own goals" USING expression has drifted (found "%"). Stop.', v_pol.qual;
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-PRE-D: exact strict-policy preservation contract
  -- These must exist, unchanged, and are NOT recreated by this contract —
  -- if any has drifted, SEC1A stops and requires redesign rather than
  -- implicitly replacing them.
  -- --------------------------------------------------------------------
  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and policyname = 'Users can insert own goals';
  if not found then
    raise exception 'SEC1A-PRE-D1: strict policy "Users can insert own goals" on public.user_goals is missing. Stop — do not proceed without this owner-scoped policy in place.';
  end if;
  if v_pol.cmd <> 'INSERT' or v_pol.permissive <> 'PERMISSIVE' or v_pol.roles_sorted <> array['public']::name[]
     or regexp_replace(coalesce(v_pol.with_check, ''), '[[:space:]]+', '', 'g') <> '(auth.uid()=user_id)' then
    raise exception 'SEC1A-PRE-D2: strict policy "Users can insert own goals" no longer matches its approved owner-scoped definition. Stop and redesign — do not recreate implicitly.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and policyname = 'Users can view own goals';
  if not found then
    raise exception 'SEC1A-PRE-D3: strict policy "Users can view own goals" on public.user_goals is missing. Stop — do not proceed without this owner-scoped policy in place.';
  end if;
  if v_pol.cmd <> 'SELECT' or v_pol.permissive <> 'PERMISSIVE' or v_pol.roles_sorted <> array['public']::name[]
     or regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g') <> '(auth.uid()=user_id)' then
    raise exception 'SEC1A-PRE-D4: strict policy "Users can view own goals" no longer matches its approved owner-scoped definition. Stop and redesign — do not recreate implicitly.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can upload their own swing videos';
  if not found then
    raise exception 'SEC1A-PRE-D5: strict policy "Users can upload their own swing videos" on storage.objects is missing. Stop — do not proceed without this folder-owner-scoped policy in place.';
  end if;
  if v_pol.cmd <> 'INSERT' or v_pol.permissive <> 'PERMISSIVE' or v_pol.roles_sorted <> array['authenticated']::name[]
     or regexp_replace(coalesce(v_pol.with_check, ''), '[[:space:]]+', '', 'g')
        <> '((bucket_id=''swing-videos''::text)AND((storage.foldername(name))[1]=(auth.uid())::text))' then
    raise exception 'SEC1A-PRE-D6: strict policy "Users can upload their own swing videos" no longer matches its approved folder-owner-scoped definition. Stop and redesign — do not recreate implicitly.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can read their own swing videos';
  if not found then
    raise exception 'SEC1A-PRE-D7: strict policy "Users can read their own swing videos" on storage.objects is missing. Stop — do not proceed without this folder-owner-scoped policy in place.';
  end if;
  if v_pol.cmd <> 'SELECT' or v_pol.permissive <> 'PERMISSIVE' or v_pol.roles_sorted <> array['authenticated']::name[]
     or regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g')
        <> '((bucket_id=''swing-videos''::text)AND((storage.foldername(name))[1]=(auth.uid())::text))' then
    raise exception 'SEC1A-PRE-D8: strict policy "Users can read their own swing videos" no longer matches its approved folder-owner-scoped definition. Stop and redesign — do not recreate implicitly.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can delete their own swing videos';
  if not found then
    raise exception 'SEC1A-PRE-D9: strict policy "Users can delete their own swing videos" on storage.objects is missing. Stop — do not proceed without this folder-owner-scoped policy in place.';
  end if;
  if v_pol.cmd <> 'DELETE' or v_pol.permissive <> 'PERMISSIVE' or v_pol.roles_sorted <> array['authenticated']::name[]
     or regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g')
        <> '((bucket_id=''swing-videos''::text)AND((storage.foldername(name))[1]=(auth.uid())::text))' then
    raise exception 'SEC1A-PRE-D10: strict policy "Users can delete their own swing videos" no longer matches its approved folder-owner-scoped definition. Stop and redesign — do not recreate implicitly.';
  end if;

  -- No swing-video UPDATE policy is expected or required by this contract.
  -- SEC1A does not create one; if application behavior later requires it,
  -- that is a separate, explicitly-authorized design decision.

  -- --------------------------------------------------------------------
  -- SEC1A-PRE-E: no other policy currently recreates equivalent broad
  -- access under a different name. Unrelated storage buckets (e.g.
  -- drill_videos) are intentionally excluded from this scan. A policy
  -- assigned to the "public" pseudo-role applies to anonymous clients
  -- too (it is not scoped to "authenticated" only), so both "anon" and
  -- "public" are treated as anonymous-applicable here.
  -- --------------------------------------------------------------------
  select count(*) into v_count
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd = 'INSERT'
      and ('anon' = any(roles) or 'public' = any(roles))
      and regexp_replace(coalesce(with_check, ''), '[[:space:]]+', '', 'g') like '%swing-videos%'
      and policyname <> 'Allow Anonymous Uploads xuww7b_0';
  if v_count > 0 then
    raise exception 'SEC1A-PRE-E1: found % additional anon- or public-role INSERT polic(y/ies) on storage.objects referencing swing-videos besides the one approved for removal. A policy assigned to "public" applies to anonymous clients too. Equivalent broad access exists elsewhere. Stop.', v_count;
  end if;

  select count(*) into v_count
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and cmd = 'INSERT'
      and policyname not in ('Allow authenticated inserts', 'Users can insert own goals')
      and (with_check is null
           or regexp_replace(with_check, '[[:space:]]+', '', 'g') not like '%auth.uid()=user_id%');
  if v_count > 0 then
    raise exception 'SEC1A-PRE-E2: found % additional user_goals INSERT polic(y/ies) outside the approved contract that do not enforce auth.uid() = user_id. Stop.', v_count;
  end if;

  select count(*) into v_count
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and cmd = 'SELECT'
      and policyname not in ('Allow users to view own goals', 'Users can view own goals')
      and regexp_replace(coalesce(qual, ''), '[[:space:]]+', '', 'g') like '%user_idISNULL%';
  if v_count > 0 then
    raise exception 'SEC1A-PRE-E3: found % additional user_goals SELECT polic(y/ies) outside the approved contract permitting user_id IS NULL broad reads. Stop.', v_count;
  end if;

  raise notice 'SEC1A-PRE-OK: all preflight checks passed — proceeding with removal of the three approved weak policies.';
end $$;

-- ============================================================================
-- REMOVAL — exactly the three approved weak policies, explicit and
-- schema-qualified. No DROP POLICY IF EXISTS: the preflight above already
-- proved exact existence and exact definition, so an unconditional
-- conditional-drop shortcut would only hide drift, not prevent it.
-- ============================================================================

drop policy "Allow Anonymous Uploads xuww7b_0"
  on storage.objects;

drop policy "Allow authenticated inserts"
  on public.user_goals;

drop policy "Allow users to view own goals"
  on public.user_goals;

-- ============================================================================
-- POSTFLIGHT — fail loud before COMMIT if the final policy matrix is wrong
-- ============================================================================
do $$
declare
  v_count int;
  v_pol   record;
begin
  -- --------------------------------------------------------------------
  -- SEC1A-POST-A: the three weak policies are gone
  -- --------------------------------------------------------------------
  select count(*) into v_count
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow Anonymous Uploads xuww7b_0';
  if v_count <> 0 then
    raise exception 'SEC1A-POST-A1: "Allow Anonymous Uploads xuww7b_0" is still present on storage.objects after DROP. Abort.';
  end if;

  select count(*) into v_count
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and policyname in ('Allow authenticated inserts', 'Allow users to view own goals');
  if v_count <> 0 then
    raise exception 'SEC1A-POST-A2: % weak user_goals polic(y/ies) still present after DROP. Abort.', v_count;
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-POST-B: the five strict policies remain, exactly as approved
  -- --------------------------------------------------------------------
  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals' and policyname = 'Users can insert own goals';
  if not found or v_pol.cmd <> 'INSERT' or v_pol.roles_sorted <> array['public']::name[]
     or regexp_replace(coalesce(v_pol.with_check, ''), '[[:space:]]+', '', 'g') <> '(auth.uid()=user_id)' then
    raise exception 'SEC1A-POST-B1: strict policy "Users can insert own goals" is missing or no longer matches the approved definition. Abort.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals' and policyname = 'Users can view own goals';
  if not found or v_pol.cmd <> 'SELECT' or v_pol.roles_sorted <> array['public']::name[]
     or regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g') <> '(auth.uid()=user_id)' then
    raise exception 'SEC1A-POST-B2: strict policy "Users can view own goals" is missing or no longer matches the approved definition. Abort.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'Users can upload their own swing videos';
  if not found or v_pol.cmd <> 'INSERT' or v_pol.roles_sorted <> array['authenticated']::name[]
     or regexp_replace(coalesce(v_pol.with_check, ''), '[[:space:]]+', '', 'g')
        <> '((bucket_id=''swing-videos''::text)AND((storage.foldername(name))[1]=(auth.uid())::text))' then
    raise exception 'SEC1A-POST-B3: strict policy "Users can upload their own swing videos" is missing or no longer matches the approved definition. Abort.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'Users can read their own swing videos';
  if not found or v_pol.cmd <> 'SELECT' or v_pol.roles_sorted <> array['authenticated']::name[]
     or regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g')
        <> '((bucket_id=''swing-videos''::text)AND((storage.foldername(name))[1]=(auth.uid())::text))' then
    raise exception 'SEC1A-POST-B4: strict policy "Users can read their own swing videos" is missing or no longer matches the approved definition. Abort.';
  end if;

  select policyname, permissive, cmd, qual, with_check,
         (select array_agg(r order by r) from unnest(roles) as r) as roles_sorted
    into v_pol
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'Users can delete their own swing videos';
  if not found or v_pol.cmd <> 'DELETE' or v_pol.roles_sorted <> array['authenticated']::name[]
     or regexp_replace(coalesce(v_pol.qual, ''), '[[:space:]]+', '', 'g')
        <> '((bucket_id=''swing-videos''::text)AND((storage.foldername(name))[1]=(auth.uid())::text))' then
    raise exception 'SEC1A-POST-B5: strict policy "Users can delete their own swing videos" is missing or no longer matches the approved definition. Abort.';
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-POST-C: RLS remains enabled on both relations
  -- --------------------------------------------------------------------
  if not (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'user_goals') then
    raise exception 'SEC1A-POST-C1: RLS is no longer enabled on public.user_goals. Abort.';
  end if;
  if not (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'storage' and c.relname = 'objects') then
    raise exception 'SEC1A-POST-C2: RLS is no longer enabled on storage.objects. Abort.';
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-POST-D: no equivalent broad access exists after the removal.
  -- As in preflight SEC1A-PRE-E, a policy assigned to "public" applies
  -- to anonymous clients too, so both "anon" and "public" are checked.
  -- --------------------------------------------------------------------
  select count(*) into v_count
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd = 'INSERT'
      and ('anon' = any(roles) or 'public' = any(roles))
      and regexp_replace(coalesce(with_check, ''), '[[:space:]]+', '', 'g') like '%swing-videos%';
  if v_count > 0 then
    raise exception 'SEC1A-POST-D1: an anon- or public-role INSERT policy referencing swing-videos still exists after removal. Abort.';
  end if;

  select count(*) into v_count
    from pg_policies
    where schemaname = 'public' and tablename = 'user_goals'
      and cmd = 'SELECT'
      and regexp_replace(coalesce(qual, ''), '[[:space:]]+', '', 'g') like '%user_idISNULL%';
  if v_count > 0 then
    raise exception 'SEC1A-POST-D2: a user_goals SELECT policy permitting user_id IS NULL broad reads still exists after removal. Abort.';
  end if;

  select count(*) into v_count
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd = 'UPDATE'
      and regexp_replace(coalesce(qual, '') || coalesce(with_check, ''), '[[:space:]]+', '', 'g') like '%swing-videos%';
  if v_count > 0 then
    raise exception 'SEC1A-POST-D3: an unexpected UPDATE policy for swing-videos exists — this contract does not create one and none should be present. Abort.';
  end if;

  -- --------------------------------------------------------------------
  -- SEC1A-POST-E: unrelated drill-video policies were not targeted
  -- --------------------------------------------------------------------
  select count(*) into v_count
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('Users can upload drill videos', 'Users can view own drill videos');
  if v_count <> 2 then
    raise exception 'SEC1A-POST-E1: expected both drill-video policies to remain untouched (found %). Abort.', v_count;
  end if;

  raise notice 'SEC1A-POST-OK: final policy matrix matches the approved SEC1A contract.';
end $$;

commit;
