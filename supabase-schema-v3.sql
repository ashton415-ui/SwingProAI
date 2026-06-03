-- SwingProAI — Schema v3: swing_videos upload fields + Storage bucket
-- Run in: Supabase Dashboard > SQL Editor > New query > Run

-- ─────────────────────────────────────────────
-- 1. Add upload metadata columns to swing_videos
-- ─────────────────────────────────────────────
alter table public.swing_videos
  add column if not exists original_filename text,
  add column if not exists file_size bigint,
  add column if not exists mime_type text;

-- 2. Update status check constraint to include 'uploaded'
alter table public.swing_videos
  drop constraint if exists swing_videos_status_check;

alter table public.swing_videos
  add constraint swing_videos_status_check
    check (status in ('pending', 'uploaded', 'processing', 'complete', 'failed'));

-- ─────────────────────────────────────────────
-- 3. Supabase Storage bucket
-- ─────────────────────────────────────────────
-- Create the bucket (private — no public access)
insert into storage.buckets (id, name, public)
values ('swing-videos', 'swing-videos', false)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────
-- 4. Storage RLS policies
-- ─────────────────────────────────────────────

-- Allow authenticated users to upload to their own folder
create policy "Users can upload their own swing videos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to read their own videos
create policy "Users can read their own swing videos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow authenticated users to delete their own videos
create policy "Users can delete their own swing videos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
