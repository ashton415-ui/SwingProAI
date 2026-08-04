# Supabase Security: Accepted RLS No-Policy Findings

## Status

- Status: Accepted
- Gate: SEC1F-INFO
- Production project ref: atlmnqispyzhsahahpjy
- Effective date: 2026-08-03
- Review trigger: any proposed client-side or authenticated-user access to one
  of the listed tables

## Decision

The six Supabase security-advisor `rls_enabled_no_policy` INFO findings listed
in the allowlist below are intentionally accepted.

Every listed table has row level security enabled and exactly zero RLS policies.
In PostgreSQL, a table with RLS enabled and no policy matches no rows for the
roles that RLS applies to. The practical effect for this project is a
deny-by-default posture for normal Supabase Data API access: requests made with
the `anon` or `authenticated` roles receive no row access through an RLS policy,
for select, insert, update, or delete.

These six advisor findings are expected to remain visible indefinitely. They are
informational, they describe the configuration accurately, and the configuration
is the intended one. No change will be made for the purpose of clearing them
from the advisor output.

## Accepted Table Allowlist

| Table | RLS Enabled | Policy Count | Intended Access Posture | Reason for Acceptance |
| --- | --- | --- | --- | --- |
| `public.drill_submissions` | Yes | 0 | Deny by default | No approved direct client-access requirement is currently documented. |
| `public.equipment_model_sources` | Yes | 0 | Deny by default | Holds catalog-provenance and source-attribution data intended for trusted administrative or service operations. No approved direct client-access requirement is currently documented. |
| `public.range_sessions` | Yes | 0 | Deny by default | No approved direct client-access requirement is currently documented. See the repository-evidence note below. |
| `public.swing_breakdowns` | Yes | 0 | Deny by default | No approved direct client-access requirement is currently documented. |
| `public.swing_faults` | Yes | 0 | Deny by default | No approved direct client-access requirement is currently documented. |
| `public.swing_strengths` | Yes | 0 | Deny by default | No approved direct client-access requirement is currently documented. |

### Repository-evidence note

This subsection records verifiable references found in the repository at the
time of this decision. It records evidence only. It does not approve access, and
it does not describe an agreed business workflow.

- `public.range_sessions` is referenced by application code that runs as the
  signed-in user rather than as a privileged role:
  - `app/(dashboard)/range/actions.ts` performs an insert into
    `range_sessions`.
  - `app/(dashboard)/telemetry/page.tsx` performs a select from
    `range_sessions`.
  - Both obtain their client from `utils/supabase/server.ts`, which builds a
    Supabase client from the caller's session, so those statements execute under
    the `authenticated` role and are subject to RLS.
  - Because `range_sessions` has RLS enabled and zero policies, those statements
    are denied or return no rows. The deny-by-default posture recorded here and
    that application code are therefore inconsistent with each other today.
  - This inconsistency is recorded, not resolved. Resolving it requires the
    change-control process below. It must not be resolved by adding a policy
    without that review.
- `public.equipment_model_sources` is referenced by
  `scripts/generate-equipment-catalog-putters-v1.mjs` and by generated types in
  `types/database.ts`.
- The remaining four tables appear in migration and test fixtures only, and are
  not referenced by application request paths found in this repository.

## Security Meaning

The following boundaries define what this decision does and does not assert.

- RLS enabled with zero policies means no row is exposed to the `anon` or
  `authenticated` Data API roles **through an RLS policy**.
- This is materially different from disabling RLS. Disabling RLS would remove
  row filtering entirely and expose rows subject only to table grants. RLS
  remains enabled on all six tables.
- This does **not** mean every PostgreSQL role is denied. The claim is scoped to
  policy-mediated access.
- Table owners, roles holding `BYPASSRLS`, other privileged administrative
  roles, and Supabase service-role operations may bypass RLS according to their
  own privileges. Access through those paths is unaffected by this decision.
- RLS policies and table grants are separate mechanisms. This decision concerns
  policies only. Existing `GRANT` state on these tables is unchanged, and a
  grant alone does not defeat RLS.
- This decision grants no access, revokes no access, and changes no existing
  privilege. It records the current configuration as intentional.

## Change-Control Requirement

Any future requirement for client, golfer, coach, `anon`, or `authenticated`
access to a table on this allowlist requires a separately reviewed change that
contains all of the following:

- an explicit access model stating which role reads or writes which rows, and
  under what condition
- a checked-in migration under `supabase/migrations/`
- least-privilege RLS policies scoped to the narrowest command and role that
  satisfy the requirement
- ownership or relationship predicates where applicable, so a row is reachable
  only by its owner or by a party in an established relationship with the owner
- repository tests asserting the migration contract
- staging validation before any production change
- independent production authorization
- advisor verification after application

Policies must never be added merely to silence an INFO finding. An advisor
finding is not a defect on its own, and clearing one is not a valid reason to
widen access.

## Monitoring and Revalidation

- The accepted allowlist contains exactly six tables. It is exhaustive.
- A new `rls_enabled_no_policy` finding for any table not on this allowlist is
  **not** automatically accepted by this decision and requires its own review.
- Removing RLS from any listed table is **not** authorized by this decision.
- Adding a policy to any listed table requires the security review described
  above.
- This decision should be revisited whenever application code needs direct
  access to any listed table. The `range_sessions` references recorded above
  mean that trigger is already met for that table, and it should be reviewed on
  its own merits.

## Non-Goals

SEC1F-INFO explicitly does **not**:

- create RLS policies
- disable RLS on any table
- grant or revoke table privileges
- change Auth settings
- change any database object, including schemas, tables, columns, indexes,
  triggers, functions, or roles
- change application code
- change production or staging
- suppress, remove, or otherwise hide the six advisor INFO findings

## Related Completed Security Work

- **SEC1B** — pinned `search_path` on mutable functions.
- **SEC1C** — removed anonymous execution of
  `public.link_student_to_coach(invite_code text)`.
- **SEC1D** — removed three weak RLS policies that were OR-combining with, and
  neutralizing, their stricter counterparts.
- **SEC1E** — enabled leaked-password protection.
