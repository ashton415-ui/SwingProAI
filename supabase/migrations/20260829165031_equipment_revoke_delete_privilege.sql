-- ============================================================================
-- EQ3-DB3 — remove the Data API hard-delete path on public.user_equipment
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Exactly one privilege change:
--
--   revoke delete on table public.user_equipment from anon, authenticated;
--
-- Nothing else. No grant, no default-privilege change, no RLS change, no policy
-- change, no trigger, no function, no foreign key change, no column change, and
-- no application row is read, written, or inferred.
--
-- WHY A PRIVILEGE REVOKE
-- ----------------------
-- EQ3-DB2 changed the supported golfer action. "Remove from bag" is now an
-- UPDATE that sets is_archived = true, not a DELETE. Authenticated users still
-- need SELECT, INSERT and UPDATE on this table; they no longer need DELETE.
--
-- RLS and table grants are separate layers. The owner policy on this table is a
-- permissive FOR ALL policy, so while the table-level DELETE grant exists an
-- authenticated owner can still reach a hard-delete path on their own rows —
-- exactly the path DB1 and DB2 exist to retire. Removing the grant closes it at
-- the privilege layer, where a policy cannot re-open it.
--
-- WHY NOT A BEFORE DELETE TRIGGER
-- -------------------------------
-- public.user_equipment.user_id references auth.users(id) ON DELETE CASCADE, so
-- account deletion legitimately deletes these rows. A trigger that refused every
-- DELETE would therefore break account deletion, because a trigger fires on the
-- cascaded delete itself regardless of who initiated it. A privilege revoke does
-- not: table grants constrain the anon and authenticated Data API roles only,
-- and a referential CASCADE is not gated by them at all.
--
-- service_role is simply outside DB3's revoke scope, so its existing
-- privileged/admin DELETE capability is preserved for maintenance and for any
-- future explicitly authorized hard-delete workflow. That grant is not what
-- makes the cascade run; the unchanged foreign key is. Whether the full account
-- teardown path still works end to end is verified empirically in the later
-- staging-only account-deletion gate, not asserted here.
--
-- SCOPE BOUNDARY
-- --------------
-- Repository-side schema change only. Empirically verifying account deletion
-- against a live environment after this migration is separately authorized
-- later work, as is remediating the deferred equipment API/legacy delete
-- surfaces. Neither is attempted here.
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail closed unless the live security state is exactly what this
-- migration was written against. Catalogs and privilege functions only; no
-- application row is read.
-- ============================================================================
do $$
begin
  -- A. The target table exists as an ordinary table in the expected schema.
  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment' and c.relkind = 'r'
  ) then
    raise exception 'EQ3DB3-PRE-1: public.user_equipment does not exist as a table.';
  end if;

  -- Every role this migration reasons about must exist, so that the effective
  -- privilege checks below cannot fail for the wrong reason.
  if not (
    exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
    and exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
    and exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
  ) then
    raise exception 'EQ3DB3-PRE-2: one of the roles anon, authenticated, service_role does not exist.';
  end if;

  -- B. Row-level security state this migration assumes and must not change.
  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment' and c.relrowsecurity
  ) then
    raise exception 'EQ3DB3-PRE-3: row level security is not enabled on public.user_equipment.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment' and c.relforcerowsecurity
  ) then
    raise exception 'EQ3DB3-PRE-4: row level security is forced on public.user_equipment; this migration was written against the unforced state.';
  end if;

  -- C. The archive foundation must already exist. Revoking DELETE without the
  --    replacement lifecycle in place would leave golfers no way to remove a
  --    club at all, so DB3 must never apply to a database without DB1.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'is_archived'
      and data_type = 'boolean' and is_nullable = 'NO'
  ) then
    raise exception 'EQ3DB3-PRE-5: public.user_equipment.is_archived is missing or is not a NOT NULL boolean.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and a.attname = 'is_archived'
      and pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'
  ) then
    raise exception 'EQ3DB3-PRE-6: public.user_equipment.is_archived does not default to exactly false.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and a.attname = 'is_archived'
      and (a.attgenerated <> '' or a.attidentity <> '')
  ) then
    raise exception 'EQ3DB3-PRE-7: public.user_equipment.is_archived is generated or an identity column.';
  end if;

  -- D. Effective DELETE before the revoke. These are the privileges this
  --    migration exists to change, verified through the privilege functions
  --    rather than by reading ACL text, so inherited paths are included.
  if not pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3DB3-PRE-8: anon does not currently hold DELETE on public.user_equipment; the live state differs from the one this migration was written against.';
  end if;

  if not pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3DB3-PRE-9: authenticated does not currently hold DELETE on public.user_equipment.';
  end if;

  if not pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3DB3-PRE-10: service_role does not currently hold DELETE on public.user_equipment; the privileged system path must exist before it can be preserved.';
  end if;

  -- E. The privileges this migration must NOT disturb. Recorded before the
  --    change so postflight can prove preservation rather than assume it.
  if not (
    pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'SELECT')
    and pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'INSERT')
    and pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'UPDATE')
  ) then
    raise exception 'EQ3DB3-PRE-11: anon does not hold the expected SELECT, INSERT and UPDATE on public.user_equipment.';
  end if;

  if not (
    pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'SELECT')
    and pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'INSERT')
    and pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'UPDATE')
  ) then
    raise exception 'EQ3DB3-PRE-12: authenticated does not hold the expected SELECT, INSERT and UPDATE on public.user_equipment; the archive write depends on UPDATE.';
  end if;

  if not (
    pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'SELECT')
    and pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'INSERT')
    and pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'UPDATE')
  ) then
    raise exception 'EQ3DB3-PRE-13: service_role does not hold the expected SELECT, INSERT and UPDATE on public.user_equipment.';
  end if;

  -- F. A direct DELETE grant to PUBLIC would survive revoking the two named
  --    roles, so it must not exist. Read from the exploded ACL rather than from
  --    the rendered relacl text; grantee 0 is PUBLIC.
  if exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
      ) as acl
      where n.nspname = 'public' and c.relname = 'user_equipment'
        and acl.grantee = 0
        and acl.privilege_type = 'DELETE'
  ) then
    raise exception 'EQ3DB3-PRE-14: public.user_equipment carries a direct DELETE grant to PUBLIC, which this revoke would not remove.';
  end if;

  -- G. The owner policy. This migration does not touch it; it is pinned because
  --    the privilege layer and the policy layer only make sense together, and a
  --    changed policy means the security model is no longer the reviewed one.
  if (
    select count(*) from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
  ) <> 1 then
    raise exception 'EQ3DB3-PRE-15: public.user_equipment does not carry exactly one policy.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and p.polname = 'Users manage own equipment'
      and p.polpermissive
      and p.polcmd = '*'
      and p.polroles = array[0]::oid[]
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'
      and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'
  ) then
    raise exception 'EQ3DB3-PRE-16: the owner policy on public.user_equipment is not the expected permissive FOR ALL policy to PUBLIC with owner USING and WITH CHECK expressions.';
  end if;

  -- H. Account deletion cascades through this column. Proven from the catalog:
  --    exact schema-qualified relations on both sides, exact single-column keys,
  --    and the CASCADE delete action itself (confdeltype 'c').
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'user_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.contype = 'f'
        and child_ns.nspname = 'public' and child_rel.relname = 'user_equipment'
        and parent_ns.nspname = 'auth' and parent_rel.relname = 'users'
        and not child_attr.attisdropped and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'c'
  ) then
    raise exception 'EQ3DB3-PRE-17: public.user_equipment.user_id is not exactly a single-column foreign key to auth.users.id with delete action CASCADE.';
  end if;

  -- I. The historical analysis reference, which is the reason archiving exists.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'club_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.contype = 'f'
        and child_ns.nspname = 'public' and child_rel.relname = 'swing_analysis'
        and parent_ns.nspname = 'public' and parent_rel.relname = 'user_equipment'
        and not child_attr.attisdropped and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'n'
  ) then
    raise exception 'EQ3DB3-PRE-18: public.swing_analysis.club_id is not exactly a single-column foreign key to public.user_equipment.id with delete action SET NULL.';
  end if;

  -- J. The historical telemetry reference, which carries the same action with no
  --    immutability guard behind it.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'club_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.contype = 'f'
        and child_ns.nspname = 'public' and child_rel.relname = 'swing_telemetry'
        and parent_ns.nspname = 'public' and parent_rel.relname = 'user_equipment'
        and not child_attr.attisdropped and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'n'
  ) then
    raise exception 'EQ3DB3-PRE-19: public.swing_telemetry.club_id is not exactly a single-column foreign key to public.user_equipment.id with delete action SET NULL.';
  end if;

  -- K. The equipment immutability guard on recorded analyses.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'swing_analysis'
      and t.tgname = 'swing_analysis_guard_equipment_immutability'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
  ) then
    raise exception 'EQ3DB3-PRE-20: trigger swing_analysis_guard_equipment_immutability is missing or disabled on public.swing_analysis.';
  end if;

  -- L. The DB3 mechanism is privileges, not a trigger. A pre-existing
  --    delete-blocking trigger would mean a second, unreviewed mechanism is
  --    already in play — and would be the thing that breaks account deletion.
  --    Trigger event bits: 1<<3 is DELETE.
  if exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and not t.tgisinternal
      and (t.tgtype & 8) <> 0
  ) then
    raise exception 'EQ3DB3-PRE-21: public.user_equipment already carries a DELETE-event trigger; DB3 does not add or expect one.';
  end if;
end
$$;

-- ============================================================================
-- PRIVILEGE CHANGE — one statement. service_role is deliberately not a revoke
-- target, so its existing privileged/admin DELETE capability is preserved.
-- ============================================================================

revoke delete on table public.user_equipment from anon, authenticated;

-- ============================================================================
-- POSTFLIGHT — prove through the catalogs and privilege functions that exactly
-- the intended change took effect and that nothing else moved. Everything runs
-- in the same transaction, so any failure here rolls the revoke back.
-- ============================================================================
do $$
begin
  -- A. The Data API delete path is closed. Effective privileges, so an
  --    inherited or PUBLIC path that survived the revoke still fails here.
  if pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3DB3-POST-1: anon still holds effective DELETE on public.user_equipment.';
  end if;

  if pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3DB3-POST-2: authenticated still holds effective DELETE on public.user_equipment.';
  end if;

  -- B. The privileged/admin delete capability is preserved. service_role was
  --    never a revoke target, so losing it here would mean this migration did
  --    something outside its locked scope. This is not a claim about the
  --    account-deletion cascade, which the unchanged foreign key carries.
  if not pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'DELETE') then
    raise exception 'EQ3DB3-POST-3: service_role lost DELETE on public.user_equipment.';
  end if;

  -- C. The archive path remains viable for every role that had it.
  if not (
    pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'SELECT')
    and pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'INSERT')
    and pg_catalog.has_table_privilege('anon', 'public.user_equipment', 'UPDATE')
  ) then
    raise exception 'EQ3DB3-POST-4: anon lost SELECT, INSERT or UPDATE on public.user_equipment.';
  end if;

  if not (
    pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'SELECT')
    and pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'INSERT')
    and pg_catalog.has_table_privilege('authenticated', 'public.user_equipment', 'UPDATE')
  ) then
    raise exception 'EQ3DB3-POST-5: authenticated lost SELECT, INSERT or UPDATE on public.user_equipment; the archive write would break.';
  end if;

  if not (
    pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'SELECT')
    and pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'INSERT')
    and pg_catalog.has_table_privilege('service_role', 'public.user_equipment', 'UPDATE')
  ) then
    raise exception 'EQ3DB3-POST-6: service_role lost SELECT, INSERT or UPDATE on public.user_equipment.';
  end if;

  -- D. No direct PUBLIC delete path appeared.
  if exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
      ) as acl
      where n.nspname = 'public' and c.relname = 'user_equipment'
        and acl.grantee = 0
        and acl.privilege_type = 'DELETE'
  ) then
    raise exception 'EQ3DB3-POST-7: public.user_equipment now carries a direct DELETE grant to PUBLIC.';
  end if;

  -- E. Row-level security is exactly as it was.
  if not exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and c.relrowsecurity and not c.relforcerowsecurity
  ) then
    raise exception 'EQ3DB3-POST-8: row level security on public.user_equipment is no longer enabled-and-unforced.';
  end if;

  -- F. The owner policy is untouched and still the only one.
  if (
    select count(*) from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
  ) <> 1 then
    raise exception 'EQ3DB3-POST-9: public.user_equipment no longer carries exactly one policy.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy p
    join pg_catalog.pg_class c on c.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and p.polname = 'Users manage own equipment'
      and p.polpermissive
      and p.polcmd = '*'
      and p.polroles = array[0]::oid[]
      and pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) = '(auth.uid() = user_id)'
      and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) = '(auth.uid() = user_id)'
  ) then
    raise exception 'EQ3DB3-POST-10: the owner policy on public.user_equipment changed.';
  end if;

  -- G. The archive column is untouched.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_equipment'
      and column_name = 'is_archived'
      and data_type = 'boolean' and is_nullable = 'NO'
  ) then
    raise exception 'EQ3DB3-POST-11: public.user_equipment.is_archived is no longer a NOT NULL boolean.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and a.attname = 'is_archived'
      and a.attgenerated = '' and a.attidentity = ''
      and pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) = 'false'
  ) then
    raise exception 'EQ3DB3-POST-12: public.user_equipment.is_archived no longer defaults to exactly false as a plain stored column.';
  end if;

  -- H. The account-deletion cascade is untouched.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'user_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.contype = 'f'
        and child_ns.nspname = 'public' and child_rel.relname = 'user_equipment'
        and parent_ns.nspname = 'auth' and parent_rel.relname = 'users'
        and not child_attr.attisdropped and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'c'
  ) then
    raise exception 'EQ3DB3-POST-13: the auth.users cascade on public.user_equipment.user_id changed.';
  end if;

  -- I. The historical analysis reference is untouched.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'club_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.contype = 'f'
        and child_ns.nspname = 'public' and child_rel.relname = 'swing_analysis'
        and parent_ns.nspname = 'public' and parent_rel.relname = 'user_equipment'
        and not child_attr.attisdropped and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'n'
  ) then
    raise exception 'EQ3DB3-POST-14: the public.swing_analysis.club_id reference to public.user_equipment.id changed.';
  end if;

  -- J. The historical telemetry reference is untouched.
  if not exists (
    select 1
      from pg_catalog.pg_constraint fk
      join pg_catalog.pg_class child_rel on child_rel.oid = fk.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child_rel.relnamespace
      join pg_catalog.pg_class parent_rel on parent_rel.oid = fk.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent_rel.relnamespace
      join pg_catalog.pg_attribute child_attr
        on child_attr.attrelid = fk.conrelid and child_attr.attname = 'club_id'
      join pg_catalog.pg_attribute parent_attr
        on parent_attr.attrelid = fk.confrelid and parent_attr.attname = 'id'
      where fk.contype = 'f'
        and child_ns.nspname = 'public' and child_rel.relname = 'swing_telemetry'
        and parent_ns.nspname = 'public' and parent_rel.relname = 'user_equipment'
        and not child_attr.attisdropped and not parent_attr.attisdropped
        and fk.conkey = array[child_attr.attnum]::smallint[]
        and fk.confkey = array[parent_attr.attnum]::smallint[]
        and fk.confdeltype = 'n'
  ) then
    raise exception 'EQ3DB3-POST-15: the public.swing_telemetry.club_id reference to public.user_equipment.id changed.';
  end if;

  -- K. The immutability guard survived.
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'swing_analysis'
      and t.tgname = 'swing_analysis_guard_equipment_immutability'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
  ) then
    raise exception 'EQ3DB3-POST-16: trigger swing_analysis_guard_equipment_immutability is no longer present and enabled.';
  end if;

  -- L. No delete-blocking trigger was introduced. The mechanism stays a
  --    privilege revoke, so account deletion is unaffected.
  if exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_equipment'
      and not t.tgisinternal
      and (t.tgtype & 8) <> 0
  ) then
    raise exception 'EQ3DB3-POST-17: a DELETE-event trigger now exists on public.user_equipment.';
  end if;
end
$$;

commit;
