-- SwingProAI — Schema v4: granular biomechanical telemetry on swing_analysis
-- Run in: Supabase Dashboard > SQL Editor > New query > Run
--
-- Safe + additive: every statement is idempotent (IF NOT EXISTS / guarded),
-- so re-running is a no-op and existing rows are untouched. No data is dropped.

-- ─────────────────────────────────────────────
-- 1. Structured telemetry arrays + deep prose
-- ─────────────────────────────────────────────
alter table public.swing_analysis
  -- What the golfer is doing WRONG: joint-specific faults with severity + drills.
  -- Shape: [{ checkpoint, joint_coordinate, fault_description, severity,
  --           corrective_drill_title }]
  add column if not exists mechanical_deficiencies jsonb not null default '[]'::jsonb,

  -- What the golfer is doing RIGHT: reinforce good habits.
  -- Shape: [{ checkpoint, positive_movement, mechanical_benefit }]
  add column if not exists swing_highlights jsonb not null default '[]'::jsonb,

  -- Un-truncated, deep prose analysis (HTML) for the detail page.
  add column if not exists detailed_summary_html text;

-- ─────────────────────────────────────────────
-- 2. Integrity guards (defensive — JSONB arrays only)
--    Wrapped in DO blocks so re-running never errors on an existing constraint.
-- ─────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'swing_analysis_mechanical_deficiencies_is_array'
  ) then
    alter table public.swing_analysis
      add constraint swing_analysis_mechanical_deficiencies_is_array
      check (jsonb_typeof(mechanical_deficiencies) = 'array');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'swing_analysis_swing_highlights_is_array'
  ) then
    alter table public.swing_analysis
      add constraint swing_analysis_swing_highlights_is_array
      check (jsonb_typeof(swing_highlights) = 'array');
  end if;
end $$;

-- ─────────────────────────────────────────────
-- 3. Backfill safety — ensure no NULLs slipped in on pre-existing rows
--    (defaults cover new rows; this covers any row written before the default).
-- ─────────────────────────────────────────────
update public.swing_analysis
  set mechanical_deficiencies = '[]'::jsonb
  where mechanical_deficiencies is null;

update public.swing_analysis
  set swing_highlights = '[]'::jsonb
  where swing_highlights is null;

-- ─────────────────────────────────────────────
-- 4. Indexes for querying into the arrays (e.g. "swings with major faults")
-- ─────────────────────────────────────────────
create index if not exists idx_swing_analysis_deficiencies
  on public.swing_analysis using gin (mechanical_deficiencies);

create index if not exists idx_swing_analysis_highlights
  on public.swing_analysis using gin (swing_highlights);

-- ─────────────────────────────────────────────
-- 5. Documentation
-- ─────────────────────────────────────────────
comment on column public.swing_analysis.mechanical_deficiencies is
  'JSONB array of joint-specific faults: {checkpoint, joint_coordinate, fault_description, severity(minor|major), corrective_drill_title}';
comment on column public.swing_analysis.swing_highlights is
  'JSONB array of positive movements: {checkpoint, positive_movement, mechanical_benefit}';
comment on column public.swing_analysis.detailed_summary_html is
  'Un-truncated deep biomechanical prose analysis, stored as sanitized HTML';
