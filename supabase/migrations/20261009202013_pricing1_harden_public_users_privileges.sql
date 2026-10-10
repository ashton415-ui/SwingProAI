-- ============================================================================
-- PRICING-1 — public.users browser-role privilege hardening
-- ============================================================================
--
-- Why
-- ---
-- public.billing_checkout_guard references public.users(id) ON DELETE CASCADE
-- and holds the account's durable one-trial history. anon and authenticated
-- still hold table-level DELETE, TRUNCATE, REFERENCES, TRIGGER and (PostgreSQL
-- 17) MAINTAIN on public.users. None is used by any browser runtime path:
-- every profile write goes through the server-only service_role client or a
-- SECURITY DEFINER auth trigger. TRUNCATE ignores row level security
-- altogether, so the grant itself is the exposure.
--
-- What this migration does
-- ------------------------
-- Revokes DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on public.users
-- from anon and authenticated, leaving both with SELECT only, which the
-- existing RLS read policies continue to govern.
--
-- What this migration does NOT do
-- -------------------------------
-- It does not touch service_role, PUBLIC, SELECT, any RLS policy, column,
-- constraint, trigger, owner, row, auth.users, the billing guard table or the
-- billing functions. It contains no transaction control: the migration
-- runner owns the transaction.
--
-- How the checks work
-- -------------------
-- Every exact set is read from the table ACL itself through aclexplode, as
-- PRIVILEGE:grantable entries (for example SELECT:false). Every privilege
-- PostgreSQL 17 knows about, MAINTAIN included, and its grant option are
-- compared, so an extra, missing or newly grantable privilege fails closed.

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail closed unless the exact accepted starting state is present.

do $preflight$
declare
  v_rls boolean;
  v_anon text;
  v_authenticated text;
  v_service text;
  v_public integer;
  v_columns integer;
begin
  select c.relrowsecurity
    into v_rls
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'users' and c.relkind = 'r';

  if not found then
    raise exception 'PRICING1-HARDEN-PRE-1: public.users is missing.';
  end if;

  if not v_rls then
    raise exception 'PRICING1-HARDEN-PRE-2: row level security must be enabled on public.users.';
  end if;

  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_anon
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 'anon'::regrole;

  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_authenticated
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 'authenticated'::regrole;

  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_service
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 'service_role'::regrole;

  select count(*)
    into v_public
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 0;

  select count(*)
    into v_columns
    from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x
   where a.attrelid = 'public.users'::regclass and a.attnum > 0 and not a.attisdropped;

  if v_anon <> 'DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false' then
    raise exception 'PRICING1-HARDEN-PRE-3: anon privileges on public.users are % (expected DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false).', v_anon;
  end if;

  if v_authenticated <> 'DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false' then
    raise exception 'PRICING1-HARDEN-PRE-4: authenticated privileges on public.users are % (expected DELETE:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false).', v_authenticated;
  end if;

  if v_service <> 'DELETE:false,INSERT:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false,UPDATE:false' then
    raise exception 'PRICING1-HARDEN-PRE-5: service_role privileges on public.users are % (expected DELETE:false,INSERT:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false,UPDATE:false).', v_service;
  end if;

  if v_public <> 0 then
    raise exception 'PRICING1-HARDEN-PRE-6: PUBLIC holds a table privilege on public.users.';
  end if;

  if v_columns <> 0 then
    raise exception 'PRICING1-HARDEN-PRE-7: public.users carries column-level privileges.';
  end if;

  if pg_catalog.has_table_privilege('anon', 'public.users', 'INSERT')
     or pg_catalog.has_table_privilege('anon', 'public.users', 'UPDATE')
     or pg_catalog.has_table_privilege('authenticated', 'public.users', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.users', 'UPDATE') then
    raise exception 'PRICING1-HARDEN-PRE-8: a browser role can insert or update public.users.';
  end if;
end;
$preflight$;

-- ── The only privilege change ───────────────────────────────────────────────

revoke delete, truncate, references, trigger, maintain
  on table public.users
  from anon, authenticated;

-- ── Postflight ──────────────────────────────────────────────────────────────
-- Proves the exact resulting state rather than assuming the revoke worked.

do $postflight$
declare
  v_rls boolean;
  v_anon text;
  v_authenticated text;
  v_service text;
  v_public integer;
  v_columns integer;
  v_role text;
  v_priv text;
begin
  select c.relrowsecurity
    into v_rls
    from pg_catalog.pg_class c
   where c.oid = 'public.users'::regclass;

  if not v_rls then
    raise exception 'PRICING1-HARDEN-POST-1: row level security is no longer enabled on public.users.';
  end if;

  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_anon
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 'anon'::regrole;

  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_authenticated
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 'authenticated'::regrole;

  select coalesce(string_agg(distinct x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end, ',' order by x.privilege_type || ':' || case when x.is_grantable then 'true' else 'false' end), '')
    into v_service
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 'service_role'::regrole;

  select count(*)
    into v_public
    from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) x
   where c.oid = 'public.users'::regclass and x.grantee = 0;

  select count(*)
    into v_columns
    from pg_catalog.pg_attribute a, lateral pg_catalog.aclexplode(a.attacl) x
   where a.attrelid = 'public.users'::regclass and a.attnum > 0 and not a.attisdropped;

  if v_anon <> 'SELECT:false' then
    raise exception 'PRICING1-HARDEN-POST-2: anon privileges on public.users are % (expected SELECT:false).', v_anon;
  end if;

  if v_authenticated <> 'SELECT:false' then
    raise exception 'PRICING1-HARDEN-POST-3: authenticated privileges on public.users are % (expected SELECT:false).', v_authenticated;
  end if;

  if v_service <> 'DELETE:false,INSERT:false,MAINTAIN:false,REFERENCES:false,SELECT:false,TRIGGER:false,TRUNCATE:false,UPDATE:false' then
    raise exception 'PRICING1-HARDEN-POST-4: service_role privileges on public.users changed to %.', v_service;
  end if;

  if v_public <> 0 then
    raise exception 'PRICING1-HARDEN-POST-5: PUBLIC holds a table privilege on public.users.';
  end if;

  if v_columns <> 0 then
    raise exception 'PRICING1-HARDEN-POST-6: public.users carries column-level privileges.';
  end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if pg_catalog.has_table_privilege(v_role, 'public.users', v_priv) then
        raise exception 'PRICING1-HARDEN-POST-7: % still holds % on public.users.', v_role, v_priv;
      end if;
    end loop;

    if not pg_catalog.has_table_privilege(v_role, 'public.users', 'SELECT') then
      raise exception 'PRICING1-HARDEN-POST-8: % lost SELECT on public.users.', v_role;
    end if;
  end loop;
end;
$postflight$;
