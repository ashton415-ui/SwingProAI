-- SwingProAI — Schema v5: Drill Verification Engine
-- Run in: Supabase Dashboard > SQL Editor > New query > Run
--
-- Safe + additive: every statement is idempotent (IF NOT EXISTS / guarded),
-- so re-running is a no-op and existing data is untouched.
--
-- Tables created:
--   public.drills       — canonical drill library; admin-write, authenticated-read
--   public.user_drills  — per-user drill assignments + AI verification results

-- ─────────────────────────────────────────────
-- 1. drills — canonical drill library
-- ─────────────────────────────────────────────

create table if not exists public.drills (
  id                    uuid        primary key default gen_random_uuid(),
  created_at            timestamptz not null    default now(),
  name                  text        not null,
  -- Which biomechanical fault this drill addresses (e.g. 'early_extension',
  -- 'hip_rotation', 'shoulder_rotation', 'casting').
  target_metric         text        not null,
  the_why               text        not null,
  the_how               text        not null,
  the_feel              text        not null,
  -- Prompt injected into the AI verification pipeline when a user submits a
  -- practice video. Should describe exactly what correct execution looks like
  -- so the model knows what to check for.
  ai_verification_prompt text       not null
);

comment on table  public.drills is 'Canonical drill library — each row is one prescribable drill with its AI verification prompt.';
comment on column public.drills.target_metric          is 'snake_case fault identifier this drill fixes, e.g. early_extension, restricted_backswing.';
comment on column public.drills.ai_verification_prompt is 'Prompt injected into the Gemini verification pipeline. Describe what correct execution looks like so the model can assess the submitted video.';

-- Index for fast look-up by target metric (AI fitting pipeline queries this)
create index if not exists idx_drills_target_metric on public.drills (target_metric);

-- ─────────────────────────────────────────────
-- 2. user_drills — per-user drill assignments + verification state
-- ─────────────────────────────────────────────

create table if not exists public.user_drills (
  id                  uuid        primary key default gen_random_uuid(),
  created_at          timestamptz not null    default now(),
  user_id             uuid        not null    references auth.users  (id) on delete cascade,
  drill_id            uuid        not null    references public.drills(id) on delete cascade,
  -- Lifecycle: pending → submitted → verified | needs_work
  status              text        not null    default 'pending',
  latest_ai_feedback  text,
  video_url           text
);

comment on table  public.user_drills is 'Per-user drill assignment and AI verification state. One row per (user, drill) practice attempt.';
comment on column public.user_drills.status             is 'pending | submitted | verified | needs_work';
comment on column public.user_drills.latest_ai_feedback is 'Most recent AI coaching feedback on the submitted practice video.';
comment on column public.user_drills.video_url          is 'Storage URL of the practice video the user submitted for verification.';

-- Enforce valid status values (wrapped so re-running never errors on existing constraint)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_drills_status_check'
  ) then
    alter table public.user_drills
      add constraint user_drills_status_check
      check (status in ('pending', 'submitted', 'verified', 'needs_work'));
  end if;
end $$;

-- Composite index: fetch all drills for a user efficiently
create index if not exists idx_user_drills_user_id   on public.user_drills (user_id);
create index if not exists idx_user_drills_drill_id  on public.user_drills (drill_id);
create index if not exists idx_user_drills_status    on public.user_drills (user_id, status);

-- ─────────────────────────────────────────────
-- 3. Row Level Security — drills
--    Authenticated users: SELECT only.
--    Admin users: INSERT, UPDATE, DELETE.
--    "Admin" is determined by app_metadata.role = 'admin' in the Supabase JWT.
--    To grant admin: Supabase Dashboard > Authentication > Users > Edit user
--      > App Metadata > { "role": "admin" }
-- ─────────────────────────────────────────────

alter table public.drills enable row level security;

-- Any authenticated user may read the drill library
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'drills' and policyname = 'Authenticated users can read drills'
  ) then
    create policy "Authenticated users can read drills"
      on public.drills for select
      using (auth.role() = 'authenticated');
  end if;
end $$;

-- Only admin users (app_metadata.role = 'admin') may insert drills
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'drills' and policyname = 'Admins can insert drills'
  ) then
    create policy "Admins can insert drills"
      on public.drills for insert
      with check (
        (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      );
  end if;
end $$;

-- Only admin users may update drills
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'drills' and policyname = 'Admins can update drills'
  ) then
    create policy "Admins can update drills"
      on public.drills for update
      using  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
      with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
  end if;
end $$;

-- Only admin users may delete drills
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'drills' and policyname = 'Admins can delete drills'
  ) then
    create policy "Admins can delete drills"
      on public.drills for delete
      using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
  end if;
end $$;

-- ─────────────────────────────────────────────
-- 4. Row Level Security — user_drills
--    Users can only SELECT, INSERT, and UPDATE their own rows.
--    DELETE is intentionally omitted — history is preserved for analytics.
-- ─────────────────────────────────────────────

alter table public.user_drills enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_drills' and policyname = 'Users can read own drill assignments'
  ) then
    create policy "Users can read own drill assignments"
      on public.user_drills for select
      using (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_drills' and policyname = 'Users can insert own drill assignments'
  ) then
    create policy "Users can insert own drill assignments"
      on public.user_drills for insert
      with check (auth.uid() = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_drills' and policyname = 'Users can update own drill assignments'
  ) then
    create policy "Users can update own drill assignments"
      on public.user_drills for update
      using  (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
