-- ============================================================================
-- SwingProAI — SEC1A-RR1 Production Baseline (Canonical, Source-Only)
-- ============================================================================
--
-- THIS MIGRATION IS SOURCE-ONLY. IT HAS NOT BEEN APPLIED TO ANY PROJECT.
--
-- WHAT THIS IS
-- ------------
-- This is a CANONICAL BASELINE, not a historical reenactment. It recreates
-- the current production application-owned schema of the SwingProAI Supabase
-- project (ref atlmnqispyzhsahahpjy) as of the read-only catalog inspection
-- performed for SEC1A-RR1, from an EMPTY standard Supabase project.
--
-- It exists because the recorded Supabase migration-ledger replay chain is
-- broken and does not reproduce the live schema (see
-- docs/MIGRATION_REPLAY_RECOVERY.md for the full defect list and recovery
-- plan). Known defects include migrations that reference public.drills,
-- public.swings, and public.user_bags before any recorded migration creates
-- them, and the complete absence of public.user_goals and its policies from
-- the recorded chain.
--
-- WHAT THIS IS NOT
-- -----------------
-- - It is NOT a fix applied on top of the existing production schema.
-- - It must NEVER be executed directly against the existing production
--   database — the fail-loud preflight below will abort if any known
--   application-owned relation already exists, but this file is intended
--   only for a genuinely empty replacement migration history (a fresh
--   staging project, or a rebuilt local/CI environment).
-- - It does NOT apply SEC1A. It intentionally reproduces the PRE-SEC1A
--   policy catalog, including the three weak policies SEC1A is designed to
--   remove (see docs/SECURITY_HARDENING_ROLLOUT.md), so that SEC1A's own
--   source-only contract (supabase-security-sec1a.sql) can later be applied
--   and tested against a faithful target. Production itself will only ever
--   be marked as having this baseline "applied" (via a migration-ledger
--   realignment step) under a separate, explicit authorization — this act
--   changes tracking metadata only and must never execute this file's DDL
--   against the already-existing production schema.
--
-- SOURCE OF TRUTH
-- ----------------
-- Every relation, column, type, default, constraint, index, function,
-- trigger, RLS policy, and grant below was read directly from the live
-- PostgreSQL catalogs of project atlmnqispyzhsahahpjy via read-only queries
-- (pg_class, pg_attribute/information_schema.columns, pg_constraint,
-- pg_index, pg_proc, pg_trigger, pg_policies, information_schema role
-- grants, storage.buckets). No column, constraint, policy, or grant in this
-- file was invented or assumed from typical Supabase defaults without
-- catalog evidence. No application row, auth identity, Stripe ID, storage
-- object, credential, or secret is included anywhere in this file.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT — fail loud if the target is not a genuinely empty environment
-- ============================================================================
do $$
declare
  v_existing_count int;
  v_existing_names text;
begin
  select count(*), string_agg(c.relname, ', ' order by c.relname)
    into v_existing_count, v_existing_names
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'm')
      and c.relname in (
        'users','swing_videos','swing_analysis','coach_profiles',
        'coach_golfer_relationships','coach_feedback','lesson_plans',
        'launch_monitor_data','cached_golf_courses','cached_course_holes',
        'swing_analyses','user_equipment','swing_telemetry','user_goals',
        'drill_submissions','range_sessions','drills','user_drills',
        'coach_student_relationships','launch_monitor_sessions',
        'automated_prescriptions','swings','swing_breakdowns',
        'swing_strengths','swing_faults','user_bags','user_clubs','rounds'
      );

  if v_existing_count > 0 then
    raise exception 'RR1-PRE-1: % SwingProAI application-owned relation(s) already exist in public (%). This baseline is only for a genuinely empty environment — it must never run against an environment that already has application schema. Stop.', v_existing_count, v_existing_names;
  end if;

  if EXISTS (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname in ('club_type_enum','telemetry_source_enum')) then
    raise exception 'RR1-PRE-2: one or both application enum types (club_type_enum, telemetry_source_enum) already exist in public. Stop.';
  end if;

  if EXISTS (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('auto_assign_coach_invite_code','generate_coach_invite_code','handle_new_user','handle_updated_at','link_student_to_coach')) then
    raise exception 'RR1-PRE-3: one or more application functions already exist in public. Stop.';
  end if;

  raise notice 'RR1-PRE-OK: environment is clean — proceeding with baseline creation.';
end $$;

-- ============================================================================
-- A. Application enum types
-- ============================================================================

create type public.club_type_enum as enum ('Driver','Wood','Hybrid','Iron','Wedge','Putter');
create type public.telemetry_source_enum as enum ('video_ai','launch_monitor');

-- ============================================================================
-- B. Application-owned relations (dependency-ordered; foreign keys are added
--    separately in section C to keep table creation order simple and safe)
-- ============================================================================

create table public.users (
  id uuid not null,
  email text,
  full_name text,
  handicap_index numeric,
  created_at timestamptz not null default now(),
  stripe_customer_id text,
  subscription_status text not null default 'none'
    constraint users_subscription_status_check
    check (subscription_status = any (array['active','trialing','past_due','canceled','none'])),
  subscription_tier text not null default 'none'
    constraint users_subscription_tier_check
    check (subscription_tier = any (array['par','birdie','eagle','coach_starter','coach_pro','none'])),
  role text not null default 'golfer'
    constraint users_role_check
    check (role = any (array['golfer','coach','admin'])),
  coach_profile_status text,
  display_name text,
  avatar_url text,
  stripe_subscription_id text,
  typical_shot_shape text
    constraint users_typical_shot_shape_check
    check (typical_shot_shape = any (array['draw','fade','straight','hook','slice'])),
  prominent_miss text
    constraint users_prominent_miss_check
    check (prominent_miss = any (array['left','right','thin','fat','top','shank'])),
  average_driver_carry integer,
  coach_invite_code text,
  constraint users_pkey primary key (id),
  constraint users_stripe_customer_id_key unique (stripe_customer_id),
  constraint users_coach_invite_code_key unique (coach_invite_code)
);

create table public.drills (
  id uuid not null default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null,
  target_metric text not null,
  the_why text,
  the_how text,
  the_feel text,
  ai_verification_prompt text not null,
  instructional_video_url text,
  constraint drills_pkey primary key (id)
);

create table public.cached_golf_courses (
  id uuid not null default gen_random_uuid(),
  provider_id text not null,
  provider text not null default 'igolf',
  name text not null,
  city text,
  state text,
  country text default 'US',
  latitude numeric,
  longitude numeric,
  par integer,
  rating numeric,
  slope integer,
  raw_payload jsonb,
  cached_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '30 days'),
  created_at timestamptz default now(),
  constraint cached_golf_courses_pkey primary key (id),
  constraint cached_golf_courses_provider_id_key unique (provider_id)
);

create table public.swing_videos (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  title text,
  video_url text not null,
  storage_path text,
  club text,
  recorded_at timestamptz,
  created_at timestamptz not null default now(),
  status text not null default 'pending'
    constraint swing_videos_status_check
    check (status = any (array['pending','uploaded','processing','complete','failed'])),
  original_filename text,
  file_size bigint,
  mime_type text,
  trim_start numeric default 0,
  trim_end numeric,
  analysis_mode text not null default 'basic'
    constraint swing_videos_analysis_mode_check
    check (analysis_mode = any (array['basic','advanced','ultra'])),
  requested_model text,
  launch_monitor_attached boolean not null default false,
  priority integer not null default 100,
  constraint swing_videos_pkey primary key (id)
);
create index swing_videos_user_id_idx on public.swing_videos using btree (user_id);

create table public.user_equipment (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  club_type public.club_type_enum not null,
  brand text,
  model text,
  shaft_flex text,
  shaft_weight integer,
  loft_deg numeric,
  custom_club boolean not null default false,
  custom_brand text,
  custom_model text,
  custom_notes text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_equipment_pkey primary key (id)
);
create index user_equipment_user_id_idx on public.user_equipment using btree (user_id);
create index user_equipment_club_type_idx on public.user_equipment using btree (user_id, club_type);

create table public.swing_telemetry (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  swing_video_id uuid,
  club_id uuid,
  swing_speed_mph numeric,
  ball_speed_mph numeric,
  smash_factor numeric,
  launch_angle_deg numeric,
  spin_rate_rpm integer,
  carry_yards integer,
  telemetry_source public.telemetry_source_enum not null default 'video_ai',
  fitting_recommendation jsonb,
  fitting_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint swing_telemetry_pkey primary key (id)
);
create index swing_telemetry_user_id_idx on public.swing_telemetry using btree (user_id);
create index swing_telemetry_video_id_idx on public.swing_telemetry using btree (swing_video_id);

create table public.swing_analysis (
  id uuid not null default gen_random_uuid(),
  swing_video_id uuid not null,
  user_id uuid not null,
  status text not null default 'pending',
  tempo_ratio numeric,
  swing_speed_mph numeric,
  score numeric,
  feedback text,
  metrics jsonb,
  created_at timestamptz not null default now(),
  analysis_mode text,
  model_used text,
  launch_monitor_summary jsonb,
  fusion_notes text,
  putt_tempo_ratio numeric,
  face_angle_at_impact_deg numeric,
  path_deviation_mm numeric,
  swing_highlights jsonb default '[]'::jsonb,
  mechanical_deficiencies jsonb default '[]'::jsonb,
  putt_analytics jsonb default '{}'::jsonb,
  ai_equipment_recommendations jsonb default '{}'::jsonb,
  club_id uuid,
  telemetry_id uuid,
  spine_angle numeric,
  hip_rotation numeric,
  shoulder_rotation numeric,
  putting_analysis jsonb,
  constraint swing_analysis_pkey primary key (id)
);
create index swing_analysis_user_id_idx on public.swing_analysis using btree (user_id);
create index swing_analysis_video_id_idx on public.swing_analysis using btree (swing_video_id);

create table public.swing_analyses (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  video_url text,
  swing_category text,
  created_at timestamptz not null default now(),
  analysis_v2 jsonb,
  constraint swing_analyses_pkey primary key (id)
);
create index swing_analyses_user_id_idx on public.swing_analyses using btree (user_id);
create index swing_analyses_created_at_idx on public.swing_analyses using btree (created_at desc);

create table public.swings (
  id uuid not null default gen_random_uuid(),
  user_id text not null,
  video_url text not null,
  club text,
  status text,
  score integer,
  score_label text,
  tempo_ratio numeric,
  ai_coach_assessment text,
  pro_cue text,
  weekly_priority_text text,
  created_at timestamptz default now(),
  swing_speed_mph integer,
  ball_speed_mph integer,
  smash_factor numeric,
  telemetry_data jsonb default '{}'::jsonb,
  constraint swings_pkey primary key (id)
);

create table public.swing_breakdowns (
  id uuid not null default gen_random_uuid(),
  swing_id uuid,
  component text,
  score integer,
  feedback text,
  constraint swing_breakdowns_pkey primary key (id)
);

create table public.swing_strengths (
  id uuid not null default gen_random_uuid(),
  swing_id uuid,
  title text,
  description text,
  constraint swing_strengths_pkey primary key (id)
);

create table public.swing_faults (
  id uuid not null default gen_random_uuid(),
  swing_id uuid,
  title text,
  description text,
  drill text,
  constraint swing_faults_pkey primary key (id)
);

create table public.cached_course_holes (
  id uuid not null default gen_random_uuid(),
  course_provider_id text not null,
  hole_number integer not null
    constraint cached_course_holes_hole_number_check
    check (hole_number >= 1 and hole_number <= 18),
  par integer,
  yards_back integer,
  yards_middle integer,
  yards_front integer,
  handicap_index integer,
  green_center_lat numeric,
  green_center_lng numeric,
  hazards jsonb default '[]'::jsonb,
  undulation_matrix jsonb,
  dogleg_direction text
    constraint cached_course_holes_dogleg_direction_check
    check (dogleg_direction = any (array['left','right','straight'])),
  dogleg_yards integer,
  raw_payload jsonb,
  cached_at timestamptz default now(),
  constraint cached_course_holes_pkey primary key (id),
  constraint cached_course_holes_course_provider_id_hole_number_key unique (course_provider_id, hole_number)
);
create index cached_holes_course_idx on public.cached_course_holes using btree (course_provider_id);
create index cached_courses_location_idx on public.cached_golf_courses using btree (latitude, longitude);
create index cached_courses_provider_idx on public.cached_golf_courses using btree (provider_id);

create table public.coach_profiles (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  business_name text,
  bio text,
  specialties text[],
  certification text,
  hourly_rate numeric,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint coach_profiles_pkey primary key (id),
  constraint coach_profiles_user_id_key unique (user_id)
);

create table public.coach_golfer_relationships (
  id uuid not null default gen_random_uuid(),
  coach_id uuid not null,
  golfer_id uuid not null,
  status text not null default 'pending'
    constraint coach_golfer_relationships_status_check
    check (status = any (array['pending','active','declined','removed'])),
  invited_by uuid,
  created_at timestamptz default now(),
  accepted_at timestamptz,
  constraint coach_golfer_relationships_pkey primary key (id),
  constraint coach_golfer_relationships_coach_id_golfer_id_key unique (coach_id, golfer_id)
);
create index coach_golfer_coach_idx on public.coach_golfer_relationships using btree (coach_id);
create index coach_golfer_golfer_idx on public.coach_golfer_relationships using btree (golfer_id);

create table public.coach_student_relationships (
  id uuid not null default gen_random_uuid(),
  coach_id uuid not null,
  student_id uuid not null,
  status text not null default 'active'
    constraint coach_student_relationships_status_check
    check (status = any (array['pending','active','inactive','removed'])),
  primary_launch_monitor_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coach_student_relationships_pkey primary key (id),
  constraint coach_student_relationships_coach_id_student_id_key unique (coach_id, student_id)
);

create table public.coach_feedback (
  id uuid not null default gen_random_uuid(),
  swing_video_id uuid not null,
  swing_analysis_id uuid,
  coach_id uuid not null,
  golfer_id uuid not null,
  feedback text not null,
  priority text
    constraint coach_feedback_priority_check
    check (priority = any (array['low','medium','high','critical'])),
  drills jsonb default '[]'::jsonb,
  status text default 'published'
    constraint coach_feedback_status_check
    check (status = any (array['draft','published'])),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint coach_feedback_pkey primary key (id)
);
create index coach_feedback_coach_idx on public.coach_feedback using btree (coach_id);
create index coach_feedback_golfer_idx on public.coach_feedback using btree (golfer_id);

create table public.lesson_plans (
  id uuid not null default gen_random_uuid(),
  coach_id uuid not null,
  golfer_id uuid not null,
  title text not null,
  description text,
  goals jsonb default '[]'::jsonb,
  drills jsonb default '[]'::jsonb,
  due_date date,
  status text default 'active'
    constraint lesson_plans_status_check
    check (status = any (array['active','completed','archived'])),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint lesson_plans_pkey primary key (id)
);
create index lesson_plans_coach_idx on public.lesson_plans using btree (coach_id);
create index lesson_plans_golfer_idx on public.lesson_plans using btree (golfer_id);

create table public.launch_monitor_data (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  swing_video_id uuid,
  provider text,
  original_filename text,
  storage_path text,
  raw_payload jsonb,
  normalized_metrics jsonb,
  created_at timestamptz default now(),
  constraint launch_monitor_data_pkey primary key (id)
);
create index lm_data_user_idx on public.launch_monitor_data using btree (user_id);
create index lm_data_video_idx on public.launch_monitor_data using btree (swing_video_id);

create table public.launch_monitor_sessions (
  id uuid not null default gen_random_uuid(),
  student_id uuid not null,
  coach_id uuid,
  club_path_deg numeric,
  face_to_path_deg numeric,
  attack_angle_deg numeric,
  ball_speed_mph numeric,
  club_type text,
  device_type text,
  session_date date not null default CURRENT_DATE,
  notes text,
  created_at timestamptz default now(),
  constraint launch_monitor_sessions_pkey primary key (id)
);

create table public.automated_prescriptions (
  id uuid not null default gen_random_uuid(),
  coach_id uuid,
  student_id uuid not null,
  drill_id uuid not null,
  status text not null default 'active'
    constraint automated_prescriptions_status_check
    check (status = any (array['active','in_progress','completed','revoked'])),
  notes text,
  assigned_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  session_id uuid,
  constraint automated_prescriptions_pkey primary key (id)
);
create index idx_ap_session_id on public.automated_prescriptions using btree (session_id);

create table public.user_goals (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  handicap_baseline numeric,
  primary_miss varchar,
  target_goal text,
  ai_syllabus jsonb,
  created_at timestamptz default now(),
  constraint user_goals_pkey primary key (id)
);

create table public.drill_submissions (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  drill_name varchar,
  video_url text,
  ai_feedback jsonb,
  status varchar default 'pending',
  created_at timestamptz default now(),
  constraint drill_submissions_pkey primary key (id)
);

create table public.range_sessions (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  session_type varchar,
  exercise_data jsonb,
  completed_at timestamptz default now(),
  constraint range_sessions_pkey primary key (id)
);

create table public.user_drills (
  id uuid not null default gen_random_uuid(),
  created_at timestamptz default now(),
  user_id uuid not null,
  drill_id uuid not null,
  status text default 'pending',
  latest_ai_feedback text,
  video_url text,
  constraint user_drills_pkey primary key (id)
);

create table public.user_bags (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  club_type text not null,
  make text not null,
  model text not null,
  shaft_flex text,
  loft numeric,
  created_at timestamptz not null default timezone('utc', now()),
  constraint user_bags_pkey primary key (id)
);

create table public.user_clubs (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  club_type text not null,
  brand text not null,
  model text not null,
  specs text,
  created_at timestamptz not null default now(),
  constraint user_clubs_pkey primary key (id)
);
create index idx_user_clubs_user_id on public.user_clubs using btree (user_id);

create table public.rounds (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  course_name text not null,
  igolf_course_id text,
  course_rating numeric,
  slope_rating integer,
  total_score integer not null,
  total_putts integer not null,
  gir_percentage integer not null,
  fairways_hit integer not null,
  played_at timestamptz not null default now(),
  constraint rounds_pkey primary key (id)
);
create index idx_rounds_user_id on public.rounds using btree (user_id);
create index idx_rounds_played_at on public.rounds using btree (user_id, played_at desc);

-- Extra btree matching production's redundant (non-unique) index on top of
-- the unique constraint index of the same column — reproduced faithfully
-- rather than treated as an inferred duplicate.
create index users_stripe_customer_id_idx on public.users using btree (stripe_customer_id);

-- ============================================================================
-- C. Foreign keys (added after all tables exist; ON DELETE behavior copied
--    exactly from production catalog evidence, including the absence of any
--    foreign key on user_bags.user_id and swings.user_id, which are text/
--    unconstrained in production and are NOT corrected here)
-- ============================================================================

alter table public.users
  add constraint users_id_fkey foreign key (id) references auth.users(id) on delete cascade;

alter table public.swing_videos
  add constraint swing_videos_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;

alter table public.user_equipment
  add constraint user_equipment_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.swing_telemetry
  add constraint swing_telemetry_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  add constraint swing_telemetry_swing_video_id_fkey foreign key (swing_video_id) references public.swing_videos(id) on delete set null,
  add constraint swing_telemetry_club_id_fkey foreign key (club_id) references public.user_equipment(id) on delete set null;

alter table public.swing_analysis
  add constraint swing_analysis_swing_video_id_fkey foreign key (swing_video_id) references public.swing_videos(id) on delete cascade,
  add constraint swing_analysis_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade,
  add constraint swing_analysis_club_id_fkey foreign key (club_id) references public.user_equipment(id) on delete set null,
  add constraint swing_analysis_telemetry_id_fkey foreign key (telemetry_id) references public.swing_telemetry(id) on delete set null;

alter table public.swing_analyses
  add constraint swing_analyses_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.swing_breakdowns
  add constraint swing_breakdowns_swing_id_fkey foreign key (swing_id) references public.swings(id) on delete cascade;

alter table public.swing_strengths
  add constraint swing_strengths_swing_id_fkey foreign key (swing_id) references public.swings(id) on delete cascade;

alter table public.swing_faults
  add constraint swing_faults_swing_id_fkey foreign key (swing_id) references public.swings(id) on delete cascade;

alter table public.cached_course_holes
  add constraint cached_course_holes_course_provider_id_fkey foreign key (course_provider_id) references public.cached_golf_courses(provider_id) on delete cascade;

alter table public.coach_profiles
  add constraint coach_profiles_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.coach_golfer_relationships
  add constraint coach_golfer_relationships_coach_id_fkey foreign key (coach_id) references auth.users(id) on delete cascade,
  add constraint coach_golfer_relationships_golfer_id_fkey foreign key (golfer_id) references auth.users(id) on delete cascade,
  add constraint coach_golfer_relationships_invited_by_fkey foreign key (invited_by) references auth.users(id);

alter table public.coach_student_relationships
  add constraint coach_student_relationships_coach_id_fkey foreign key (coach_id) references auth.users(id) on delete cascade,
  add constraint coach_student_relationships_student_id_fkey foreign key (student_id) references auth.users(id) on delete cascade;

alter table public.coach_feedback
  add constraint coach_feedback_swing_video_id_fkey foreign key (swing_video_id) references public.swing_videos(id) on delete cascade,
  add constraint coach_feedback_swing_analysis_id_fkey foreign key (swing_analysis_id) references public.swing_analysis(id) on delete set null,
  add constraint coach_feedback_coach_id_fkey foreign key (coach_id) references auth.users(id) on delete cascade,
  add constraint coach_feedback_golfer_id_fkey foreign key (golfer_id) references auth.users(id) on delete cascade;

alter table public.lesson_plans
  add constraint lesson_plans_coach_id_fkey foreign key (coach_id) references auth.users(id) on delete cascade,
  add constraint lesson_plans_golfer_id_fkey foreign key (golfer_id) references auth.users(id) on delete cascade;

alter table public.launch_monitor_data
  add constraint launch_monitor_data_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  add constraint launch_monitor_data_swing_video_id_fkey foreign key (swing_video_id) references public.swing_videos(id) on delete cascade;

alter table public.launch_monitor_sessions
  add constraint launch_monitor_sessions_student_id_fkey foreign key (student_id) references auth.users(id) on delete cascade,
  add constraint launch_monitor_sessions_coach_id_fkey foreign key (coach_id) references auth.users(id) on delete set null;

alter table public.automated_prescriptions
  add constraint automated_prescriptions_student_id_fkey foreign key (student_id) references auth.users(id) on delete cascade,
  add constraint automated_prescriptions_coach_id_fkey foreign key (coach_id) references auth.users(id) on delete cascade,
  add constraint automated_prescriptions_drill_id_fkey foreign key (drill_id) references public.drills(id) on delete cascade,
  add constraint automated_prescriptions_session_id_fkey foreign key (session_id) references public.launch_monitor_sessions(id) on delete set null;

alter table public.user_goals
  add constraint user_goals_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.drill_submissions
  add constraint drill_submissions_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.range_sessions
  add constraint range_sessions_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.user_drills
  add constraint user_drills_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  add constraint user_drills_drill_id_fkey foreign key (drill_id) references public.drills(id) on delete cascade;

alter table public.user_clubs
  add constraint user_clubs_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.rounds
  add constraint rounds_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

-- ============================================================================
-- D. Functions (application-owned only — no internal Supabase functions)
-- ============================================================================

create function public.generate_coach_invite_code()
returns text
language plpgsql
as $function$
DECLARE
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code  text;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..6 LOOP
      code := code || substr(chars, (floor(random() * length(chars)))::int + 1, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.users WHERE coach_invite_code = code
    );
  END LOOP;
  RETURN code;
END;
$function$;

create function public.auto_assign_coach_invite_code()
returns trigger
language plpgsql
as $function$
BEGIN
  IF NEW.role = 'coach' AND NEW.coach_invite_code IS NULL THEN
    NEW.coach_invite_code := public.generate_coach_invite_code();
  END IF;
  RETURN NEW;
END;
$function$;

create function public.handle_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$function$;

create function public.link_student_to_coach(invite_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_coach_id        uuid;
  v_student_id      uuid;
  v_existing_status text;
BEGIN
  v_student_id := auth.uid();
  IF v_student_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;

  -- Resolve coach by invite code
  SELECT id INTO v_coach_id
  FROM public.users
  WHERE coach_invite_code = upper(trim(invite_code))
    AND role = 'coach'
  LIMIT 1;

  IF v_coach_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid code. Double-check and try again.');
  END IF;

  IF v_coach_id = v_student_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'You cannot connect to yourself.');
  END IF;

  -- Check existing relationship
  SELECT status INTO v_existing_status
  FROM public.coach_student_relationships
  WHERE coach_id = v_coach_id AND student_id = v_student_id;

  IF v_existing_status = 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'You''re already connected to this coach.');
  END IF;

  IF v_existing_status IS NOT NULL THEN
    -- Re-activate a removed/inactive relationship
    UPDATE public.coach_student_relationships
    SET status = 'active', updated_at = now()
    WHERE coach_id = v_coach_id AND student_id = v_student_id;
  ELSE
    INSERT INTO public.coach_student_relationships (coach_id, student_id, status)
    VALUES (v_coach_id, v_student_id, 'active');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;

-- Function execution privileges — matches live catalog evidence exactly.
-- handle_new_user is deliberately NOT callable by anon/authenticated in
-- production (it only ever runs via the AFTER INSERT trigger on
-- auth.users), so its default PUBLIC execute grant is revoked here to
-- match; the other four functions keep the default broad EXECUTE grant.
revoke execute on function public.handle_new_user() from public;
grant execute on function public.handle_new_user() to service_role;

-- ============================================================================
-- E. Triggers
-- ============================================================================

create trigger trg_auto_assign_coach_invite_code
  before insert or update of role on public.users
  for each row execute function public.auto_assign_coach_invite_code();

create trigger set_updated_at_user_equipment
  before update on public.user_equipment
  for each row execute function public.handle_updated_at();

create trigger set_updated_at_swing_telemetry
  before update on public.swing_telemetry
  for each row execute function public.handle_updated_at();

-- The production signup trigger lives on the Supabase-managed auth.users
-- table. auth.users itself is NOT recreated here (it is a managed relation
-- provided by every standard Supabase project) — only this application-owned
-- trigger and its function are added to it, exactly as in production.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- F. Row Level Security — enablement (no FORCE ROW LEVEL SECURITY anywhere
--    in production; not added here either)
-- ============================================================================

alter table public.users enable row level security;
alter table public.swing_videos enable row level security;
alter table public.swing_analysis enable row level security;
alter table public.coach_profiles enable row level security;
alter table public.coach_golfer_relationships enable row level security;
alter table public.coach_feedback enable row level security;
alter table public.lesson_plans enable row level security;
alter table public.launch_monitor_data enable row level security;
alter table public.cached_golf_courses enable row level security;
alter table public.cached_course_holes enable row level security;
alter table public.swing_analyses enable row level security;
alter table public.user_equipment enable row level security;
alter table public.swing_telemetry enable row level security;
alter table public.user_goals enable row level security;
alter table public.drill_submissions enable row level security;
alter table public.range_sessions enable row level security;
alter table public.drills enable row level security;
alter table public.user_drills enable row level security;
alter table public.coach_student_relationships enable row level security;
alter table public.launch_monitor_sessions enable row level security;
alter table public.automated_prescriptions enable row level security;
alter table public.swings enable row level security;
alter table public.swing_breakdowns enable row level security;
alter table public.swing_strengths enable row level security;
alter table public.swing_faults enable row level security;
alter table public.user_bags enable row level security;
alter table public.user_clubs enable row level security;
alter table public.rounds enable row level security;

-- ============================================================================
-- G. RLS policies
--
-- These reproduce the EXACT current production policy catalog, including
-- the three weak, over-permissive policies that SEC1A's own source-only
-- contract (supabase-security-sec1a.sql) is designed to remove. They are
-- included here deliberately, NOT omitted, so this baseline is a faithful
-- staging target against which SEC1A can later be applied and tested. SEC1A
-- itself is NOT applied anywhere in this file.
--
-- drill_submissions, range_sessions, swing_breakdowns, swing_faults, and
-- swing_strengths have RLS enabled above but carry NO policy in production
-- (default-deny for anon/authenticated; reachable only via service_role
-- BYPASSRLS) — reproduced faithfully by simply defining no policy for them.
-- ============================================================================

-- public.users
create policy "Users can insert own profile" on public.users
  for insert with check (auth.uid() = id);
create policy "Users can view own profile" on public.users
  for select using (auth.uid() = id);
create policy "students_can_read_coach_profile" on public.users
  for select using (exists (
    select 1 from public.coach_student_relationships
    where coach_student_relationships.student_id = auth.uid()
      and coach_student_relationships.coach_id = users.id
      and coach_student_relationships.status = 'active'
  ));
create policy "users_coach_reads_students" on public.users
  for select using (
    auth.uid() = id
    or exists (
      select 1 from public.coach_student_relationships
      where coach_student_relationships.coach_id = auth.uid()
        and coach_student_relationships.student_id = users.id
        and coach_student_relationships.status = 'active'
    )
  );
create policy "Users can update own profile" on public.users
  for update using (auth.uid() = id);

-- public.swing_videos
create policy "Users can insert own videos" on public.swing_videos
  for insert with check (auth.uid() = user_id);
create policy "Users can view own videos" on public.swing_videos
  for select using (auth.uid() = user_id);
create policy "Users can update own videos" on public.swing_videos
  for update using (auth.uid() = user_id);
create policy "Users can delete own videos" on public.swing_videos
  for delete using (auth.uid() = user_id);

-- public.swing_analysis
create policy "Users can insert own analysis" on public.swing_analysis
  for insert with check (auth.uid() = user_id);
create policy "Users can view own analysis" on public.swing_analysis
  for select using (auth.uid() = user_id);
create policy "Users can update own analysis" on public.swing_analysis
  for update using (auth.uid() = user_id);
create policy "Users can delete own analysis" on public.swing_analysis
  for delete using (auth.uid() = user_id);

-- public.coach_profiles
create policy "Coaches can manage their own profile" on public.coach_profiles
  for all using (auth.uid() = user_id);
create policy "Anyone can view active coach profiles" on public.coach_profiles
  for select using (is_active = true);

-- public.coach_golfer_relationships
create policy "Coach can manage their relationships" on public.coach_golfer_relationships
  for all using (auth.uid() = coach_id);
create policy "Coach or golfer can view their relationships" on public.coach_golfer_relationships
  for select using (auth.uid() = coach_id or auth.uid() = golfer_id);
create policy "Golfer can update their own relationship status" on public.coach_golfer_relationships
  for update using (auth.uid() = golfer_id);

-- public.coach_feedback
create policy "Coach can manage their feedback" on public.coach_feedback
  for all using (auth.uid() = coach_id);
create policy "Golfer can view feedback on their swings" on public.coach_feedback
  for select using (auth.uid() = golfer_id);

-- public.lesson_plans
create policy "Coach can manage lesson plans" on public.lesson_plans
  for all using (auth.uid() = coach_id);
create policy "Golfer can view their lesson plans" on public.lesson_plans
  for select using (auth.uid() = golfer_id);

-- public.launch_monitor_data
create policy "Users can manage their own launch monitor data" on public.launch_monitor_data
  for all using (auth.uid() = user_id);

-- public.cached_golf_courses
create policy "Anyone can read cached courses" on public.cached_golf_courses
  for select to authenticated using (true);

-- public.cached_course_holes
create policy "Anyone can read cached holes" on public.cached_course_holes
  for select to authenticated using (true);

-- public.swing_analyses
create policy "Users can insert own analyses" on public.swing_analyses
  for insert with check (auth.uid() = user_id);
create policy "Users can read own analyses" on public.swing_analyses
  for select using (auth.uid() = user_id);

-- public.user_equipment
create policy "Users manage own equipment" on public.user_equipment
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- public.swing_telemetry
create policy "Users manage own telemetry" on public.swing_telemetry
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- public.user_goals — weak policies (pre-SEC1A, intentionally reproduced)
create policy "Allow authenticated inserts" on public.user_goals
  for insert to authenticated with check (true);
create policy "Allow users to view own goals" on public.user_goals
  for select to authenticated using (auth.uid() = user_id or user_id is null);
-- public.user_goals — strict policies (SEC1A-protected)
create policy "Users can insert own goals" on public.user_goals
  for insert with check (auth.uid() = user_id);
create policy "Users can view own goals" on public.user_goals
  for select using (auth.uid() = user_id);

-- public.drills
create policy "Allow authenticated users to read drills" on public.drills
  for select to authenticated using (true);
create policy "Allow admins to modify drills" on public.drills
  for all to authenticated
  using (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)
  with check (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text);

-- public.user_drills
create policy "Users can insert their own drills" on public.user_drills
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can view their own drills" on public.user_drills
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can update their own drills" on public.user_drills
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- public.coach_student_relationships
create policy "csr_coach_all" on public.coach_student_relationships
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);
create policy "csr_student_select" on public.coach_student_relationships
  for select using (auth.uid() = student_id);

-- public.launch_monitor_sessions
create policy "lms_student_select" on public.launch_monitor_sessions
  for select using (auth.uid() = student_id);
create policy "lms_coach_select" on public.launch_monitor_sessions
  for select using (exists (
    select 1 from public.coach_student_relationships
    where coach_student_relationships.coach_id = auth.uid()
      and coach_student_relationships.student_id = launch_monitor_sessions.student_id
      and coach_student_relationships.status = 'active'
  ));
create policy "lms_coach_insert" on public.launch_monitor_sessions
  for insert with check (
    auth.uid() = coach_id
    and exists (
      select 1 from public.coach_student_relationships
      where coach_student_relationships.coach_id = auth.uid()
        and coach_student_relationships.student_id = launch_monitor_sessions.student_id
        and coach_student_relationships.status = 'active'
    )
  );

-- public.automated_prescriptions
create policy "ap_student_select" on public.automated_prescriptions
  for select using (auth.uid() = student_id);
create policy "ap_coach_all" on public.automated_prescriptions
  for all using (auth.uid() = coach_id) with check (auth.uid() = coach_id);

-- public.swings
create policy "Users can insert their own swings" on public.swings
  for insert with check (auth.uid()::text = user_id);
create policy "Users can view their own swings" on public.swings
  for select using (auth.uid()::text = user_id);
create policy "Users can update their own swings" on public.swings
  for update using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
create policy "Users can delete their own swings" on public.swings
  for delete using (auth.uid()::text = user_id);

-- public.user_bags
create policy "Users can view their own bag" on public.user_bags
  for select using (auth.uid() = user_id);
create policy "Users can insert into their own bag" on public.user_bags
  for insert with check (auth.uid() = user_id);
create policy "Users can update their own bag" on public.user_bags
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete from their own bag" on public.user_bags
  for delete using (auth.uid() = user_id);

-- public.user_clubs
create policy "Users can view their own clubs" on public.user_clubs
  for select using (auth.uid() = user_id);
create policy "Users can insert their own clubs" on public.user_clubs
  for insert with check (auth.uid() = user_id);
create policy "Users can update their own clubs" on public.user_clubs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own clubs" on public.user_clubs
  for delete using (auth.uid() = user_id);

-- public.rounds
create policy "Users can view their own rounds" on public.rounds
  for select using (auth.uid() = user_id);
create policy "Users can insert their own rounds" on public.rounds
  for insert with check (auth.uid() = user_id);
create policy "Users can update their own rounds" on public.rounds
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own rounds" on public.rounds
  for delete using (auth.uid() = user_id);

-- storage.objects — swing-videos and drill_videos bucket policies.
-- storage.objects itself is a Supabase-managed relation and is NOT
-- recreated here; only these application-created policies are added to it,
-- exactly matching the current production policy catalog. This
-- deliberately includes the weak "Allow Anonymous Uploads xuww7b_0" policy
-- (pre-SEC1A) alongside the strict, SEC1A-protected owner-scoped policies.
create policy "Allow Anonymous Uploads xuww7b_0" on storage.objects
  for insert to anon
  with check (bucket_id = 'swing-videos');

create policy "Users can upload their own swing videos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'swing-videos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can read their own swing videos" on storage.objects
  for select to authenticated
  using (bucket_id = 'swing-videos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own swing videos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'swing-videos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can upload drill videos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'drill_videos' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can view own drill videos" on storage.objects
  for select to authenticated
  using (bucket_id = 'drill_videos' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============================================================================
-- H. Grants — matches the exact current production blanket grant pattern
--    for every application table (anon/authenticated/service_role each
--    hold DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE — this is
--    the standard Supabase default privilege set applied when a table is
--    created in a fresh project, confirmed here against live catalog
--    evidence rather than assumed).
-- ============================================================================

grant delete, insert, references, select, trigger, truncate, update on public.users to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_videos to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_analysis to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.coach_profiles to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.coach_golfer_relationships to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.coach_feedback to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.lesson_plans to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.launch_monitor_data to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.cached_golf_courses to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.cached_course_holes to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_analyses to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.user_equipment to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_telemetry to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.user_goals to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.drill_submissions to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.range_sessions to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.drills to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.user_drills to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.coach_student_relationships to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.launch_monitor_sessions to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.automated_prescriptions to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swings to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_breakdowns to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_strengths to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.swing_faults to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.user_bags to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.user_clubs to anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on public.rounds to anon, authenticated, service_role;

-- ============================================================================
-- I. Storage bucket configuration — deterministic infrastructure rows only.
--    No storage objects, file metadata, signed URLs, or user content.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, avif_autodetection)
values
  ('swing-videos', 'swing-videos', false, null, null, false),
  ('drill_videos', 'drill_videos', false, null, null, false)
on conflict (id) do nothing;

-- ============================================================================
-- POSTFLIGHT — fail loud if the resulting catalog does not match the
-- expected minimum inventory
-- ============================================================================
do $$
declare
  v_table_count int;
  v_policy_count int;
  v_function_count int;
  v_trigger_count int;
begin
  select count(*) into v_table_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in (
        'users','swing_videos','swing_analysis','coach_profiles',
        'coach_golfer_relationships','coach_feedback','lesson_plans',
        'launch_monitor_data','cached_golf_courses','cached_course_holes',
        'swing_analyses','user_equipment','swing_telemetry','user_goals',
        'drill_submissions','range_sessions','drills','user_drills',
        'coach_student_relationships','launch_monitor_sessions',
        'automated_prescriptions','swings','swing_breakdowns',
        'swing_strengths','swing_faults','user_bags','user_clubs','rounds'
      );
  if v_table_count <> 28 then
    raise exception 'RR1-POST-1: expected exactly 28 application tables to exist after baseline creation, found %.', v_table_count;
  end if;

  select count(*) into v_policy_count
    from pg_policies
    where schemaname = 'public'
       or (schemaname = 'storage' and tablename = 'objects');
  if v_policy_count <> 67 then
    raise exception 'RR1-POST-2: expected exactly 67 policies across public and storage.objects, found %.', v_policy_count;
  end if;

  select count(*) into v_function_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public';
  if v_function_count <> 5 then
    raise exception 'RR1-POST-3: expected exactly 5 application functions, found %.', v_function_count;
  end if;

  select count(*) into v_trigger_count
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not tg.tgisinternal
      and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'));
  if v_trigger_count <> 4 then
    raise exception 'RR1-POST-4: expected exactly 4 application-relevant triggers, found %.', v_trigger_count;
  end if;

  raise notice 'RR1-POST-OK: baseline catalog matches the expected inventory (28 tables, 67 policies, 5 functions, 4 triggers).';
end $$;

commit;
