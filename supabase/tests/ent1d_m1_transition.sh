#!/usr/bin/env bash
# ============================================================================
# ENT-1D — M1 against representative pre-existing rows (DISPOSABLE LOCAL ONLY)
# ============================================================================
#
# Usage: ent1d_m1_transition.sh <db-container> <expected-project-label> <stack-workdir> <m1.sql> <m2.sql> <phase>
#   phase seed    — the stack holds every migration BEFORE M1. Seeds
#                   representative rows as the old application left them and
#                   starts one old-application request (claimed, not finished).
#   phase m1      — copies M1 into the stack's migrations and applies it with
#                   the real CLI runner, then checks the backfill and that
#                   completed results are byte-for-byte unchanged.
#   phase window  — M1 applied, old application still running: replays the
#                   PREVIOUS route's actual write shapes (HEAD 168bd88
#                   app/api/analyze-swing/route.ts: claim, putting processing,
#                   completion, failure) and checks the CHECK constraint
#                   accepts every one of them.
#   phase m2      — applies M2 with the real CLI runner (deployment order is
#                   M1, new app, M2; this local test does not prove the order).
#
# The old application's statements are written here as SQL equivalents of its
# supabase-js calls (quoted next to each one). The NEW application's handling
# of the resulting rows is then exercised with the real module in
# app-integration/ent1d-m1-transition.integration.test.ts.

set -u
DB="$1"; LABEL="$2"; WORKDIR="$3"; M1="$4"; M2="$5"; PHASE="$6"
label=$(docker inspect --format '{{index .Config.Labels "com.supabase.cli.project"}}' "$DB" 2>/dev/null)
if [ "$label" != "$LABEL" ]; then echo "TARGET_MISMATCH: $DB is '$label', expected '$LABEL'"; exit 2; fi
q() { docker exec -i "$DB" psql -U postgres -X -At -v ON_ERROR_STOP=1 -f -; }
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS | $1 | $2"; else echo "FAIL | $1 | got '$2' expected '$3'"; FAIL=1; fi; }

U=0a000000-0000-4000-8000-0000000000f1
r() { printf '0b000000-0000-4000-8000-%012d' "$1"; }
SCORE='{"basis":"qualitative_classification_index","coverage":{"percent":100,"scorable_sections":6,"total_sections":6},"score":80,"score_version":1,"source_classification_version":1}'
PAYLOAD_MD5="select md5(coalesce(status,'')||coalesce(score::text,'')||coalesce(feedback,'')||coalesce(metrics::text,'')||coalesce(swing_highlights::text,'')||coalesce(mechanical_deficiencies::text,'')||coalesce(putting_analysis::text,'')||coalesce(putting_score::text,'')||coalesce(equipment_snapshot::text,'')||coalesce(analysis_family,'')) from public.swing_analysis where id ="
LEASE="select coalesce(processing_claim_id::text,'-')||'|'||(processing_started_at is not null)||'|'||(processing_heartbeat_at is not null)||'|'||(provider_dispatched_at is not null) from public.swing_analysis where id ="

case "$PHASE" in
seed)
  has=$(echo "select count(*) from pg_attribute where attrelid='public.swing_analysis'::regclass and attname='processing_claim_id' and not attisdropped;" | q)
  check "stack is pre-M1 (no lease columns)" "$has" "0"
  q > /dev/null <<SQL || { echo "SEED_FAILED"; exit 2; }
insert into auth.users (id, email) values ('$U', 'ent1d-transition@example.test');
insert into public.user_equipment (id, user_id, club_type, custom_club, custom_brand, custom_model) values
  ('0c000000-0000-4000-8000-0000000000f1', '$U', 'Driver', true, 'Synthetic', 'D1'),
  ('0c000000-0000-4000-8000-0000000000f2', '$U', 'Putter', true, 'Synthetic', 'P1');
insert into public.swing_videos (id, user_id, status, storage_path, video_url)
  select ('0b000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$U', 'uploaded', '$U/' || n || '.mp4', '' from generate_series(1, 9) n;
insert into public.swing_analysis (id, swing_video_id, user_id, club_id)
  select ('0b000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ('0b000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '$U',
         case when n in (5, 6, 7) then '0c000000-0000-4000-8000-0000000000f2'::uuid
              when n = 9 then null  -- legacy row: no club, so the trigger derives analysis_family null
              else '0c000000-0000-4000-8000-0000000000f1'::uuid end
    from generate_series(1, 9) n;
set role service_role;
-- T1 pending full swing; T2 failed full swing; T3 completed full swing with payload;
-- T4 processing full swing (legacy, no claim metadata); T5 completed historical putt
-- with envelope and score; T6 processing putt (legacy); T7 pending putt;
-- T8 pending full swing (an old request will claim it before M1); T9 legacy full
-- swing with analysis_family null.
update public.swing_analysis set status = 'failed' where id = '$(r 2)';
update public.swing_analysis set status = 'complete', score = 71, feedback = 'historical summary',
  metrics = '{"drills":[{"name":"Historical drill"}],"fault_tags":["early_extension"]}',
  swing_highlights = '[{"checkpoint":"impact","positive_movement":"Quiet head"}]',
  mechanical_deficiencies = '[{"checkpoint":"impact","fault_description":"Early extension"}]' where id = '$(r 3)';
update public.swing_analysis set status = 'processing' where id in ('$(r 4)', '$(r 6)');
update public.swing_analysis set status = 'complete', putting_analysis = '{"schema_version":1,"summary":"historical putt"}',
  putting_score = '$SCORE' where id = '$(r 5)';
SQL
  fam9=$(echo "select coalesce(analysis_family,'NULL') from public.swing_analysis where id='$(r 9)';" | q)
  check "T9 legacy row has analysis_family null" "$fam9" "NULL"
  # Old application (HEAD route.ts:898-905), request A claims T8 and is still running:
  #   .update({ status: "processing" }).eq("id").eq("user_id").or(FULL_SWING_FAMILY_FILTER).in("status", ["pending","failed"])
  n=$(echo "set role service_role; with u as (update public.swing_analysis set status='processing' where id='$(r 8)' and user_id='$U' and (analysis_family is null or analysis_family='full_swing') and status in ('pending','failed') returning 1) select count(*) from u;" | q | tail -1)
  check "old-app claim before M1 (T8, in flight across the migration)" "$n" "1"
  echo "T3_MD5=$(echo "$PAYLOAD_MD5 '$(r 3)';" | q)"
  echo "T5_MD5=$(echo "$PAYLOAD_MD5 '$(r 5)';" | q)"
  ;;

m1)
  T3_BEFORE="$7"; T5_BEFORE="$8"
  cp "$M1" "$WORKDIR/supabase/migrations/"
  out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); code=$?
  echo "$out" | grep -E "Applying migration|ERROR|ENT1D" | sed 's/^/  /'
  check "M1 applied by the CLI runner" "$code" "0"
  check "T3 completed full-swing payload unchanged" "$(echo "$PAYLOAD_MD5 '$(r 3)';" | q)" "$T3_BEFORE"
  check "T5 completed putting payload (envelope + score) unchanged" "$(echo "$PAYLOAD_MD5 '$(r 5)';" | q)" "$T5_BEFORE"
  for i in 1 2 3 5 7 9; do check "T$i non-processing row has no lease" "$(echo "$LEASE '$(r $i)';" | q | cut -d'|' -f2-)" "false|false|false"; done
  for i in 4 6 8; do check "T$i processing row backfilled as dispatched (stalled after the lease)" "$(echo "$LEASE '$(r $i)';" | q | cut -d'|' -f2-)" "true|true|true"; done
  ;;

window)
  sr() { echo "set role service_role; $1" | q | tail -1; }
  # Old app, full-swing claim (HEAD route.ts:898-905) on T1: leaves processing with no lease.
  check "window: old-app full-swing claim T1 accepted by the CHECK" \
    "$(sr "with u as (update public.swing_analysis set status='processing' where id='$(r 1)' and user_id='$U' and (analysis_family is null or analysis_family='full_swing') and status in ('pending','failed') returning 1) select count(*) from u;")" "1"
  # Old app, putting processing write (HEAD route.ts:562-566): .update({status:"processing"}).eq("id").eq("user_id") — no status filter.
  check "window: old-app putting processing write T7 accepted" \
    "$(sr "with u as (update public.swing_analysis set status='processing' where id='$(r 7)' and user_id='$U' returning 1) select count(*) from u;")" "1"
  # Old app, claim then definite failure on T2 (HEAD route.ts:508-513): .update({status:"failed"}).eq("id").eq("status","processing").eq("user_id")
  sr "update public.swing_analysis set status='processing' where id='$(r 2)' and user_id='$U' and (analysis_family is null or analysis_family='full_swing') and status in ('pending','failed');" > /dev/null
  check "window: old-app failure write T2" \
    "$(sr "with u as (update public.swing_analysis set status='failed' where id='$(r 2)' and status='processing' and user_id='$U' returning 1) select count(*) from u;")" "1"
  # Old request A (claimed T8 before M1) finishes after M1 (HEAD route.ts:1222-1227): .update(payload).eq("id").eq("user_id").eq("status","processing")
  check "window: old in-flight request completes T8 across M1" \
    "$(sr "with u as (update public.swing_analysis set status='complete', score=73, feedback='old app result', metrics='{\"drills\":[]}' where id='$(r 8)' and user_id='$U' and status='processing' returning 1) select count(*) from u;")" "1"
  # The old app's failure write cannot overwrite that completion.
  check "window: old-app failure write cannot fail a completed row" \
    "$(sr "with u as (update public.swing_analysis set status='failed' where id='$(r 8)' and status='processing' and user_id='$U' returning 1) select count(*) from u;")" "0"
  # Old-app writes never set a partial lease: the CHECK refuses one outright.
  out=$(echo "set role service_role; update public.swing_analysis set processing_claim_id = gen_random_uuid() where id='$(r 3)';" | q 2>&1); code=$?
  check "window: a partial lease is refused by the claim-shape CHECK" "$([ $code -ne 0 ] && echo "$out" | grep -q swing_analysis_processing_claim_shape && echo refused || echo accepted)" "refused"
  echo "WINDOW_STATE:"; echo "select right(id::text,2)||' '||status||' '||coalesce(analysis_family,'NULL')||' lease='||(processing_claim_id is not null)||' dispatched='||(provider_dispatched_at is not null) from public.swing_analysis where user_id='$U' order by id;" | q | sed 's/^/  /'
  ;;

m2)
  cp "$M2" "$WORKDIR/supabase/migrations/"
  out=$(env -u DATABASE_URL supabase migration up --local --workdir "$WORKDIR" 2>&1); code=$?
  echo "$out" | grep -E "Applying migration|ERROR|ENT1D" | sed 's/^/  /'
  check "M2 applied by the CLI runner after the window" "$code" "0"
  ;;
esac

echo "M1_TRANSITION_${PHASE}_RESULT=$([ $FAIL -eq 0 ] && echo PASS || echo FAIL)"
exit $FAIL
