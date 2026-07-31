-- SwingProAI - SEC1D: drop three weak RLS policies per the SEC1A contract
--
-- Each policy removed here is PERMISSIVE and coexists with a stricter policy
-- for the same relation and command. PostgreSQL OR-combines permissive
-- policies, so each of these neutralizes its stricter counterpart. Removing
-- them lets the stricter policy actually govern access. No policy is created,
-- and every stricter counterpart is left untouched.
--
-- 1. storage.objects "Allow Anonymous Uploads xuww7b_0"
--      anon INSERT into the private swing-videos bucket with no
--      folder-ownership check. Not reported by the Supabase advisor, which
--      lints the public schema only. Highest severity of the three.
--
-- 2. public.user_goals "Allow authenticated inserts"
--      INSERT for authenticated with WITH CHECK true, permitting a row to be
--      written with any user_id. Advisor-visible.
--
-- 3. public.user_goals "Allow users to view own goals"
--      SELECT whose USING clause also matches rows with a null owner,
--      exposing them to every signed-in user. Not advisor-flagged.
--
-- No IF EXISTS: a missing or renamed policy must fail loudly, and the
-- surrounding transaction rolls the whole change back.
--
-- THIS MIGRATION IS NOT APPLIED BY THE AUTHORING GATE. Staging validation and
-- production application are separately authorized gates.

begin;

drop policy "Allow Anonymous Uploads xuww7b_0"
on storage.objects;

drop policy "Allow authenticated inserts"
on public.user_goals;

drop policy "Allow users to view own goals"
on public.user_goals;

commit;
