#!/usr/bin/env bash
# ============================================================================
# ENT-1D — real multi-session concurrency harness (DISPOSABLE LOCAL STACK ONLY)
# ============================================================================
#
# Runs INSIDE the run's own database container (piped to `bash -s`). Each case
# opens two independent psql connections (S1, S2) as service_role — the role
# the application's server writer uses — plus a monitor connection. The
# interleaving is decided by OBSERVED lock waits (pg_stat_activity /
# pg_blocking_pids), polled with a bound, never by timing alone.
#
# Statements are the SQL form of lib/analysis-execution-claim.ts and the
# route's completion/failure writes:
#   PostgREST .or("analysis_family.is.null,analysis_family.eq.full_swing")
#     -> (analysis_family is null or analysis_family = 'full_swing')
#   .eq / .in / .is(null) / .lt -> = / in / is null / <
# Timestamps the application takes from its clock are now() here; the
# takeover cutoff is now() - 900 s (ANALYSIS_LEASE_SECONDS).

set -u
# Target check: the caller passes this container's id; refuse anywhere else.
if [ -z "${ENT1D_EXPECTED_HOST:-}" ] || [ "$(hostname)" != "$ENT1D_EXPECTED_HOST" ]; then
  echo "TARGET_MISMATCH: host $(hostname), expected ${ENT1D_EXPECTED_HOST:-unset}"; exit 2
fi
W=$(mktemp -d /tmp/ent1d-race.XXXXXX)
FAIL=0
U='0a000000-0000-4000-8000-0000000000e1'
PSQL="psql -U postgres -X -At -v ON_ERROR_STOP=0"

cleanup() {
  exec 3>&- 4>&- 2>/dev/null
  $PSQL -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name like 'ent1d_race_%'" >/dev/null 2>&1
  $PSQL -f - >/dev/null 2>&1 <<'SQL'
delete from public.swing_analysis where user_id = '0a000000-0000-4000-8000-0000000000e1';
delete from public.swing_videos where user_id = '0a000000-0000-4000-8000-0000000000e1';
delete from public.user_equipment where user_id = '0a000000-0000-4000-8000-0000000000e1';
delete from auth.users where id = '0a000000-0000-4000-8000-0000000000e1';
SQL
  rm -rf "$W"
}
trap cleanup EXIT

# ── Fixtures: one synthetic golfer, a custom driver and putter, one video per row.
$PSQL -v ON_ERROR_STOP=1 -f - > "$W/fixture.out" 2>&1 <<SQL || { echo "FIXTURE_FAILED"; cat "$W/fixture.out"; exit 2; }
insert into auth.users (id, email) values ('$U', 'ent1d-race@example.test');
insert into public.user_equipment (id, user_id, club_type, custom_club, custom_brand, custom_model)
values ('0c000000-0000-4000-8000-0000000000d1', '$U', 'Driver', true, 'Synthetic', 'D1'),
       ('0c000000-0000-4000-8000-0000000000d2', '$U', 'Putter', true, 'Synthetic', 'P1');
SQL

row_id() { printf '0b000000-0000-4000-8000-%012d' "$1"; }

# new_row <n> <family full_swing|putting> <status> <claim|null> <heartbeat-age-seconds|null> <dispatched true|false>
new_row() {
  local id; id=$(row_id "$1")
  local club='0c000000-0000-4000-8000-0000000000d1'; [ "$2" = putting ] && club='0c000000-0000-4000-8000-0000000000d2'
  local lease="processing_claim_id = null, processing_started_at = null, processing_heartbeat_at = null, provider_dispatched_at = null"
  if [ "$4" != null ]; then
    lease="processing_claim_id = '$4', processing_started_at = now() - interval '$5 seconds',
           processing_heartbeat_at = now() - interval '$5 seconds',
           provider_dispatched_at = $([ "$6" = true ] && echo "now() - interval '$5 seconds'" || echo null)"
  fi
  $PSQL -v ON_ERROR_STOP=1 -f - > "$W/row.out" 2>&1 <<SQL || { echo "ROW_FAILED"; return 1; }
insert into public.swing_videos (id, user_id, status, storage_path, video_url) values ('$id', '$U', 'uploaded', '$U/$1.mp4', '$U/$1.mp4');
insert into public.swing_analysis (id, swing_video_id, user_id, club_id) values ('$id', '$id', '$U', '$club');
-- Fixture state, set as an operator (the execution guard's explicit override,
-- bound to this transaction).
begin;
select pg_catalog.set_config('swingproai.execution_guard', 'operator_override:' || pg_catalog.txid_current(), true);
update public.swing_analysis set status = '$3', $lease where id = '$id';
commit;
SQL
  echo "$id"
}

fam() { [ "$1" = putting ] && echo "analysis_family = 'putting'" || echo "(analysis_family is null or analysis_family = 'full_swing')"; }
SCORE='{"basis":"qualitative_classification_index","coverage":{"percent":100,"scorable_sections":6,"total_sections":6},"score":80,"score_version":1,"source_classification_version":1}'

# The application's statements, each reporting its affected-row count.
CLAIM_FRESH()  { echo "with u as (update public.swing_analysis set status='processing', processing_claim_id='$3', processing_started_at=now(), processing_heartbeat_at=now(), provider_dispatched_at=null where id='$1' and user_id='$U' and $(fam "$2") and status in ('pending','failed') returning 1) select 'ROWS=' || count(*) from u;"; }
TAKEOVER()     { echo "with u as (update public.swing_analysis set status='processing', processing_claim_id='$3', processing_started_at=now(), processing_heartbeat_at=now(), provider_dispatched_at=null where id='$1' and user_id='$U' and $(fam "$2") and status='processing' and provider_dispatched_at is null and processing_heartbeat_at < now() - interval '900 seconds' returning 1) select 'ROWS=' || count(*) from u;"; }
DISPATCH()     { echo "with u as (update public.swing_analysis set provider_dispatched_at=now(), processing_heartbeat_at=now(), processing_claim_proof='$2' where id='$1' and user_id='$U' and status='processing' and processing_claim_id='$2' and provider_dispatched_at is null returning 1) select 'ROWS=' || count(*) from u;"; }
HEARTBEAT()    { echo "with u as (update public.swing_analysis set processing_heartbeat_at=now(), processing_claim_proof='$2' where id='$1' and user_id='$U' and status='processing' and processing_claim_id='$2' returning 1) select 'ROWS=' || count(*) from u;"; }
# releaseAnalysisClaimAsFailed is RELEASE_UNDISPATCHED, then (if that moved
# nothing) RELEASE: the dispatched branch, which keeps the lease.
RELEASE()      { echo "with u as (update public.swing_analysis set status='failed', processing_claim_proof='$2' where id='$1' and user_id='$U' and status='processing' and processing_claim_id='$2' and provider_dispatched_at is not null returning 1) select 'ROWS=' || count(*) from u;"; }
# releaseUndispatchedClaimAsFailed (R1): status and the whole lease in one UPDATE.
RELEASE_UNDISPATCHED() { echo "with u as (update public.swing_analysis set status='failed', processing_claim_id=null, processing_started_at=null, processing_heartbeat_at=null, provider_dispatched_at=null, processing_claim_proof='$2' where id='$1' and user_id='$U' and status='processing' and processing_claim_id='$2' and provider_dispatched_at is null returning 1) select 'ROWS=' || count(*) from u;"; }
# The previous application's writes (HEAD 168bd88 route.ts): status-only
# full-swing claim (:898-905); putting processing (:562-566) and failure
# (:540-545), which filter on neither status nor claim.
LEGACY_PUTT_PROCESSING() { echo "with u as (update public.swing_analysis set status='processing' where id='$1' and user_id='$U' returning 1) select 'ROWS=' || count(*) from u;"; }
LEGACY_PUTT_FAIL() { echo "with u as (update public.swing_analysis set status='failed' where id='$1' and user_id='$U' returning 1) select 'ROWS=' || count(*) from u;"; }
OLD_CLAIM()    { echo "with u as (update public.swing_analysis set status='processing' where id='$1' and user_id='$U' and $(fam "$2") and status in ('pending','failed') returning 1) select 'ROWS=' || count(*) from u;"; }
OUTCOME_UNKNOWN() { echo "with u as (update public.swing_analysis set processing_heartbeat_at='1970-01-01T00:00:00.000Z', processing_claim_proof='$2' where id='$1' and user_id='$U' and status='processing' and processing_claim_id='$2' returning 1) select 'ROWS=' || count(*) from u;"; }
COMPLETE_FULL() { echo "with u as (update public.swing_analysis set status='complete', score=72, feedback='summary', metrics='{}'::jsonb, processing_claim_proof='$2' where id='$1' and user_id='$U' and status='processing' and processing_claim_id='$2' returning 1) select 'ROWS=' || count(*) from u;"; }
COMPLETE_PUTT() { echo "with u as (update public.swing_analysis set status='complete', putting_analysis='{}'::jsonb, putting_score='$SCORE'::jsonb, processing_claim_proof='$2' where id='$1' and user_id='$U' and analysis_family='putting' and status='processing' and processing_claim_id='$2' and putting_score is null returning 1) select 'ROWS=' || count(*) from u;"; }

open_sessions() {
  rm -f "$W/S1.in" "$W/S2.in" "$W/S1.out" "$W/S2.out"
  mkfifo "$W/S1.in" "$W/S2.in"
  PGAPPNAME=ent1d_race_S1 $PSQL < "$W/S1.in" > "$W/S1.out" 2>&1 &
  PGAPPNAME=ent1d_race_S2 $PSQL < "$W/S2.in" > "$W/S2.out" 2>&1 &
  exec 3>"$W/S1.in" 4>"$W/S2.in"
  echo "set role service_role; begin;" >&3
  echo "set role service_role; begin;" >&4
}
close_sessions() { echo "commit;" >&4; echo '\q' >&3; echo '\q' >&4; exec 3>&- 4>&-; wait 2>/dev/null; }

# wait_for <file> <marker>: bounded wait for a line to appear
wait_for() { local i; for i in $(seq 1 200); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.05; done; return 1; }
s() { echo "$2" >&"$1"; echo "\\echo MARK:$3" >&"$1"; }

# wait_blocked: S2 observed waiting on a lock held by S1
wait_blocked() {
  local i r
  for i in $(seq 1 200); do
    r=$($PSQL -c "select coalesce(string_agg(b.application_name, ','), '') from pg_stat_activity w cross join lateral unnest(pg_blocking_pids(w.pid)) as bp join pg_stat_activity b on b.pid = bp where w.application_name = 'ent1d_race_S2' and w.wait_event_type = 'Lock'")
    [ "$r" = "ent1d_race_S1" ] && { echo "blocked_by=$r"; return 0; }
    sleep 0.05
  done
  echo "blocked_by=NONE"; return 1
}

rows_after() { awk -v m="MARK:$2" '/^ROWS=/{last=$0} /ERROR: +ENT1D-CLAIM-[0-9]+/{match($0, /ENT1D-CLAIM-[0-9]+/); last="REFUSED:" substr($0, RSTART, RLENGTH)} $0==m{print last; exit}' "$1"; }
state() { $PSQL -c "select status || '|' || coalesce(processing_claim_id::text,'-') || '|' || (provider_dispatched_at is not null) || '|' || coalesce(score::text, '-') || '|' || (putting_score is not null) from public.swing_analysis where id = '$1'"; }

report() { # name s1rows s2rows blocked final expect_s1 expect_s2 expect_final
  local v=PASS
  [ "$2" = "$6" ] || v=FAIL; [ "$3" = "$7" ] || v=FAIL; [ "$4" = "blocked_by=ent1d_race_S1" ] || v=FAIL
  case "$5" in $8) ;; *) v=FAIL ;; esac
  [ "$v" = PASS ] || FAIL=1
  echo "CASE $1 | S1 $2 | S2 $3 | $4 | final=$5 | $v"
}

# race <name> <rowid> <S1 statement> <S2 statement> <expect S1> <expect S2> <final glob>
race() {
  open_sessions
  s 3 "$3" a; wait_for "$W/S1.out" "MARK:a" || echo "S1_TIMEOUT"
  s 4 "$4" b
  local blocked; blocked=$(wait_blocked)
  echo "commit;" >&3
  wait_for "$W/S2.out" "MARK:b" || echo "S2_TIMEOUT"
  local r1 r2; r1=$(rows_after "$W/S1.out" a); r2=$(rows_after "$W/S2.out" b)
  close_sessions
  report "$1" "$r1" "$r2" "$blocked" "$(state "$2")" "$5" "$6" "$7"
}

# seq_case <name> <rowid> <stmt1> <expect1> <stmt2> <expect2> <final>: two
# statements one after the other (no lock interaction is claimed). A guard
# refusal raised in a BEFORE trigger takes no row lock, so it cannot be raced.
seq_case() {
  local v=PASS out r1 r2
  out=$( { echo "set role service_role;"; $3; } | $PSQL 2>&1 ); r1=$(echo "$out" | grep '^ROWS='); [ -z "$r1" ] && r1="REFUSED:$(echo "$out" | grep -o 'ENT1D-CLAIM-[0-9]*' | head -1)"
  out=$( { echo "set role service_role;"; $5; } | $PSQL 2>&1 ); r2=$(echo "$out" | grep '^ROWS='); [ -z "$r2" ] && r2="REFUSED:$(echo "$out" | grep -o 'ENT1D-CLAIM-[0-9]*' | head -1)"
  local f; f=$(state "$2")
  [ "$r1" = "$4" ] || v=FAIL; [ "$r2" = "$6" ] || v=FAIL; [ "$f" = "$7" ] || v=FAIL
  [ "$v" = PASS ] || FAIL=1
  echo "CASE $1 | first $r1 | second $r2 | final=$f | $v"
}

C0='0d000000-0000-4000-8000-0000000000c0'
C1='0d000000-0000-4000-8000-0000000000c1'
C2='0d000000-0000-4000-8000-0000000000c2'

# mk <n> ...: create a fixture row in the main shell; any failure aborts the run.
mk() { R=$(new_row "$@"); if ! [[ "$R" =~ ^0b000000-0000-4000-8000-[0-9]{12}$ ]]; then echo "FIXTURE_FAILED row $1: $R"; cat "$W/row.out" 2>/dev/null; exit 2; fi; }

mk 1 full_swing pending null null false
race "K1 fresh-claim race (full swing)" "$R" "$(CLAIM_FRESH "$R" full_swing $C1)" "$(CLAIM_FRESH "$R" full_swing $C2)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 2 putting pending null null false
race "K1P fresh-claim race (putting)" "$R" "$(CLAIM_FRESH "$R" putting $C1)" "$(CLAIM_FRESH "$R" putting $C2)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 3 full_swing processing $C0 1200 false
race "K2 expired undispatched takeover race" "$R" "$(TAKEOVER "$R" full_swing $C1)" "$(TAKEOVER "$R" full_swing $C2)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 4 full_swing processing $C0 1200 false
race "K3 dispatch first, takeover second" "$R" "$(DISPATCH "$R" $C0)" "$(TAKEOVER "$R" full_swing $C2)" ROWS=1 ROWS=0 "processing|$C0|true|-|false"

mk 5 full_swing processing $C0 1200 false
race "K4 takeover first, stale dispatch second" "$R" "$(TAKEOVER "$R" full_swing $C1)" "$(DISPATCH "$R" $C0)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

# K5: after K4's takeover, every stale-holder write by C0 affects nothing.
K5=PASS
for stmt in HEARTBEAT RELEASE RELEASE_UNDISPATCHED OUTCOME_UNKNOWN COMPLETE_FULL; do
  r=$( { echo "set role service_role;"; $stmt "$R" $C0; } | $PSQL | grep '^ROWS=' )
  echo "  K5 stale $stmt by C0 -> $r"
  [ "$r" = ROWS=0 ] || K5=FAIL
done
f=$(state "$R"); case "$f" in "processing|$C1|false|-|false") ;; *) K5=FAIL ;; esac
[ "$K5" = PASS ] || FAIL=1
echo "CASE K5 stale heartbeat/release/failure/outcome-unknown/completion after takeover | final=$f | $K5"

mk 6 full_swing processing $C0 1200 false
race "K6 takeover vs stale completion" "$R" "$(TAKEOVER "$R" full_swing $C1)" "$(COMPLETE_FULL "$R" $C0)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 7 full_swing processing $C1 1200 false
if [ "${ENT1D_GUARD:-off}" = on ]; then
  seq_case "K7 guard (sequential): undispatched completion refused, then the takeover proceeds" "$R" "COMPLETE_FULL $R $C1" REFUSED:ENT1D-CLAIM-14 "TAKEOVER $R full_swing $C2" ROWS=1 "processing|$C2|false|-|false"
else
  race "K7 completion first, takeover second" "$R" "$(COMPLETE_FULL "$R" $C1)" "$(TAKEOVER "$R" full_swing $C2)" ROWS=1 ROWS=0 "complete|$C1|false|72|false"
fi

mk 8 full_swing processing $C1 10 true
race "K8 completion first, same-claim failure second" "$R" "$(COMPLETE_FULL "$R" $C1)" "$(RELEASE "$R" $C1)" ROWS=1 ROWS=0 "complete|$C1|true|72|false"

mk 9 putting processing $C1 10 true
race "K9 putting completion vs duplicate completion" "$R" "$(COMPLETE_PUTT "$R" $C1)" "$(COMPLETE_PUTT "$R" $C1)" ROWS=1 ROWS=0 "complete|$C1|true|-|true"

mk 10 putting processing $C1 10 true
race "K10 putting completion first, same-claim failure second" "$R" "$(COMPLETE_PUTT "$R" $C1)" "$(RELEASE "$R" $C1)" ROWS=1 ROWS=0 "complete|$C1|true|-|true"

mk 11 putting processing $C0 1200 false
race "K11 putting: dispatch first, takeover second" "$R" "$(DISPATCH "$R" $C0)" "$(TAKEOVER "$R" putting $C2)" ROWS=1 ROWS=0 "processing|$C0|true|-|false"

# K12: an expired claim that reached the provider (a dispatched putt, then
# marked outcome-unknown) is never claimable again, by either claim path.
mk 12 putting processing $C0 1200 true
K12=PASS
for stmt in "OUTCOME_UNKNOWN $R $C0" "TAKEOVER $R putting $C2" "CLAIM_FRESH $R putting $C2"; do
  r=$( { echo "set role service_role;"; $stmt; } | $PSQL | grep '^ROWS=' )
  echo "  K12 $(echo "$stmt" | cut -d' ' -f1) -> $r"
  case "$stmt" in OUTCOME_UNKNOWN*) [ "$r" = ROWS=1 ] || K12=FAIL ;; *) [ "$r" = ROWS=0 ] || K12=FAIL ;; esac
done
f=$(state "$R"); case "$f" in "processing|$C0|true|-|false") ;; *) K12=FAIL ;; esac
[ "$K12" = PASS ] || FAIL=1
echo "CASE K12 stalled (dispatched, outcome unknown) putt is never re-claimable | final=$f | $K12"

# ── Additional races (review follow-ups) ───────────────────────────────────

mk 13 full_swing processing $C0 1200 false
race "K13 holder heartbeat first, takeover second" "$R" "$(HEARTBEAT "$R" $C0)" "$(TAKEOVER "$R" full_swing $C2)" ROWS=1 ROWS=0 "processing|$C0|false|-|false"

mk 14 full_swing processing $C0 1200 false
race "K14 takeover first, stale heartbeat second" "$R" "$(TAKEOVER "$R" full_swing $C1)" "$(HEARTBEAT "$R" $C0)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 15 full_swing processing $C0 1200 false
race "K15 undispatched release first, takeover second" "$R" "$(RELEASE_UNDISPATCHED "$R" $C0)" "$(TAKEOVER "$R" full_swing $C2)" ROWS=1 ROWS=0 "failed|-|false|-|false"

mk 16 full_swing processing $C1 10 true
race "K16 failure first, same-claim completion second" "$R" "$(RELEASE "$R" $C1)" "$(COMPLETE_FULL "$R" $C1)" ROWS=1 ROWS=0 "failed|$C1|true|-|false"

mk 17 full_swing failed $C0 10 true
race "K17 fresh-claim race from failed" "$R" "$(CLAIM_FRESH "$R" full_swing $C1)" "$(CLAIM_FRESH "$R" full_swing $C2)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 18 putting processing $C0 1200 false
race "K18 putting: expired undispatched takeover race" "$R" "$(TAKEOVER "$R" putting $C1)" "$(TAKEOVER "$R" putting $C2)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 19 putting processing $C0 1200 false
race "K19 putting: takeover first, stale dispatch second" "$R" "$(TAKEOVER "$R" putting $C1)" "$(DISPATCH "$R" $C0)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 20 putting processing $C0 1200 false
race "K20 putting: takeover vs stale putting completion" "$R" "$(TAKEOVER "$R" putting $C1)" "$(COMPLETE_PUTT "$R" $C0)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 21 putting processing $C1 1200 false
if [ "${ENT1D_GUARD:-off}" = on ]; then
  seq_case "K21 guard (sequential): undispatched putting completion refused, then the takeover proceeds" "$R" "COMPLETE_PUTT $R $C1" REFUSED:ENT1D-CLAIM-14 "TAKEOVER $R putting $C2" ROWS=1 "processing|$C2|false|-|false"
else
  race "K21 putting: completion first, takeover second" "$R" "$(COMPLETE_PUTT "$R" $C1)" "$(TAKEOVER "$R" putting $C2)" ROWS=1 ROWS=0 "complete|$C1|false|-|true"
fi

# K22: a claim restates the family; the wrong family affects nothing.
K22=PASS
mk 22 putting pending null null false; RP=$R
mk 23 full_swing pending null null false; RF=$R
for pair in "CLAIM_FRESH $RP full_swing $C1" "CLAIM_FRESH $RF putting $C1"; do
  r=$( { echo "set role service_role;"; $pair; } | $PSQL | grep '^ROWS=' )
  echo "  K22 $pair -> $r"
  [ "$r" = ROWS=0 ] || K22=FAIL
done
[ "$(state "$RP")" = "pending|-|false|-|false" ] || K22=FAIL
[ "$(state "$RF")" = "pending|-|false|-|false" ] || K22=FAIL
[ "$K22" = PASS ] || FAIL=1
echo "CASE K22 cross-family claims affect zero rows | $K22"

# ── Positive controls: after an observed lock wait, S2 DOES take the row when
# S1 rolls back. Shows the harness distinguishes a re-check that fails from a
# waiter that always reports zero rows.
race_rollback() {
  open_sessions
  s 3 "$3" a; wait_for "$W/S1.out" "MARK:a" || echo "S1_TIMEOUT"
  s 4 "$4" b
  local blocked; blocked=$(wait_blocked)
  echo "rollback;" >&3
  wait_for "$W/S2.out" "MARK:b" || echo "S2_TIMEOUT"
  local r1 r2; r1=$(rows_after "$W/S1.out" a); r2=$(rows_after "$W/S2.out" b)
  close_sessions
  report "$1" "$r1" "$r2" "$blocked" "$(state "$2")" "$5" "$6" "$7"
}

mk 24 full_swing pending null null false
race_rollback "K23 positive control: S1 claim rolls back, waiting S2 claims (full swing)" "$R" "$(CLAIM_FRESH "$R" full_swing $C1)" "$(CLAIM_FRESH "$R" full_swing $C2)" ROWS=1 ROWS=1 "processing|$C2|false|-|false"

mk 25 putting processing $C0 1200 false
race_rollback "K24 positive control: S1 takeover rolls back, waiting S2 takes over (putting)" "$R" "$(TAKEOVER "$R" putting $C1)" "$(TAKEOVER "$R" putting $C2)" ROWS=1 ROWS=1 "processing|$C2|false|-|false"

# ── R1 (mixed versions) ─────────────────────────────────────────────────────

mk 26 full_swing processing $C0 1200 false
race "K25 takeover first, stale lease-clearing release second: newer claim kept" "$R" "$(TAKEOVER "$R" full_swing $C1)" "$(RELEASE_UNDISPATCHED "$R" $C0)" ROWS=1 ROWS=0 "processing|$C1|false|-|false"

mk 27 putting processing $C1 1200 false  # expired: the takeover predicate holds on the original row
race "K26 putting: lease-clearing release first, takeover second" "$R" "$(RELEASE_UNDISPATCHED "$R" $C1)" "$(TAKEOVER "$R" putting $C2)" ROWS=1 ROWS=0 "failed|-|false|-|false"

# K27 (sequential; a non-matching UPDATE takes no row lock, so there is no
# wait to observe): a persisted dispatch is never cleared; the dispatched
# release keeps the lease.
K27=PASS
mk 28 full_swing processing $C1 10 true
for stmt in "RELEASE_UNDISPATCHED $R $C1" "RELEASE $R $C1"; do
  r=$( { echo "set role service_role;"; $stmt; } | $PSQL | grep '^ROWS=' )
  echo "  K27 $(echo "$stmt" | cut -d' ' -f1) -> $r"
  case "$stmt" in RELEASE_UNDISPATCHED*) [ "$r" = ROWS=0 ] || K27=FAIL ;; *) [ "$r" = ROWS=1 ] || K27=FAIL ;; esac
done
f=$(state "$R"); case "$f" in "failed|$C1|true|-|false") ;; *) K27=FAIL ;; esac
[ "$K27" = PASS ] || FAIL=1
echo "CASE K27 persisted dispatch: lease-clearing release refused, dispatched release keeps the lease | final=$f | $K27"

# K28: new undispatched release -> old status-only claim -> neither claim path
# of the new app takes the row (the lease is null, so no cutoff can match it).
K28=PASS
GUARD="${ENT1D_GUARD:-off}"
mk 29 full_swing processing $C1 10 false
for stmt in "RELEASE_UNDISPATCHED $R $C1" "OLD_CLAIM $R full_swing" "TAKEOVER $R full_swing $C2" "CLAIM_FRESH $R full_swing $C2"; do
  out=$( { echo "set role service_role;"; $stmt; } | $PSQL 2>&1 )
  r=$(echo "$out" | grep '^ROWS='); [ -z "$r" ] && r="REFUSED:$(echo "$out" | grep -o 'ENT1D-CLAIM-[0-9]*' | head -1)"
  echo "  K28 $(echo "$stmt" | cut -d' ' -f1) -> $r"
  case "$stmt" in
    RELEASE_UNDISPATCHED*) [ "$r" = ROWS=1 ] || K28=FAIL ;;
    OLD_CLAIM*) if [ "$GUARD" = on ]; then [ "$r" = REFUSED:ENT1D-CLAIM-11 ] || K28=FAIL; else [ "$r" = ROWS=1 ] || K28=FAIL; fi ;;
    # With the guard the old claim never landed, no old worker runs, and the
    # row is still 'failed': a new claim from it is the normal retry.
    CLAIM_FRESH*) if [ "$GUARD" = on ]; then [ "$r" = ROWS=1 ] || K28=FAIL; else [ "$r" = ROWS=0 ] || K28=FAIL; fi ;;
    *) [ "$r" = ROWS=0 ] || K28=FAIL ;;
  esac
done
f=$(state "$R")
if [ "$GUARD" = on ]; then case "$f" in "processing|$C2|false|-|false") ;; *) K28=FAIL ;; esac
else case "$f" in "processing|-|false|-|false") ;; *) K28=FAIL ;; esac; fi
[ "$K28" = PASS ] || FAIL=1
echo "CASE K28 R1: undispatched release then old status-only claim is never claimed by the new app | final=$f | $K28"

# ── With the execution guard: an old write waiting on a live holder's lock is
# refused when it re-evaluates against the holder's committed row version.
if [ "${ENT1D_GUARD:-off}" = on ]; then
  mk 30 putting processing $C1 10 true
  race "K29 guard: holder completes putt first, waiting old putting failure is refused" "$R" "$(COMPLETE_PUTT "$R" $C1)" "$(LEGACY_PUTT_FAIL "$R")" ROWS=1 REFUSED:ENT1D-CLAIM-2 "complete|$C1|true|-|true"

  mk 31 putting processing $C0 1200 false
  race "K30 guard: new takeover first, waiting old putting processing write is refused" "$R" "$(TAKEOVER "$R" putting $C1)" "$(LEGACY_PUTT_PROCESSING "$R")" ROWS=1 REFUSED:ENT1D-CLAIM-5 "processing|$C1|false|-|false"
fi

echo "CONCURRENCY_RESULT=$([ $FAIL -eq 0 ] && echo PASS || echo FAIL)"
exit $FAIL
