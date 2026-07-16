/**
 * One-off migration: port flat swings columns into telemetry_data JSONB.
 *
 * Run from swingpro-worker/:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=service_role_key \
 *   node migrate_to_jsonb.js
 *
 * Safe to re-run: rows whose telemetry_data is already populated are skipped.
 */

import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    '[migrate] CRITICAL: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set as environment variables.',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Coerce a DB value to number or null. */
const num = (v) => (v != null && !isNaN(Number(v)) ? Number(v) : null);

/** Coerce a DB value to trimmed string or null. */
const str = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);

/**
 * Build the structured telemetry_data JSONB from a flat swings row.
 * Only keys with non-null values are written — no pollution with explicit nulls.
 */
function buildTelemetry(row) {
  const hardware_metrics = {};
  if (num(row.swing_speed_mph) !== null) hardware_metrics.swing_speed_mph  = num(row.swing_speed_mph);
  if (num(row.ball_speed_mph)  !== null) hardware_metrics.ball_speed_mph   = num(row.ball_speed_mph);
  if (num(row.smash_factor)    !== null) hardware_metrics.smash_factor      = num(row.smash_factor);
  if (str(row.tempo_ratio)     !== null) hardware_metrics.tempo_ratio       = str(row.tempo_ratio);

  const coaching_assessment = {};
  if (num(row.score)                   !== null) coaching_assessment.score                 = num(row.score);
  if (str(row.score_label)             !== null) coaching_assessment.score_label           = str(row.score_label);
  if (str(row.ai_coach_assessment)     !== null) coaching_assessment.ai_coach_assessment   = str(row.ai_coach_assessment);
  if (str(row.pro_cue)                 !== null) coaching_assessment.pro_cue               = str(row.pro_cue);
  if (str(row.weekly_priority_text)    !== null) coaching_assessment.weekly_priority_text  = str(row.weekly_priority_text);

  return { hardware_metrics, coaching_assessment };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function migrate() {
  console.log('[migrate] Fetching all rows from swings table...');

  const { data: rows, error: fetchError } = await supabase
    .from('swings')
    .select(
      'id, telemetry_data, swing_speed_mph, ball_speed_mph, smash_factor, ' +
      'tempo_ratio, score, score_label, ai_coach_assessment, pro_cue, weekly_priority_text',
    );

  if (fetchError) {
    console.error('[migrate] Failed to fetch rows:', fetchError.message);
    process.exit(1);
  }

  console.log(`[migrate] ${rows.length} rows fetched. Starting migration...\n`);

  let skipped = 0;
  let updated = 0;
  let failed  = 0;

  for (const row of rows) {
    // Skip rows already migrated — idempotency guard.
    if (row.telemetry_data && Object.keys(row.telemetry_data).length > 0) {
      console.log(`[migrate] SKIP  ${row.id} — telemetry_data already populated.`);
      skipped++;
      continue;
    }

    const telemetry = buildTelemetry(row);

    const { error: updateError } = await supabase
      .from('swings')
      .update({ telemetry_data: telemetry })
      .eq('id', row.id);

    if (updateError) {
      console.error(`[migrate] ERROR ${row.id} — ${updateError.message}`);
      failed++;
    } else {
      const speed = telemetry.hardware_metrics.swing_speed_mph ?? '—';
      const cue   = telemetry.coaching_assessment.pro_cue       ?? '—';
      console.log(`[migrate] OK    ${row.id} | speed: ${speed} mph | cue: "${cue}"`);
      updated++;
    }
  }

  console.log('\n─────────────────────────────────────');
  console.log(`[migrate] Done.`);
  console.log(`          Updated : ${updated}`);
  console.log(`          Skipped : ${skipped} (already migrated)`);
  console.log(`          Failed  : ${failed}`);
  console.log('─────────────────────────────────────');

  if (failed > 0) process.exit(1);
}

migrate();
