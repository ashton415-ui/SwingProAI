# Supabase Security: Accepted RLS No-Policy Findings

## Status

- Status: Accepted
- Gate: SEC1F-INFO
- Production project ref: atlmnqispyzhsahahpjy
- Effective date: 2026-08-04
- Review trigger: any proposed client-side or authenticated-user access to one
  of the accepted tables

## Decision

The five Supabase security-advisor `rls_enabled_no_policy` INFO findings listed
in the allowlist below are intentionally accepted. Exactly five findings are
accepted by this record.

Every accepted table has row level security enabled and no applicable RLS
policy. In PostgreSQL, a table with RLS enabled and no policy matches no rows
for the roles that RLS applies to. The practical effect for this project is a
deny-by-default posture for normal Supabase Data API access: ordinary requests
made with the `anon` or `authenticated` roles receive no policy-mediated row
access, for select, insert, update, or delete.

These five advisor findings are expected to remain visible. They are
informational, they describe the configuration accurately, and the
configuration is the intended one. No change will be made for the purpose of
clearing them from the advisor output.

## Accepted Table Allowlist

| Table | RLS Enabled | Applicable Policies | Intended Access Posture | Reason for Acceptance |
| --- | --- | --- | --- | --- |
| `public.drill_submissions` | Yes | None | Deny by default | No approved direct client-access requirement is currently documented. |
| `public.equipment_model_sources` | Yes | None | Deny by default | Holds catalog-provenance and source-attribution data intended for trusted administrative or service operations. No approved direct client-access requirement is currently documented. |
| `public.swing_breakdowns` | Yes | None | Deny by default | No approved direct client-access requirement is currently documented. |
| `public.swing_faults` | Yes | None | Deny by default | No approved direct client-access requirement is currently documented. |
| `public.swing_strengths` | Yes | None | Deny by default | No approved direct client-access requirement is currently documented. |

`public.range_sessions` is deliberately **not** on this allowlist. See
"Completed Remediation" below.

### Repository-evidence note

This subsection records verifiable references found in the repository at the
time of this decision. It records evidence only. It does not approve access, and
it does not describe an agreed business workflow.

- `public.equipment_model_sources` is referenced by
  `scripts/generate-equipment-catalog-putters-v1.mjs` and by generated types in
  `types/database.ts`. Neither reference is an authenticated client request
  path.
- The remaining four accepted tables appear in migration and test fixtures
  only, and are not referenced by application request paths found in this
  repository.
- No accepted table currently has an application request path that runs as the
  signed-in user and depends on policy-mediated access.

## Security Meaning

The following boundaries define what this decision does and does not assert.

- RLS enabled with no applicable policy means no row is exposed to the `anon`
  or `authenticated` Data API roles **through an RLS policy**.
- This is materially different from disabling RLS. Disabling RLS would remove
  row filtering entirely and expose rows subject only to table grants. RLS
  remains enabled on every accepted table.
- This does **not** mean every PostgreSQL role is denied. The claim is scoped to
  policy-mediated access.
- Table owners, roles holding `BYPASSRLS`, other privileged administrative
  roles, and properly privileged Supabase service operations may bypass RLS
  according to their own privileges. Access through those paths is unaffected
  by this decision.
- RLS policies and table grants are separate controls. This decision concerns
  policies only. Existing `GRANT` state on these tables is unchanged, and a
  grant alone does not defeat RLS.
- This decision grants no new access, revokes no access, and changes no
  existing privilege. It records the current configuration as intentional.

## Change-Control Requirement

Any future requirement for client, golfer, coach, `anon`, or `authenticated`
access to one of the five accepted tables requires a separately reviewed change
that contains all of the following:

- an explicit access model stating which role reads or writes which rows, and
  under what condition
- a checked-in migration under `supabase/migrations/`
- least-privilege RLS policies scoped to the narrowest command and role that
  satisfy the requirement
- ownership or relationship predicates where applicable, so a row is reachable
  only by its owner or by a party in an established relationship with the owner
- repository tests asserting the migration contract
- staging validation before any production change
- separate, independent production authorization
- advisor verification after application

Policies must never be added merely to silence an INFO finding. An advisor
finding is not a defect on its own, and clearing one is not a valid reason to
widen access.

## Completed Remediation — `public.range_sessions`

`public.range_sessions` was removed from the accepted allowlist. It is not an
accepted finding; it is a resolved one.

- Application code requires authenticated, owner-scoped INSERT and SELECT
  access. `app/(dashboard)/range/actions.ts` inserts a row for the signed-in
  user, and `app/(dashboard)/telemetry/page.tsx` selects that user's rows. Both
  execute under the `authenticated` role.
- Remediation was implemented through merged PR #21.
- Checked-in migration:
  `supabase/migrations/20260804022105_add_range_sessions_owner_policies.sql`
- Production recorded migration version: `20260804022105`
- Production now has exactly two owner-scoped policies on the table, both
  permissive and scoped to `authenticated`: an INSERT policy with an owner-only
  `WITH CHECK`, and a SELECT policy with an owner-only `USING`.
- The `rls_enabled_no_policy` INFO finding for `public.range_sessions` is
  absent from the current advisor output.
- This remediation was driven by a genuine, documented application access
  requirement. It must never be reapplied, imitated, or extended merely to
  silence an advisor result.
- The separate missing index on the `user_id` foreign key remains outside the
  scope of SEC1F-INFO and is not addressed or resolved by this record.

## Out of Scope — SECURITY DEFINER WARN

The remaining WARN advisor finding — authenticated execution of
`public.link_student_to_coach(invite_code text)` as a `SECURITY DEFINER`
function — is outside this acceptance record. It is neither accepted nor
resolved by this document, and it requires its own separately scoped review.

## Monitoring and Revalidation

- The accepted allowlist contains exactly five tables. It is exhaustive.
- A new `rls_enabled_no_policy` finding for any table not on this allowlist is
  **not** automatically accepted by this decision and requires its own review.
- Removing RLS from any accepted table is **not** authorized by this decision.
- Adding a policy to any accepted table requires the change-control process
  described above.
- This decision should be revisited whenever application code needs direct
  authenticated access to one of the five accepted tables.

## Non-Goals

SEC1F-INFO explicitly does **not**:

- create or modify RLS policies
- disable RLS on any table
- grant or revoke table privileges
- change Auth settings
- change any database object, including schemas, tables, columns, indexes,
  triggers, functions, or roles
- change application code
- change production or staging
- suppress, remove, or otherwise hide any advisor finding

This document is a record only. It asserts no change to any system.

## Related Completed Security Work

- **SEC1B** — pinned `search_path` on mutable functions.
- **SEC1C** — removed anonymous execution of
  `public.link_student_to_coach(invite_code text)`.
- **SEC1D** — removed three weak RLS policies that were OR-combining with, and
  neutralizing, their stricter counterparts.
- **SEC1E** — enabled leaked-password protection.
- **SEC1F** — `public.range_sessions` owner-scoped access remediation, merged
  as PR #21 and applied to production as migration version `20260804022105`.
