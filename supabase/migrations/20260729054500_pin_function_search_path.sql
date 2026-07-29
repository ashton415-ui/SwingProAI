-- ============================================================================
-- SwingProAI - SEC1B-FN: Pin function search paths
-- ============================================================================
--
-- Resolves three `function_search_path_mutable` security-advisor warnings by
-- pinning an empty search path on three existing invoker-rights functions.
--
-- Each target was independently confirmed during the SEC1A-P1 read-only
-- inspection, and again immediately before this file was authored, to report
-- prosecdef = false and proconfig = null in both production and staging.
--
-- Every object reference inside the three bodies is already schema-qualified,
-- so pinning the search path is behavior-preserving:
--
--   * public.handle_updated_at()
--       uses only now(), which resolves from pg_catalog regardless of the
--       active search path.
--
--   * public.generate_coach_invite_code()
--       references public.users explicitly, plus pg_catalog builtins.
--
--   * public.auto_assign_coach_invite_code()
--       calls public.generate_coach_invite_code() explicitly.
--
-- SCOPE
-- -----
-- This file adjusts exactly the three function configuration settings below
-- and nothing else. It defines no new routine, removes nothing, alters no
-- privilege, alters no row-level access rule, and leaves every function body
-- and security mode exactly as-is. No table, column, constraint, index,
-- trigger, row, role, storage object, or Auth setting is affected.
--
-- Reversal: reset the search_path setting on each of the three targets.
--
-- THIS MIGRATION IS NOT APPLIED BY THIS GATE. Staging validation and
-- production application are separately authorized gates.
-- ============================================================================

begin;

alter function public.handle_updated_at()
  set search_path = '';

alter function public.generate_coach_invite_code()
  set search_path = '';

alter function public.auto_assign_coach_invite_code()
  set search_path = '';

commit;
