# Equipment Intelligence & Premium Putting Rollout

Status: **EQ1-S1R implemented locally, source-only, unapplied.** No SQL in
this rollout has been executed against any Supabase project. No UI, API
route, AI prompt, or subscription behavior has changed.

## Existing foundation this work extends

SwingProAI already contains a working putting-analysis foundation. This
slice extends it — it does not build a second or competing system:

- `public.swing_analysis` already has `putt_tempo_ratio`,
  `face_angle_at_impact_deg`, `path_deviation_mm`, `putt_analytics`
  (jsonb), and `putting_analysis` (jsonb).
- `components/putting/PuttingAnalysisPanel.tsx` already renders putting
  results.
- The AI backend already supports `swing_category = putt` requests and a
  putting analytics response schema.

EQ1-S1R adds the *routing* and *equipment identity* layer around that
existing capability: a validated club selection now determines, at the
database level, which analysis family an upload belongs to, and preserves a
durable record of the equipment used.

## Critical naming distinction

Two independent concepts, both real, never conflated:

```text
analysis_mode      = AI depth / subscription-driven model routing
                      (basic | advanced | ultra) — already live on
                      swing_videos and swing_analysis. Unchanged by this
                      slice.

analysis_family     = the mechanical analysis pipeline selected from the
                      validated club (full_swing | putting) — new in this
                      slice, on swing_analysis only.
```

A single upload has both a depth (`analysis_mode`) and, once a club is
validated, a family (`analysis_family`). They vary independently: an
`ultra`-depth request can be either family; a `putting`-family request can
be requested at any depth.

## Automatic routing (server-authoritative)

```text
Validated selected Putter
  → analysis_family = putting
  → future AI swing_category = putt

Validated non-putter (Driver, Wood, Hybrid, Iron, Wedge)
  → analysis_family = full_swing
```

The client is never trusted to choose or override `analysis_family`. It is
derived and written exclusively by a database trigger from the validated
`club_type` of the referenced `user_equipment` row. Chip/pitch/bunker
specialization within the non-putting family remains a later extension —
explicitly out of scope for this slice.

## Premium putting experience (future product contract — not enforced here)

This section documents the intended tiered experience. **No tier is
enforced or changed by this slice.**

### Par

- Putter selection
- Putting-specific capture guidance
- Basic setup and tempo summary
- Limited result depth
- Limited history
- Premium metric previews (locked, shown as an upsell)

### Birdie

- Complete putting mechanics analysis
- Face-angle findings
- Path deviation
- Tempo ratio
- Stroke symmetry
- Setup and alignment analysis
- Stability observations
- Personalized putting drills
- Putter-specific history
- Longitudinal progress

### Eagle

- Everything in Birdie
- Multi-putt consistency
- Distance-control patterns
- Deeper confidence scoring
- Putter-model correlation
- Equipment-change comparisons
- Advanced trend analysis
- Priority model routing
- Coach-ready reporting
- Future smart-mat or launch-monitor fusion

## Advertising firewall (permanent policy)

- Sponsorship can never affect AI scores.
- Sponsorship can never affect diagnosis.
- Sponsorship can never affect drill selection.
- Sponsorship can never affect equipment-fit conclusions.
- Sponsored placements must be clearly labeled as sponsored.
- Organic analytical results must be computed before any commercial content
  is selected or displayed.
- Manufacturer catalog access (read-only, identity vocabulary only) does not
  grant any manufacturer influence over an individual golfer's
  recommendations.

## Privacy

- No sale of identifiable individual swing data.
- Future manufacturer analytics must be aggregated, never per-golfer.
- Small cohorts must be suppressed (minimum-cohort-size thresholds) before
  any aggregate is surfaced.
- User consent requirements must be explicitly defined before any
  manufacturer-analytics activation (EQ6/EQ7).
- `equipment_snapshot` excludes user ID, email, display name, freeform
  notes, video URL, storage path, Stripe data, subscription ID, IP data,
  location data, and advertising identifiers — see schema below.
- Deletion and retention policy work for equipment/snapshot data remains
  future scope, not decided by this slice.

## Equipment-manufacturer vocabulary seeded in this slice

Identity only — no model data, no advertising data, no sponsorship data, no
tracking or affiliate URLs, no marketing copy, no rankings, no paid
placement fields:

| canonical_name | slug         | normalized_name |
|-----------------|--------------|------------------|
| TaylorMade      | taylormade   | taylormade       |
| Callaway        | callaway     | callaway         |
| Titleist        | titleist     | titleist         |
| PING            | ping         | ping             |
| Mizuno          | mizuno       | mizuno           |

## Equipment snapshot (schema_version 1)

Written exclusively by a database trigger on `swing_analysis` insert;
client-supplied values for `analysis_family` and `equipment_snapshot` are
always ignored and overwritten. Immutable after insert (a separate trigger
rejects any later change to `club_id`, `analysis_family`, or
`equipment_snapshot`).

```json
{
  "schema_version": 1,
  "captured_at": "2026-07-25T02:08:35Z",
  "equipment_id": "…",
  "club_type": "Putter",
  "manufacturer": { "id": "…", "canonical_name": "PING", "slug": "ping" },
  "model": { "id": "…", "canonical_name": "…", "slug": "…", "model_year": 2024 },
  "entered_brand": "…",
  "entered_model": "…",
  "custom_club": false,
  "custom_brand": null,
  "custom_model": null,
  "shaft_flex": "…",
  "shaft_weight_grams": 60,
  "loft_deg": 4.0
}
```

`manufacturer` and `model` are `null` when the equipment row has no catalog
reference — the snapshot never fabricates or guesses one. The snapshot
remains useful and legible after the golfer later edits or deletes the live
`user_equipment` row, because it is a frozen copy, not a live join.
`swing_analysis.club_id` keeps its existing `ON DELETE SET NULL` behavior in
this slice — durable equipment identity is preserved through the snapshot
even though the foreign key itself is not made restrictive here; any future
change to that deletion semantic is a separately authorized decision.

## Existing RLS/policy posture (documented, not changed in this slice)

`public.user_equipment` and `public.swing_analysis` currently use `PUBLIC`
(unscoped) policies with a plain `auth.uid() = user_id` check — not the
`(select auth.uid())` performance pattern and not explicitly scoped
`TO authenticated`. This slice leaves both tables' existing policies
completely untouched. Modernizing them (explicit `TO` clauses, cached
`auth.uid()`) is deferred to a separately authorized security slice.

The two new catalog tables (`equipment_manufacturers`, `equipment_models`)
are built with the modern pattern from day one: RLS enabled, a single
`SELECT … TO authenticated USING (is_active)` policy each, `REVOKE ALL FROM
PUBLIC` and `anon`, explicit `GRANT SELECT TO authenticated`, and explicit
`service_role` access for trusted server-side writes.

## Rollout roadmap

```text
EQ1-S1R   Schema, manufacturer vocabulary, catalog tables, equipment
          snapshots, analysis_family, secure trigger contracts, types,
          tests, and documentation                          [this slice]

EQ1-S2    Curated manufacturer/model catalog import, including putter
          metadata

EQ1-S3    Apply and validate the migration in an isolated Supabase staging
          branch/project

EQ1-S4    Separately authorized production migration

EQ2       Shared server-backed ClubSelector and canonical equipment queries

EQ3       Desktop Analyze club selector and putting-mode page transformation

EQ4       Mobile recording selector and putting camera guidance

EQ5A      Server analysis router using validated analysis_family

EQ5B      Putting-specific AI prompt, response validation, and persistence

EQ5C      Premium putting result cards and history

EQ5D      Putting-specific drill recommendation engine

EQ6       Consent, retention, aggregation, and manufacturer analytics
          foundation

EQ7       Privacy-safe manufacturer dashboards

EQ8       Clearly labeled sponsored placements with analytical firewall
```
