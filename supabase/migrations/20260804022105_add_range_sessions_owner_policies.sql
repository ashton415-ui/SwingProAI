-- ============================================================================
-- SwingProAI — SEC1F range_sessions owner-scoped access
-- ============================================================================
--
-- Restores the application-required authenticated access model without
-- widening access beyond row ownership. This migration does not alter table
-- structure, grants, or existing data.
--
begin;

create policy "Users can insert own range sessions"
on public.range_sessions
as permissive
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can view own range sessions"
on public.range_sessions
as permissive
for select
to authenticated
using ((select auth.uid()) = user_id);

commit;
