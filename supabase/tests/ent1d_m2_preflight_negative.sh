#!/usr/bin/env bash
# ============================================================================
# ENT-1D — M2 fail-closed and atomicity cases (DISPOSABLE LOCAL STACK ONLY)
# ============================================================================
#
# Usage: ent1d_m2_preflight_negative.sh <db-container> <expected-project-label>
#                                       <m1.sql> <m2.sql> <stack-workdir>
#
# Every case:
#   1. COMMITS a setup that reconstructs a starting state (snapshot S_setup);
#   2. runs the unmodified M2 in its own transaction (begin; M2; commit;) —
#      or, for the runner case, through `supabase migration up` exactly as
#      the CLI applies a pending migration;
#   3. requires the exact failure code, and requires the post-attempt snapshot
#      to EQUAL S_setup: nothing M2 did before failing survived;
#   4. restores the baseline (pre-M2 accepted ACLs, then the real M2) and
#      requires the snapshot to equal the run's baseline S0 again.
# The snapshot covers exploded table/column/schema/default ACLs (grantor,
# grantee, privilege, grant option), RLS flags, policies, memberships, test
# roles, the lease columns and the M2 ledger row.
#
# Two starting profiles are accepted (see the M2 header): the production
# profile (PRE_M2 below) and the PRICING-2 SEC0A profile (SEC0A_PRE_M2, which
# additionally lacks TRUNCATE, REFERENCES, TRIGGER and MAINTAIN). Both must
# end at the identical baseline snapshot S0; every mix, subset or other drift
# must fail closed with nothing surviving.

set -u
DB="$1"; LABEL="$2"; M1="$3"; M2="$4"; WORKDIR="$5"
FAIL=0
M2_VERSION=20261026120100

label=$(docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$DB" 2>/dev/null)
if [ "$label" != "$LABEL" ]; then echo "TARGET_MISMATCH: $DB is '$label', expected '$LABEL'"; exit 2; fi

psql_run() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -X -q -f -; }
psql_at() { docker exec -i "$DB" psql -U postgres -X -At -f -; }
# anon and authenticated are reserved roles: only a superuser may change their
# attributes or memberships. Used only by C33/C34 on this disposable stack.
psql_admin() { docker exec -i "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -X -q -f -; }

SNAPSHOT_SQL="select md5(string_agg(x, '|' order by x)) from (
  select 'tbl:' || c.relname || ':' || x.grantor::regrole || '>' || x.grantee || ':' || x.privilege_type || ':' || x.is_grantable as x
    from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
  union all
  select 'col:' || a.attrelid::regclass || '.' || a.attname || ':' || x.grantor::regrole || '>' || x.grantee || ':' || x.privilege_type || ':' || x.is_grantable
    from pg_attribute a cross join lateral aclexplode(a.attacl) x
   where a.attrelid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass) and a.attacl is not null
  union all
  select 'nsp:' || x.grantee || ':' || x.privilege_type || ':' || x.is_grantable
    from pg_namespace n cross join lateral aclexplode(n.nspacl) x where n.nspname = 'public'
  union all
  select 'defacl:' || d.defaclrole::regrole || ':' || d.defaclobjtype::text || ':' || x.grantee || ':' || x.privilege_type
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) x
  union all
  select 'rls:' || c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity
    from pg_class c where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
  union all
  select 'pol:' || p.polrelid::regclass || ':' || p.polname || ':' || p.polcmd::text || ':' || p.polpermissive || ':' || p.polroles::text
         || ':' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    from pg_policy p where p.polrelid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
  union all
  select 'mem:' || m.roleid::regrole || '>' || m.member::regrole from pg_auth_members m
   where m.member in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
  union all
  select 'role:' || rolname from pg_roles where rolname like 'ent1d_test_%'
  union all
  select 'lease:' || count(*) from pg_attribute
   where attrelid = 'public.swing_analysis'::regclass and attname in ('processing_claim_id','processing_started_at','processing_heartbeat_at','provider_dispatched_at') and not attisdropped
  union all
  select 'ledger_m2:' || count(*) from supabase_migrations.schema_migrations where version = '$M2_VERSION'
  union all
  select 'ledger_max:' || max(version) from supabase_migrations.schema_migrations
  union all
  select 'own:' || c.relname || ':' || c.relowner::regrole from pg_class c
   where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
  union all
  select 'ratt:' || rolname || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname in ('anon', 'authenticated')
) s;"

# A snapshot must be a real digest; an empty or failed one aborts the run.
snapshot() {
  local v; v=$(echo "$SNAPSHOT_SQL" | docker exec -i "$DB" psql -U postgres -X -At -v ON_ERROR_STOP=1 -f - 2>&1)
  if ! [[ "$v" =~ ^[0-9a-f]{32}$ ]]; then echo "SNAPSHOT_FAILED: $v" >&2; kill -TERM $$; exit 2; fi
  echo "$v"
}
trap 'echo "M2_NEGATIVE_RESULT=FAIL (aborted)"; exit 2' TERM

# The accepted pre-M2 state (baseline grants minus the ARA revokes), from any
# starting point: every browser privilege cleared at table and column level,
# then exactly the pre-M2 sets granted; service_role keeps everything.
PRE_M2="
revoke all privileges on table public.swing_analysis, public.swing_videos from public, anon, authenticated;
do \$c\$ declare r record; begin
  for r in select c.relname, a.attname, x.privilege_type,
                  case when x.grantee = 0 then 'public' else quote_ident(g.rolname) end as grantee
             from pg_class c join pg_attribute a on a.attrelid = c.oid
             cross join lateral aclexplode(a.attacl) x left join pg_roles g on g.oid = x.grantee
            where c.oid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass)
              and a.attnum > 0 and (x.grantee = 0 or g.rolname in ('anon', 'authenticated'))
  loop execute format('revoke %s (%I) on table public.%I from %s', r.privilege_type, r.attname, r.relname, r.grantee); end loop;
end \$c\$;
grant select, delete, truncate, references, trigger, maintain on table public.swing_analysis to anon, authenticated;
grant select, insert, delete, truncate, references, trigger, maintain on table public.swing_videos to anon, authenticated;
grant all privileges on table public.swing_analysis, public.swing_videos to service_role;
"

# The staging starting state: the production profile after PRICING-2 SEC0A.
SEC0A_PRE_M2="$PRE_M2
revoke truncate, references, trigger, maintain on table public.swing_analysis, public.swing_videos from anon, authenticated;
"

# Undo anything a case set up, then re-establish the post-M2 baseline with the real M2.
RESTORE="
alter table public.swing_analysis owner to postgres;
alter table public.swing_videos owner to postgres;
revoke grant option for all privileges on table public.swing_analysis, public.swing_videos from service_role cascade;
do \$r\$ declare r record; begin
  for r in select rolname from pg_roles where rolname like 'ent1d_test_%' loop
    execute format('revoke all privileges on table public.swing_analysis, public.swing_videos from %I cascade', r.rolname);
    execute format('revoke all on schema public from %I', r.rolname);
    execute format('revoke %I from anon, authenticated, postgres', r.rolname);
    execute format('drop role %I', r.rolname);
  end loop;
end \$r\$;
alter table public.swing_analysis enable row level security;
alter table public.swing_videos enable row level security;
do \$p\$ begin
  if not exists (select 1 from pg_policy where polrelid = 'public.swing_analysis'::regclass and polname = 'Users can view own analysis') then
    create policy \"Users can view own analysis\" on public.swing_analysis for select using (auth.uid() = user_id);
  end if;
end \$p\$;
$PRE_M2
"

restore_and_check() {
  local name="$1" needs_m1="${2:-no}"
  local out code
  out=$( { echo "begin;"; echo "$RESTORE"; [ "$needs_m1" = yes ] && cat "$M1"; cat "$M2"; echo "commit;"; } | psql_run 2>&1 ); code=$?
  local now; now=$(snapshot)
  if [ $code -ne 0 ] || [ "$now" != "$S0" ]; then
    echo "  RESTORE after $name FAILED (exit $code, baseline_match=$([ "$now" = "$S0" ] && echo yes || echo no))"; echo "$out" | tail -5
    # Every later case would run against an unknown state: stop here.
    echo "M2_NEGATIVE_RESULT=FAIL (aborted: baseline not restored)"; exit 2
  fi
  echo "  restored to baseline after $name"
}

# case <name> <setup-sql> <expected-code|SUCCESS> [needs_m1_on_restore]
run_case() {
  local name="$1" setup="$2" expect="$3" needs_m1="${4:-no}"
  local out code s_setup s_after verdict="PASS" observed
  out=$( { echo "begin;"; echo "$setup"; echo "commit;"; } | psql_run 2>&1 ) || { echo "CASE $name | SETUP_FAILED"; echo "$out" | tail -5; FAIL=1; restore_and_check "$name" "$needs_m1"; return; }
  s_setup=$(snapshot)
  out=$( { echo "begin;"; cat "$M2"; echo "commit;"; } | psql_run 2>&1 ); code=$?
  s_after=$(snapshot)
  observed=$(echo "$out" | grep -oE 'ENT1D-PRIV-(PRE|POST)-[0-9]+' | head -1)
  if [ "$expect" = SUCCESS ]; then
    [ $code -eq 0 ] || verdict="FAIL(exit $code)"
    [ "$s_after" = "$S0" ] || verdict="$verdict;NOT_BASELINE"
  else
    [ $code -ne 0 ] || verdict="FAIL(no error)"
    [ "$observed" = "$expect" ] || verdict="FAIL(observed ${observed:-none})"
    [ "$s_after" = "$s_setup" ] || verdict="$verdict;PARTIAL_STATE_SURVIVED"
    { [ "$s_setup" != "$S0" ] && [ "$s_setup" != "$S_PROD" ] && [ "$s_setup" != "$S_SEC0A" ]; } || verdict="$verdict;SETUP_NOOP"
  fi
  [ "$verdict" = PASS ] || FAIL=1
  echo "CASE $name | exit=$code | expected=$expect | observed=${observed:-none} | after_equals_setup=$([ "$s_after" = "$s_setup" ] && echo yes || echo no) | $verdict"
  restore_and_check "$name" "$needs_m1"
}

# The stack and WORKDIR must stop exactly at M2: a runner case must not apply
# anything else, and the ledger head is part of every snapshot.
last_file=$(ls "$WORKDIR/supabase/migrations" | tail -1)
ledger_head=$(echo "select max(version) from supabase_migrations.schema_migrations;" | psql_at)
if [ "${last_file%%_*}" != "$M2_VERSION" ] || [ "$ledger_head" != "$M2_VERSION" ]; then
  echo "WORKDIR_OR_LEDGER_NOT_AT_M2: last_file=$last_file ledger_head=$ledger_head"; exit 2
fi
echo "WORKDIR_AND_LEDGER_AT_M2=$M2_VERSION"

S0=$(snapshot)
echo "BASELINE_SNAPSHOT=$S0"

# Snapshots of the two clean starting profiles (M2 ledger row present), so a
# drift setup that changes nothing is detected as SETUP_NOOP.
out=$( { echo "begin;"; echo "$PRE_M2"; echo "commit;"; } | psql_run 2>&1 ) || { echo "PROFILE_SETUP_FAILED"; echo "$out" | tail -3; exit 2; }
S_PROD=$(snapshot)
out=$( { echo "begin;"; echo "$SEC0A_PRE_M2"; echo "commit;"; } | psql_run 2>&1 ) || { echo "PROFILE_SETUP_FAILED"; echo "$out" | tail -3; exit 2; }
S_SEC0A=$(snapshot)
echo "PROFILE_SNAPSHOTS production=$S_PROD sec0a=$S_SEC0A distinct=$([ "$S_PROD" != "$S_SEC0A" ] && [ "$S_PROD" != "$S0" ] && echo yes || echo NO)"
restore_and_check "profile snapshots"

run_case "C1 M1 prerequisites missing" "
alter table public.swing_analysis drop constraint swing_analysis_processing_claim_shape,
  drop column provider_dispatched_at, drop column processing_heartbeat_at,
  drop column processing_started_at, drop column processing_claim_id;" "ENT1D-PRIV-PRE-1" yes

run_case "C2 RLS disabled on swing_videos" "$PRE_M2
alter table public.swing_videos disable row level security;" "ENT1D-PRIV-PRE-2"

run_case "C3 no SELECT policy on swing_analysis" "$PRE_M2
drop policy \"Users can view own analysis\" on public.swing_analysis;" "ENT1D-PRIV-PRE-3"

run_case "C4 ACL drift: authenticated UPDATE on swing_analysis" "$PRE_M2
grant update on table public.swing_analysis to authenticated;" "ENT1D-PRIV-PRE-5"

run_case "C5 ACL drift: grant option on SELECT" "$PRE_M2
grant select on table public.swing_analysis to authenticated with grant option;" "ENT1D-PRIV-PRE-5"

run_case "C6 ACL drift: authenticated UPDATE on swing_videos" "$PRE_M2
grant update on table public.swing_videos to authenticated;" "ENT1D-PRIV-PRE-6"

run_case "C7 service_role drift" "$PRE_M2
revoke delete on table public.swing_analysis from service_role;" "ENT1D-PRIV-PRE-7"

run_case "C8 PUBLIC grant" "$PRE_M2
grant select on table public.swing_videos to public;" "ENT1D-PRIV-PRE-8"

run_case "C9 additional grantor (swing_analysis)" "$PRE_M2
create role ent1d_test_grantor nologin;
grant select on table public.swing_analysis to ent1d_test_grantor with grant option;
grant ent1d_test_grantor to postgres with set true;
set local role ent1d_test_grantor;
grant select on table public.swing_analysis to authenticated;
reset role;" "ENT1D-PRIV-PRE-9"

run_case "C10 authenticated inherits SELECT through a role" "$PRE_M2
create role ent1d_test_inherit nologin;
grant select on table public.swing_analysis to ent1d_test_inherit;
grant ent1d_test_inherit to authenticated;" "ENT1D-PRIV-PRE-11"

run_case "C11 anon inherits SELECT through a role" "$PRE_M2
create role ent1d_test_anon_inherit nologin;
grant select on table public.swing_analysis to ent1d_test_anon_inherit;
grant ent1d_test_anon_inherit to anon;" "ENT1D-PRIV-PRE-11"

run_case "C12 positive control: exact pre-M2 state" "$PRE_M2" SUCCESS

run_case "C13 column-level drift before M2 fails closed" "$PRE_M2
grant select (metrics, putting_analysis) on table public.swing_analysis to authenticated;
grant update (status) on table public.swing_videos to authenticated;" "ENT1D-PRIV-PRE-10"

run_case "C15 positive control: exact SEC0A (staging) state ends at the same baseline" "$SEC0A_PRE_M2" SUCCESS

run_case "C16 mixed profiles: anon production, authenticated SEC0A" "$PRE_M2
revoke truncate, references, trigger, maintain on table public.swing_analysis, public.swing_videos from authenticated;" "ENT1D-PRIV-PRE-5"

run_case "C17 mixed tables: SEC0A swing_analysis, production swing_videos" "$PRE_M2
revoke truncate, references, trigger, maintain on table public.swing_analysis from anon, authenticated;" "ENT1D-PRIV-PRE-6"

run_case "C18 arbitrary stricter subset (SELECT only on swing_analysis)" "$SEC0A_PRE_M2
revoke delete on table public.swing_analysis from anon, authenticated;" "ENT1D-PRIV-PRE-5"

run_case "C19 SEC0A profile with a grant option" "$SEC0A_PRE_M2
grant select on table public.swing_analysis to authenticated with grant option;" "ENT1D-PRIV-PRE-5"

run_case "C20 SEC0A profile plus UPDATE on swing_videos" "$SEC0A_PRE_M2
grant update on table public.swing_videos to authenticated;" "ENT1D-PRIV-PRE-6"

run_case "C21 SEC0A profile with an additional grantor" "$SEC0A_PRE_M2
create role ent1d_test_grantor2 nologin;
grant select on table public.swing_videos to ent1d_test_grantor2 with grant option;
grant ent1d_test_grantor2 to postgres with set true;
set local role ent1d_test_grantor2;
grant select on table public.swing_videos to anon;
reset role;" "ENT1D-PRIV-PRE-9"

run_case "C22 SEC0A profile with an anon membership" "$SEC0A_PRE_M2
create role ent1d_test_member nologin;
grant ent1d_test_member to anon;" "ENT1D-PRIV-PRE-11"

run_case "C23 unexpected table grantee (no membership)" "$SEC0A_PRE_M2
create role ent1d_test_reader nologin;
grant select on table public.swing_videos to ent1d_test_reader;" "ENT1D-PRIV-PRE-12"

run_case "C24 SEC0A profile with column-level drift" "$SEC0A_PRE_M2
grant select (metrics) on table public.swing_analysis to anon;" "ENT1D-PRIV-PRE-10"

# ── C25: runner-level atomicity — M2 succeeds, then the runner's transaction
# fails; nothing M2 changed may survive (SEC0A starting state). ─────────────
out=$( { echo "begin;"; echo "$SEC0A_PRE_M2"; echo "commit;"; } | psql_run 2>&1 ) || { echo "C25 SETUP_FAILED"; FAIL=1; }
s_setup=$(snapshot)
out=$( { echo "begin;"; cat "$M2"; echo "select 1 / 0;"; echo "commit;"; } | psql_run 2>&1 ); code=$?
s_after=$(snapshot)
v=PASS; [ $code -ne 0 ] || v="FAIL(no error)"; echo "$out" | grep -q "division by zero" || v="$v;UNEXPECTED_ERROR"; echo "$out" | grep -qE 'ENT1D-PRIV-' && v="$v;M2_FAILED_INSTEAD"; [ "$s_after" = "$s_setup" ] || v="$v;PARTIAL_STATE_SURVIVED"; [ "$s_setup" != "$S0" ] || v="$v;SETUP_NOOP"
[ "$v" = PASS ] || FAIL=1
echo "CASE C25 M2 completes, runner transaction then fails (SEC0A start) | exit=$code | after_equals_setup=$([ "$s_after" = "$s_setup" ] && echo yes || echo no) | $v"
restore_and_check "C25"

run_case "C28 reverse mix: anon SEC0A, authenticated production" "$PRE_M2
revoke truncate, references, trigger, maintain on table public.swing_analysis, public.swing_videos from anon;" "ENT1D-PRIV-PRE-5"

run_case "C29 production profile with a grant option on swing_videos" "$PRE_M2
grant insert on table public.swing_videos to anon with grant option;" "ENT1D-PRIV-PRE-6"

run_case "C30 SEC0A profile plus a PUBLIC grant on swing_analysis" "$SEC0A_PRE_M2
grant select on table public.swing_analysis to public;" "ENT1D-PRIV-PRE-8"

run_case "C31 production profile with an unexpected grantee on swing_analysis" "$PRE_M2
create role ent1d_test_reader2 nologin;
grant select on table public.swing_analysis to ent1d_test_reader2;" "ENT1D-PRIV-PRE-12"

run_case "C32 SEC0A profile with a service_role grant option" "$SEC0A_PRE_M2
grant select on table public.swing_analysis to service_role with grant option;" "ENT1D-PRIV-PRE-7"

# ── C33/C34: reserved-role drift, set up and removed as the superuser ───────
# admin_case <name> <admin-setup> <admin-cleanup> <expected-code>
admin_case() {
  local name="$1" setup="$2" cleanup="$3" expect="$4" out code s_setup s_after observed v=PASS
  out=$( { echo "begin;"; echo "$SEC0A_PRE_M2"; echo "commit;"; } | psql_run 2>&1 ) || { echo "CASE $name | SETUP_FAILED"; FAIL=1; return; }
  out=$(echo "$setup" | psql_admin 2>&1) || { echo "CASE $name | ADMIN_SETUP_FAILED: $(echo "$out" | tail -1)"; FAIL=1; restore_and_check "$name"; return; }
  s_setup=$(snapshot)
  out=$( { echo "begin;"; cat "$M2"; echo "commit;"; } | psql_run 2>&1 ); code=$?
  s_after=$(snapshot); observed=$(echo "$out" | grep -oE 'ENT1D-PRIV-(PRE|POST)-[0-9]+' | head -1)
  [ $code -ne 0 ] || v="FAIL(no error)"; [ "$observed" = "$expect" ] || v="FAIL(observed ${observed:-none})"
  [ "$s_after" = "$s_setup" ] || v="$v;PARTIAL_STATE_SURVIVED"; [ "$s_setup" != "$S_SEC0A" ] || v="$v;SETUP_NOOP"
  out=$(echo "$cleanup" | psql_admin 2>&1) || { v="$v;ADMIN_CLEANUP_FAILED"; echo "$out" | tail -2; }
  [ "$v" = PASS ] || FAIL=1
  echo "CASE $name | exit=$code | expected=$expect | observed=${observed:-none} | after_equals_setup=$([ "$s_after" = "$s_setup" ] && echo yes || echo no) | $v"
  restore_and_check "$name"
}
admin_case "C33 anon is a member of authenticated" "grant authenticated to anon;" "revoke authenticated from anon;" "ENT1D-PRIV-PRE-11"
admin_case "C34 authenticated bypasses row level security" "alter role authenticated bypassrls;" "alter role authenticated nobypassrls;" "ENT1D-PRIV-PRE-13"

run_case "C35 table owned by a role other than postgres" "$PRE_M2
create role ent1d_test_owner nologin;
grant ent1d_test_owner to postgres;
grant create on schema public to ent1d_test_owner;
alter table public.swing_videos owner to ent1d_test_owner;" "ENT1D-PRIV-PRE-9"

# ── C36: double apply — M2 again on its own result (S0) must refuse ─────────
out=$( { echo "begin;"; cat "$M2"; echo "commit;"; } | psql_run 2>&1 ); code=$?
now=$(snapshot); observed=$(echo "$out" | grep -oE 'ENT1D-PRIV-(PRE|POST)-[0-9]+' | head -1)
v=PASS; [ $code -ne 0 ] || v="FAIL(no error)"; [ "$observed" = ENT1D-PRIV-PRE-5 ] || v="FAIL(observed ${observed:-none})"; [ "$now" = "$S0" ] || v="$v;STATE_CHANGED"
[ "$v" = PASS ] || FAIL=1
echo "CASE C36 double apply on the post-M2 state | exit=$code | expected=ENT1D-PRIV-PRE-5 | observed=${observed:-none} | state_unchanged=$([ "$now" = "$S0" ] && echo yes || echo no) | $v"

# ── C14: the real CLI migration runner, no outer transaction ──────────────────
out=$( { echo "begin;"; echo "delete from supabase_migrations.schema_migrations where version = '$M2_VERSION';"; echo "$PRE_M2"; echo "grant update on table public.swing_analysis to authenticated;"; echo "commit;"; } | psql_run 2>&1 ) || { echo "C14 SETUP_FAILED"; FAIL=1; }
s_setup=$(snapshot)
runner_out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); runner_code=$?
s_after=$(snapshot)
observed=$(echo "$runner_out" | grep -oE 'ENT1D-PRIV-(PRE|POST)-[0-9]+' | head -1)
v=PASS; [ $runner_code -ne 0 ] || v="FAIL(no error)"; [ "$observed" = ENT1D-PRIV-PRE-5 ] || v="FAIL(observed ${observed:-none})"; [ "$s_after" = "$s_setup" ] || v="$v;PARTIAL_STATE_SURVIVED"
[ "$v" = PASS ] || FAIL=1
echo "CASE C14 CLI runner (supabase migration up) with drift | exit=$runner_code | expected=ENT1D-PRIV-PRE-5 | observed=${observed:-none} | after_equals_setup=$([ "$s_after" = "$s_setup" ] && echo yes || echo no) | $v"
out=$( { echo "begin;"; echo "revoke update on table public.swing_analysis from authenticated;"; echo "commit;"; } | psql_run 2>&1 )
runner_out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); runner_code=$?
now=$(snapshot)
v=PASS; [ $runner_code -eq 0 ] || v="FAIL(exit $runner_code)"; [ "$now" = "$S0" ] || v="$v;NOT_BASELINE"
[ "$v" = PASS ] || FAIL=1
echo "CASE C14b CLI runner applies M2 after drift is removed; ledger restored | exit=$runner_code | baseline_match=$([ "$now" = "$S0" ] && echo yes || echo no) | $v"

# ── C26: the real CLI runner from the SEC0A (staging) starting state ─────────
out=$( { echo "begin;"; echo "delete from supabase_migrations.schema_migrations where version = '$M2_VERSION';"; echo "$SEC0A_PRE_M2"; echo "commit;"; } | psql_run 2>&1 ) || { echo "C26 SETUP_FAILED"; FAIL=1; }
runner_out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); runner_code=$?
now=$(snapshot)
v=PASS; [ $runner_code -eq 0 ] || v="FAIL(exit $runner_code)"; [ "$now" = "$S0" ] || v="$v;NOT_BASELINE"
[ "$v" = PASS ] || FAIL=1
echo "CASE C26 CLI runner applies M2 from the SEC0A state; ledger restored; same baseline | exit=$runner_code | baseline_match=$([ "$now" = "$S0" ] && echo yes || echo no) | $v"

# ── C27: the real CLI runner, failure AFTER M2's revokes in the same file ────
# The WORKDIR copy of M2 is temporarily followed by a failing statement; the
# runner must leave neither M2's privilege changes nor a ledger row behind.
wd_m2=$(ls "$WORKDIR"/supabase/migrations/${M2_VERSION}_*.sql); cp "$wd_m2" "$wd_m2.orig"
out=$( { echo "begin;"; echo "delete from supabase_migrations.schema_migrations where version = '$M2_VERSION';"; echo "$SEC0A_PRE_M2"; echo "commit;"; } | psql_run 2>&1 ) || { echo "C27 SETUP_FAILED"; FAIL=1; }
s_setup=$(snapshot)
printf '\nselect 1 / 0;\n' >> "$wd_m2"
runner_out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); runner_code=$?
mv "$wd_m2.orig" "$wd_m2"
s_after=$(snapshot)
v=PASS; [ $runner_code -ne 0 ] || v="FAIL(no error)"; echo "$runner_out" | grep -q "division by zero" || v="$v;UNEXPECTED_ERROR"; [ "$s_after" = "$s_setup" ] || v="$v;PARTIAL_STATE_SURVIVED"
[ "$v" = PASS ] || FAIL=1
echo "CASE C27 CLI runner: M2 then a failing statement in the same file (SEC0A start) | exit=$runner_code | after_equals_setup=$([ "$s_after" = "$s_setup" ] && echo yes || echo no) | $v"
runner_out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); runner_code=$?
now=$(snapshot)
v=PASS; [ $runner_code -eq 0 ] || v="FAIL(exit $runner_code)"; [ "$now" = "$S0" ] || v="$v;NOT_BASELINE"
[ "$v" = PASS ] || FAIL=1
echo "CASE C27b CLI runner then applies the unmodified M2 from the SEC0A state | exit=$runner_code | baseline_match=$([ "$now" = "$S0" ] && echo yes || echo no) | $v"

echo "M2_NEGATIVE_RESULT=$([ $FAIL -eq 0 ] && echo PASS || echo FAIL)"
exit $FAIL
