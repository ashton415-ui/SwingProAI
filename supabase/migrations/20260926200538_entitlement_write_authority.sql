-- ============================================================================
-- Entitlement write authority — server-authoritative public.users writes
-- ============================================================================
--
-- public.users carries the facts entitlement and authorization are decided
-- from: subscription_tier, subscription_status, role, and the Stripe customer
-- link the billing webhook matches on. Until now anon and authenticated held
-- table-level INSERT and UPDATE on every column, and the owner UPDATE policy
-- checks only which row is touched, never which column — so a golfer could
-- raise their own tier, set their own role or rewrite their billing link
-- through PostgREST. A WITH CHECK clause would not change that: it constrains
-- the row, not the column.
--
-- What this migration does
-- ------------------------
-- Revokes INSERT and UPDATE on public.users from anon and authenticated. No
-- column is re-granted: no live feature lets a golfer edit their own profile
-- row, and any future one gets its own least-privilege design. Because the
-- table-level privilege is gone and no column privilege exists, a column added
-- later is not client-writable either.
--
-- Profiles are created by the Auth lifecycle trigger (handle_new_user, which
-- runs as its owner), billing state is written by the Stripe webhook and the
-- checkout customer link through the server-only service_role client, and the
-- coach invite code is derived by a trigger. None of them depends on the
-- privileges revoked here.
--
-- What this migration does NOT do
-- -------------------------------
-- It changes no RLS policy (the owner INSERT and UPDATE policies become inert),
-- creates no function, adds no trigger, touches no column definition and
-- rewrites no row. SELECT and DELETE are left exactly as they were, and
-- service_role is not touched.

begin;

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed on a divergent database rather than adapting to it.

do $preflight$
begin
  if not exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'users' and c.relkind = 'r'
  ) then
    raise exception 'EWA-PRE-1: public.users is missing.';
  end if;

  if (select count(*) from pg_catalog.pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'EWA-PRE-2: the anon, authenticated and service_role roles must all exist.';
  end if;

  -- A table-level REVOKE does not remove an explicit column grant. If one
  -- exists, revoking the table privilege would leave a silent bypass, so stop
  -- instead of pretending the boundary was established.
  if exists (
    select 1
      from pg_catalog.pg_attribute a,
           lateral pg_catalog.aclexplode(a.attacl) as x
     where a.attrelid = 'public.users'::regclass
       and a.attnum > 0 and not a.attisdropped
       and x.grantee in (
         select oid from pg_catalog.pg_roles where rolname in ('anon', 'authenticated')
       )
       and x.privilege_type in ('INSERT', 'UPDATE')
  ) then
    raise exception 'EWA-PRE-3: an explicit column-level INSERT or UPDATE grant to anon or authenticated exists on public.users; refusing to leave a bypass.';
  end if;
end;
$preflight$;

-- ── Direct client writes ────────────────────────────────────────────────────

revoke insert, update on table public.users from anon, authenticated;

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the resulting privileges rather than assuming the statement above had
-- the intended effect, at both table and column level.

do $postflight$
begin
  if pg_catalog.has_table_privilege('anon', 'public.users', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.users', 'INSERT') then
    raise exception 'EWA-POST-1: a browser role still holds table-level INSERT on public.users.';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.users', 'UPDATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.users', 'UPDATE') then
    raise exception 'EWA-POST-2: a browser role still holds table-level UPDATE on public.users.';
  end if;

  if pg_catalog.has_any_column_privilege('anon', 'public.users', 'INSERT')
     or pg_catalog.has_any_column_privilege('authenticated', 'public.users', 'INSERT') then
    raise exception 'EWA-POST-3: a browser role can still INSERT a column of public.users.';
  end if;

  if pg_catalog.has_any_column_privilege('anon', 'public.users', 'UPDATE')
     or pg_catalog.has_any_column_privilege('authenticated', 'public.users', 'UPDATE') then
    raise exception 'EWA-POST-4: a browser role can still UPDATE a column of public.users.';
  end if;

  if not pg_catalog.has_table_privilege('authenticated', 'public.users', 'SELECT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.users', 'DELETE') then
    raise exception 'EWA-POST-5: authenticated SELECT/DELETE on public.users must be unchanged.';
  end if;

  if not pg_catalog.has_table_privilege('service_role', 'public.users', 'SELECT')
     or not pg_catalog.has_table_privilege('service_role', 'public.users', 'INSERT')
     or not pg_catalog.has_table_privilege('service_role', 'public.users', 'UPDATE')
     or not pg_catalog.has_table_privilege('service_role', 'public.users', 'DELETE') then
    raise exception 'EWA-POST-6: service_role authority on public.users must be unchanged.';
  end if;
end;
$postflight$;

commit;
