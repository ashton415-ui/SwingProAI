# Supabase Security: SECURITY DEFINER Acceptance

## Status and Decision

- Status: Accepted
- Security workstream: SEC1G
- Production project ref: atlmnqispyzhsahahpjy
- Effective date: 2026-08-06

This record formally accepts exactly one current production security-advisor
WARN:

- Finding: `authenticated_security_definer_function_executable`
- Target: `public.link_student_to_coach(invite_code text)`

The approved SEC1G decision is to retain `SECURITY DEFINER`, retain
`authenticated` EXECUTE, document the exception, and make no functional or
database change.

The acceptance preserves the existing required first-time coach-linking
workflow. It does not claim the advisor warning was fixed, cleared, removed,
suppressed, or that it has disappeared. The warning remains present in the
production advisor output, and this record exists so that its presence is
deliberate and reviewable rather than unexplained.

## Scope

This acceptance applies only to the finding
`authenticated_security_definer_function_executable` for
`public.link_student_to_coach(invite_code text)`.

It accepts no other:

- WARN
- INFO
- function
- RPC
- RLS policy
- table-access pattern
- future privileged function
- future modification of this function

A different function, a different advisor finding, or a changed body of this
function is outside this record and requires its own review.

## Current Production Identity

| Property | Value |
| --- | --- |
| Project ref | `atlmnqispyzhsahahpjy` |
| Function signature | `public.link_student_to_coach(invite_code text)` |
| Catalog signature | `link_student_to_coach(text)` |
| Return type | `jsonb` |
| Owner | `postgres` |
| Language | `plpgsql` |
| Security mode | `SECURITY DEFINER` |
| `search_path` | `public` |
| Raw `pg_proc.prosrc` MD5 | `57faf54e69c968a39b45deb4433294f1` |
| Effective execution — `anon` | false |
| Effective execution — `authenticated` | true |
| Effective execution — `service_role` | true |
| Hosted ACL | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |

Advisor finding name:

`authenticated_security_definer_function_executable`

Advisor cache key:

`authenticated_security_definer_function_executable_public_link_student_to_coach_invite_code text`

Advisor reference:

<https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable>

## Why SECURITY DEFINER Is Required

`SECURITY DEFINER` is retained deliberately. It is the mechanism that makes
first-time linking possible under the current row-level security model — not an
accidental leftover, and not a shortcut taken to avoid writing policies.

Two independent RLS dependencies block a mechanical conversion to
`SECURITY INVOKER`:

1. **Coach lookup.** The function resolves the coach by matching
   `public.users.coach_invite_code` where `role = 'coach'`. Before any
   relationship exists, the calling student matches no `public.users` SELECT
   policy for that coach's row. It is not the caller's own profile;
   `students_can_read_coach_profile` requires an already-active coach/student
   relationship, which is the very thing being created; and
   `users_coach_reads_students` requires the caller to be that row's coach.
   Under `SECURITY INVOKER` the lookup would return no row, so every valid
   invite code would be reported as invalid.

2. **Relationship write.** The function inserts, or reactivates, a row in
   `public.coach_student_relationships`. The applicable policy `csr_coach_all`
   authorizes on `auth.uid() = coach_id`, while the authenticated caller in this
   workflow is `student_id`. `csr_student_select` grants SELECT only. Under
   `SECURITY INVOKER` the required INSERT and the reactivating UPDATE would both
   be rejected.

Changing only `SECURITY DEFINER` to `SECURITY INVOKER` would therefore break the
current required first-time-linking behavior.

This record does not propose broadening `public.users` SELECT access, nor adding
a student-side write policy on `public.coach_student_relationships`, in order to
make an invoker-rights conversion possible. Either change would widen access
beyond what exists today, and widening access to clear an advisor finding is not
a valid trade.

## Why Authenticated EXECUTE Is Required

The current application path is:

`swingmaster-web/components/dashboard/ConnectToCoachForm.tsx`
→ `swingmaster-web/app/actions/coach.ts`
→ normal authenticated, session-bound Supabase server client
→ `supabase.rpc('link_student_to_coach', { invite_code: code })`

The server action verifies an authenticated user before making the RPC call.

Revoking `authenticated` EXECUTE would break this feature: the session-bound
client executes as the `authenticated` role, so every user-facing connect
attempt would fail.

Substituting `service_role` is not a drop-in equivalent. The function derives
caller identity from `auth.uid()`, which is not populated for a service-role
client, so the function would take its "not authenticated" branch. Preserving
behavior would require re-parameterizing the function to accept an explicit
student identifier and adding a trusted server path that asserts that identifier
matches the verified session user.

That is a server-only privileged redesign — a separate architectural workstream,
outside this acceptance.

## Function Security Boundaries

The checked-in and hosted function currently:

- derives `student_id` only from `auth.uid()`
- accepts `invite_code` as its only caller-controlled parameter
- accepts no caller-supplied `coach_id`
- accepts no caller-supplied `student_id`
- rejects a null `auth.uid()`
- resolves targets only where `public.users.role = 'coach'`
- rejects self-linking
- reads and writes schema-qualified application relations
- contains no dynamic SQL
- creates or reactivates only the authenticated caller's own student
  relationship
- returns JSON success or error state without returning coach profile fields,
  coach identifiers, email addresses, or other private coach identity data

Anonymous and `PUBLIC` execution were removed by SEC1C. The hosted catalog
separately records an `authenticated=X/postgres` ACL entry; this record states
that current effective state without asserting how that entry originated, and in
particular does not claim that `authenticated` execution is inherited through
`PUBLIC`.

The function does **not** currently require the authenticated caller's
`public.users.role` to equal `golfer`. That gap is recorded here as a known
current property, and is explicitly not accepted or resolved by this document —
see below.

## Explicitly Not Accepted

Accepting the advisor warning above does **not** accept, resolve, waive, or
close any of the following:

- missing explicit golfer-role caller validation
- invite-code rate limiting or throttling
- repeated invalid-code abuse controls
- audit or security logging
- relationship spam controls
- immediate active linking versus a pending coach-approval flow
- `search_path` defense-in-depth tightening
- any performance-advisor finding
- any RLS finding except those covered independently by the existing SEC1F
  record
- any future `SECURITY DEFINER` function
- any future expansion or changed body of `link_student_to_coach`

Each of these stands on its own and requires its own review. None of them is
made safe, closed, or unnecessary by this acceptance.

## Separate Follow-Up Classification

**Recommended separate hardening:**

- explicit golfer-role caller validation
- invite-code throttling / rate limiting
- audit and security logging
- `search_path` tightening after separate validation

**Unresolved pending product decision:**

- immediate active linking versus pending / coach approval

**Out-of-scope architectural redesign:**

- moving the workflow to a server-only / `service_role` privileged
  implementation

None of these is implemented, scheduled, or completed by SEC1G. Listing them
here records that they were considered and deliberately left to separate work,
not that they were addressed.

## Historical Decision Reconciliation

- SEC1C, merged as PR #18 — *SEC1C: Revoke anon and public EXECUTE on
  link_student_to_coach* — made the original engineering decision.
- SEC1C removed `PUBLIC` and `anon` EXECUTE on the function.
- PR #18 deliberately retained `SECURITY DEFINER` and `authenticated` execution,
  and rejected a mechanical `SECURITY INVOKER` conversion because first-time
  linking depends on privileged coach lookup and relationship creation.
- The later SEC1F acceptance record,
  `docs/SUPABASE_SECURITY_ACCEPTED_FINDINGS.md`, accepts exactly five RLS
  no-policy INFO findings. It states explicitly that this authenticated
  `SECURITY DEFINER` WARN is outside its scope, is neither accepted nor resolved
  there, and requires a separately scoped review. SEC1F did not accept this
  warning.
- SEC1G provides the dedicated, checked-in acceptance record that closes that
  documentation gap. Before SEC1G, the decision existed only in PR history.

SEC1G does not change, weaken, or restate the SEC1F five-table allowlist.

## Monitoring and Revalidation

This acceptance must be reassessed if any of the following change:

- function body / `prosrc` MD5
- function signature
- owner
- language, where materially relevant
- `SECURITY DEFINER` mode
- `search_path`
- EXECUTE privileges
- `auth.uid()`-derived student identity
- coach target-role predicate
- `public.users` RLS relevant to coach lookup
- `public.coach_student_relationships` RLS
- application RPC caller
- response contents
- relationship activation / status workflow
- advisor warning name or cache key
- Supabase advisor semantics

A changed function body invalidates automatic reliance on this acceptance until
the changed body receives a separately authorized review. The recorded `prosrc`
MD5 is the anchor for that check.

Acceptance is scoped to the configuration described here as of the effective
date. It is not a statement that the arrangement is safe indefinitely.

## Non-Goals

This documentation-only change does not:

- modify the function
- modify RLS
- grant or revoke privileges
- modify Auth
- execute SQL
- create a migration
- apply or reapply a migration
- change staging
- change production
- change user data
- change application behavior
- suppress the Supabase warning
- claim the warning disappeared
- alter Vercel or any deployment

This document is a record only. It asserts no change to any system.

## Evidence

| Item | Value |
| --- | --- |
| GitHub main baseline | `22ea51d072d256ce667345bfa2958565f99aff97` |
| PR | #18 — SEC1C: Revoke anon and public EXECUTE on link_student_to_coach |
| SEC1C migration | `supabase/migrations/20260730035500_revoke_anon_execute_link_student_to_coach.sql` |
| SEC1C SHA-256 | `a8a20fff1e8959a8974fb13a853c90a6adf83b35b39025aa04928830a340edca` |
| Function `prosrc` MD5 | `57faf54e69c968a39b45deb4433294f1` |
| Advisor finding | `authenticated_security_definer_function_executable` |
| Advisor cache key | `authenticated_security_definer_function_executable_public_link_student_to_coach_invite_code text` |

Application caller files:

- `swingmaster-web/components/dashboard/ConnectToCoachForm.tsx`
- `swingmaster-web/app/actions/coach.ts`

Relevant RLS policy names:

- `csr_coach_all`
- `csr_student_select`
- `students_can_read_coach_profile`
- `users_coach_reads_students`

Related record:

- `docs/SUPABASE_SECURITY_ACCEPTED_FINDINGS.md`
