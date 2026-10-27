#!/usr/bin/env bash
# ============================================================================
# ENT-1D — fail-closed prerequisites of the claim-proof, execution-guard and
# video-source-guard migrations (DISPOSABLE LOCAL STACK ONLY)
# ============================================================================
#
# Usage: ent1d_guard_preflight_negative.sh <db-container> <expected-label> <proof.sql> <guard.sql> <video.sql>
#
# Run against a stack that has every migration through 20261026120100 (so the
# proof column is present and the two guards are not). Every case runs
#   begin; <setup>; <unmodified migration>; rollback;
# and requires the exact failure code (or, for a positive control, success),
# then requires the schema fingerprint to equal the starting one.

set -u
DB="$1"; LABEL="$2"; PROOF="$3"; GUARD="$4"; VIDEO="$5"
label=$(docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$DB" 2>/dev/null)
if [ "$label" != "$LABEL" ]; then echo "TARGET_MISMATCH: $DB is '$label', expected '$LABEL'"; exit 2; fi
FAIL=0

FINGERPRINT_SQL="select md5(string_agg(x, '|' order by x)) from (
  select 'fn:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'ent1d_%'
  union all select 'tg:' || tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text from pg_trigger
   where tgrelid in ('public.swing_analysis'::regclass, 'public.swing_videos'::regclass) and not tgisinternal
  union all select 'ck:' || conname || ':' || convalidated::text from pg_constraint where conrelid = 'public.swing_analysis'::regclass
  union all select 'col:' || attname from pg_attribute where attrelid = 'public.swing_analysis'::regclass and attnum > 0 and not attisdropped
  union all select 'rls:' || relrowsecurity::text from pg_class where oid = 'public.swing_videos'::regclass
  union all select 'acl:' || coalesce(attacl::text, '') from pg_attribute where attrelid = 'public.swing_analysis'::regclass and attname = 'metrics'
) s;"
# A fingerprint must be a real digest. A failure aborts the whole run: it is
# called inside $(...), so it signals the main shell rather than exiting a
# subshell, and every comparison would otherwise be between two error texts.
trap 'echo "GUARD_PREFLIGHT_RESULT=FAIL (aborted: fingerprint failed)"; exit 2' TERM
fingerprint() {
  local v; v=$(echo "$FINGERPRINT_SQL" | docker exec -i "$DB" psql -U postgres -X -At -v ON_ERROR_STOP=1 -f - 2>&1)
  if ! [[ "$v" =~ ^[0-9a-f]{32}$ ]]; then echo "FINGERPRINT_FAILED: $v" >&2; kill -TERM $$; exit 2; fi
  echo "$v"
}

S0=$(fingerprint)
echo "BASELINE_FINGERPRINT=$S0"

# case <name> <migration file> <setup sql> <expected code | SUCCESS>
run_case() {
  local name="$1" file="$2" setup="$3" expect="$4" out code observed verdict=PASS
  out=$( { echo "begin;"; echo "$setup"; cat "$file"; echo "rollback;"; } | docker exec -i "$DB" psql -U postgres -X -q -v ON_ERROR_STOP=1 -f - 2>&1 ); code=$?
  observed=$(echo "$out" | grep -oE 'ENT1D-(PROOF|GUARD|VIDEO)-(PRE|POST)-[0-9]+' | head -1)
  if [ "$expect" = SUCCESS ]; then
    [ $code -eq 0 ] || verdict="FAIL(exit $code: $(echo "$out" | grep -m1 ERROR))"
  else
    [ $code -ne 0 ] || verdict="FAIL(no error)"
    [ "$observed" = "$expect" ] || verdict="FAIL(observed ${observed:-none})"
  fi
  local after; after=$(fingerprint)
  [ "$after" = "$S0" ] || verdict="$verdict;STATE_CHANGED"
  [ "$verdict" = PASS ] || FAIL=1
  echo "CASE $name | exit=$code | expected=$expect | observed=${observed:-none} | state_unchanged=$([ "$after" = "$S0" ] && echo yes || echo no) | $verdict"
}

# ── 20261026120050 claim proof column ─────────────────────────────────────────
run_case "P1 proof column: lease CHECK missing" "$PROOF" \
  "alter table public.swing_analysis drop constraint swing_analysis_processing_claim_shape;" ENT1D-PROOF-PRE-1
run_case "P1b proof column: a lease column missing" "$PROOF" \
  "alter table public.swing_analysis drop constraint swing_analysis_processing_claim_shape; alter table public.swing_analysis drop column provider_dispatched_at;" ENT1D-PROOF-PRE-1
run_case "P2 proof column: already applied (no re-run)" "$PROOF" "" ENT1D-PROOF-PRE-2
run_case "P3 proof column: a guard function already exists" "$PROOF" \
  "alter table public.swing_analysis drop constraint swing_analysis_claim_proof_transient; drop trigger swing_analysis_execution_guard on public.swing_analysis; alter table public.swing_analysis drop column processing_claim_proof;" \
  ENT1D-PROOF-PRE-3
run_case "P4 proof column: positive control (applies on a lease-only schema)" "$PROOF" \
  "alter table public.swing_analysis drop constraint swing_analysis_claim_proof_transient; drop trigger swing_analysis_execution_guard on public.swing_analysis; drop function public.ent1d_swing_analysis_execution_guard(); alter table public.swing_analysis drop column processing_claim_proof;" \
  SUCCESS

# ── 20261027120000 execution claim guard ──────────────────────────────────────
run_case "G1 guard: execution lease missing" "$GUARD" \
  "alter table public.swing_analysis drop constraint swing_analysis_processing_claim_shape;" ENT1D-GUARD-PRE-1
run_case "G2 guard: proof column missing" "$GUARD" \
  "alter table public.swing_analysis drop constraint swing_analysis_claim_proof_transient; drop trigger swing_analysis_execution_guard on public.swing_analysis; drop function public.ent1d_swing_analysis_execution_guard(); alter table public.swing_analysis drop column processing_claim_proof;" \
  ENT1D-GUARD-PRE-2
run_case "G3 guard: consuming trigger disabled" "$GUARD" \
  "alter table public.swing_analysis disable trigger swing_analysis_execution_guard;" ENT1D-GUARD-PRE-2
run_case "G3b guard: the guard body is not the consuming version (re-run after enforcement)" "$GUARD" \
  "create or replace function public.ent1d_swing_analysis_execution_guard() returns trigger language plpgsql security invoker set search_path = '' as \$f\$
-- ENT1D-EXECUTION-GUARD-MODE: enforce
begin new.processing_claim_proof := null; return new; end \$f\$;" ENT1D-GUARD-PRE-2
run_case "G4 guard: result privileges (20261026120100) not applied" "$GUARD" \
  "grant select (metrics) on public.swing_analysis to authenticated;" ENT1D-GUARD-PRE-3
run_case "G5 guard: positive control" "$GUARD" "" SUCCESS

# ── 20261027120100 swing video source guard ───────────────────────────────────
run_case "V0 video guard: expected columns missing" "$VIDEO" \
  "alter table public.swing_videos rename column video_url to video_url_renamed;" ENT1D-VIDEO-PRE-1
run_case "V1 video guard: RLS disabled on swing_videos" "$VIDEO" \
  "alter table public.swing_videos disable row level security;" ENT1D-VIDEO-PRE-2
run_case "V2 video guard: already exists" "$VIDEO" \
  "create function public.ent1d_swing_videos_source_guard() returns trigger language plpgsql as \$f\$ begin return new; end \$f\$;" \
  ENT1D-VIDEO-PRE-3
run_case "V3 video guard: positive control" "$VIDEO" "" SUCCESS

echo "GUARD_PREFLIGHT_RESULT=$([ $FAIL -eq 0 ] && echo PASS || echo FAIL)"
exit $FAIL
