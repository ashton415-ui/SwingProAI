# Equipment Intelligence & Premium Putting Rollout

## Status

**Repository status:** EQ1-S1R merged into `main` (PR #13). EQ1-S2 is retained
as a generator-owned canonical migration artifact. EQ Slice 2 adds a third
generator-owned artifact family for non-putter coverage (see *EQ Slice 2* below).
All three migration files remain the canonical reproducible source artifacts for
this schema and its catalog data.

**Production verified state:** an authorized read-only inspection in August 2026
confirmed that the corresponding schema, catalog data, triggers, functions, and
constraints are present in production. That inspection establishes present state
only; it does not establish when or by what mechanism the schema was applied.

**Staging application status: not verified.** This concerns the earlier EQ1-S1R
schema foundation and EQ1-S2 putter catalog only. No inspection has established
when, by what mechanism, or by whom that earlier staging schema and putter
catalog data were applied, and this document asserts no staging rollout for
them. It does not describe the later EQ Slice-2 non-putter application, whose
verified deployment is recorded separately below.

**Staging observed state:** separately from the above, a read-only inspection on
2026-08-20 observed the 21-row putter canonical catalog and its supporting
foundation present in the `swingproai-eq1-s3-staging` project, and observed the
relevant catalog schema signatures (columns, constraints, indexes, policies,
`club_type_enum`) matching production. That is a present-state observation only;
it is not evidence of an application event, which is why the line above still
stands.

**EQ Slice-2 non-putter deployment status: applied and independently verified.**
The logical migration `equipment_non_putter_catalog_v1` was applied to staging
(Supabase-assigned version `20260823035942`) and to production (Supabase-assigned
version `20260823042455`). Application and independent verification passed in
both environments. The canonical repository artifact keeps its own filename
timestamp `20260820132900`; database-assigned versions are allocated per
environment at application time and need not equal it or each other. This was a
database/catalog deployment only.

**Application/UI status:** catalog-backed equipment selection is not yet wired
into the active application. No active Analyze club-selection flow currently
consumes the canonical catalog, and no UI, API route, AI prompt, or subscription
behavior has changed.

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

## EQ1-S2 — Curated putter catalog v1

EQ1-S2 adds 21 officially verified, currently marketed putter configurations
across all five existing parent manufacturers (taylormade 5, callaway 3,
titleist 7, ping 2, mizuno 4) and the schema needed to describe them
factually. **No active Analyze club-selection flow currently consumes the
canonical catalog.** See the Status section above for repository,
production-verified, and staging status.

### Configuration-level identity, not family-level rows

A catalog row represents one purchasable configuration — the lowest
officially named or selectable neck/shaft variant needed to produce one
unambiguous `head_shape`/neck-label/toe-hang/handedness/length record — never
a generic family-level row collapsing multiple materially distinct official
configurations into one. Where an official source exposes separately named
configurations (e.g. TaylorMade Spider Tour's Small Slant and Double Bend
hosels, or Mizuno M.Craft's `.P`/`.S`/`.B` suffixes), each receives its own
catalog key, deterministic UUID, canonical name, slug, specs row, and source
row. A prior implementation draft collapsed several of these into generic
family rows (e.g. a single "Spider Tour" row); those generic rows have been
removed and replaced with their exact named configurations.

### Global slug uniqueness

`public.equipment_models.slug` carries an exact database constraint,
`equipment_models_slug_unique`, in addition to (not replacing) the existing
`equipment_models_manufacturer_type_name_year_uidx` compound identity index.
Both rules are enforced by PostgreSQL, not only by the generator.

### snake_case TypeScript database-row convention

The new `EquipmentModel` fields (`catalog_key`, `brand_line`,
`brand_line_slug`, `model_family`, `model_family_slug`, `release_year`,
`putter_specs`) follow the interface's established database-row naming
convention, matching `manufacturer_id`, `canonical_name`, `model_year`, and
every other existing field on that interface — not a second camelCase shape.

### Brand-line identity, not additional manufacturers

Consumer-facing sub-brands are represented with new nullable
`brand_line`/`brand_line_slug` columns on `equipment_models`, never as
additional parent-manufacturer rows:

```text
manufacturer: Callaway   brand_line: Odyssey
manufacturer: Titleist   brand_line: Scotty Cameron
```

The five parent manufacturers seeded in EQ1-S1R remain unchanged and are not
duplicated.

### Two new tables

- `public.equipment_putter_model_specs` — one row per putter model
  (`equipment_model_id` primary key, FK `ON DELETE CASCADE`), holding
  `head_shape` (required) plus nullable `neck_type`, `neck_source_label`,
  `toe_hang_class`, `face_construction`, `handedness`, and
  `standard_lengths_inches`, each drawn from a fixed, database-enforced
  vocabulary. A database trigger rejects a specs row for any model whose
  `club_type` is not `Putter`. Authenticated users may `SELECT` a row only
  when the joined model is `is_active`; there is no browser write path.
- `public.equipment_model_sources` — provenance only (`source_type`,
  `source_name`, HTTPS-only `source_url`, `verified_at`), FK `ON DELETE
  CASCADE`. **Isolated from `equipment_models`, and never browser-readable —
  `authenticated` has no grant and no RLS policy on this table at all.** Only
  `service_role` can read or write it.

No alias table was created in this slice — alias matching has no current
consumer and is deferred until a concrete search or reconciliation
requirement exists.

### No user backfill

EQ1-S2 performs zero updates to `public.user_equipment`,
`public.swing_analysis`, `public.user_bags`, or `public.user_clubs`. No model
matching, manufacturer matching, alias matching, fuzzy matching, or
candidate-report generation is included.

### Deterministic, immutable identity

Every model carries an immutable `catalog_key` (e.g.
`callaway/odyssey/ai-one-2-ball-ch/v1`). Model and source UUIDs are
RFC-4122 UUIDv5 values deterministically derived from that key under a fixed
SwingProAI namespace (`05690d1f-f17d-5ab8-a2b6-ef0328a2783a`), computed by
`scripts/generate-equipment-catalog-putters-v1.mjs` from
`data/equipment-catalog-putters-v1.json` — never inside PostgreSQL, and never
from mutable display names, slugs, or years. Correcting a display name, slug,
or metadata field never changes a model's identity.

### Provenance and completeness policy

Every seeded model has at least one `equipment_model_sources` row citing an
exact official manufacturer product page, verified 2026-07-25. Optional
fitting fields (`neck_type`, `toe_hang_class`, `face_construction`,
`handedness`, `standard_lengths_inches`) remain `null` whenever the official
source does not state them unambiguously — they are never inferred or filled
merely to claim completeness. Raw numeric toe-hang degrees (e.g. "29°",
"90° Up") are never mapped into the qualitative `toe_hang_class` vocabulary
without an explicit qualitative label on the source page itself.

Of the 21 source rows: 17 cite an exact individual product page (one per
model — TaylorMade 5, Odyssey 3, Scotty Cameron 7, PING 2); the remaining 4
(all Mizuno) cite the single official M.Craft family/product page at
`mizunogolf.com/us/golf-clubs/m-craft-putters/`, which is explicitly permitted
because it contains the complete factual specification table for each
retained Mizuno configuration individually — unlike a bare marketing family
listing page. No other manufacturer's records may rely on a family-only page.

**Search-result snippets are discovery aids only, never catalog evidence.**
A search index may help locate the correct official URL, but every retained
factual field must be verified from directly fetched or rendered content of
that exact official page. Three Odyssey records in an earlier working draft
of this catalog cited a family page and search-derived summaries rather than
individually fetched product pages; they were replaced with three
directly-verified Ai-ONE configurations (`ai-one-2-ball-ch`,
`ai-one-rossie-db`, `ai-one-square-2-square-7-center-shaft`) once exact
official product-page content was independently obtained.

An HTML specification page is never labeled `official_spec_pdf` — that
source type is reserved for an actual PDF document (URL pathname ending in
`.pdf`). The v1 catalog contains zero `official_spec_pdf` entries; the
Mizuno specification table is classified `official_product_page`.

### Unchanged from EQ1-S1R

`equipment_snapshot.schema_version` remains `1`. Neither
`apply_swing_analysis_equipment_snapshot()` nor
`guard_swing_analysis_equipment_immutability()` was modified. Putter catalog
specifications are live catalog metadata, joined at read time — they are not
copied into historical analysis snapshots in this slice. `analysis_mode` and
`analysis_family` semantics are unchanged.

### Out of scope for this slice

No UI, no AI routing, no subscription enforcement, no fitting conclusions, no
advertising influence, and no Supabase migration application (staging or
production) occurred in EQ1-S2. `public.user_bags` and `public.user_clubs`
remain legacy, unreferenced tables and were not touched.

## EQ Slice 2 — non-putter canonical catalog v1

A third generator-owned artifact family, additive to the closed EQ1-S2 putter
set. The migration file remains the canonical reproducible source artifact,
regenerable from its data JSON by its generator.

**This migration has been applied and independently verified in both staging and
production.** The deployed shared catalog holds 6 manufacturers, 51 models
(21 Putters, 30 non-Putters) and 51 provenance rows. No user-equipment backfill
occurred: production's 8 pre-existing `user_equipment` rows remain present and
unlinked to any canonical model. Consumer migration remains separate future
work.

### Scope

Six parent manufacturers — TaylorMade, Callaway, Titleist, PING and Mizuno
(incumbent) plus **Cobra** (added by this slice) — across the five non-putter
club types (Driver, Wood, Hybrid, Iron, Wedge). Exactly **30 curated models**:
one per manufacturer × club-type cell, the minimum valid catalog under a
coverage rule of 1–4 rows per cell and a hard 90-row ceiling. No Putter row is
added and no existing putter row is touched.

Each model carries exactly one official provenance row, so the migration inserts
1 manufacturer + 30 models + 30 sources. It is data-only, transactional,
append-only and fail-loud: no schema object, no `UPDATE`, no `DELETE`, no
`user_equipment` backfill, no fuzzy matching against legacy free-text brand or
model strings. Consumer migration (My Bag, Analyze, Telemetry) is not part of
this slice.

Loft, shaft flex, shaft weight, club number and retail SKU remain per-golfer
customization on `public.user_equipment`. They are never canonical model
identity and appear nowhere in the catalog data.

### Manufacturer identity nuance

The five incumbent manufacturer rows were seeded in EQ1-S1R without explicit
ids, under the table's `gen_random_uuid()` default. Their ids are therefore
**not** deterministic and are not treated as stable cross-environment identity;
they are never rewritten. Cobra, being new, receives a deterministic
`uuidv5(namespace, "manufacturer:cobra")` identity. To keep that asymmetry out
of the model rows entirely, every model — Cobra's included — resolves its parent
by canonical slug rather than by a hard-coded id.

### Provenance recovery

Twenty of the thirty rows were verified directly against official manufacturer
product pages. The ten TaylorMade and Titleist rows could not be retrieved by
the client used in the first implementation attempt, which received anti-bot
challenge and access-control responses rather than page content; that attempt
was blocked rather than completed from weaker evidence. A separately gated
recovery round resolved all ten: nine through a separate assistant's ordinary
automated product-page retrieval, and the TaylorMade driver through an official
TaylorMade specification PDF. No CAPTCHA or anti-bot control was bypassed at any
point, and no retailer, review site, search snippet or legacy static-catalog
entry was ever accepted as provenance.

Verifier channel is deliberately **not** encoded into catalog data: an
`equipment_model_sources` row records what the source is, not who observed it.

## Rollout roadmap

```text
EQ1-S1R   Schema, manufacturer vocabulary, catalog tables, equipment
          snapshots, analysis_family, secure trigger contracts, types,
          tests, and documentation                    [merged, PR #13]

EQ1-S2    Curated putter-model catalog v1: brand-line identity, putter
          fitting metadata, isolated provenance, deterministic catalog
          keys and UUIDs                      [merged, generator-owned]

EQ1-S3    Apply and validate the migration in an isolated Supabase staging
          branch/project

EQ1-S4    Separately authorized production migration

EQ-S2     Non-putter canonical catalog v1: six manufacturers, 30 curated
          Driver/Wood/Hybrid/Iron/Wedge models, one official source each,
          append-only data migration   [deployed + independently verified]

EQ-S2-A   Staging application of the non-putter catalog migration — staging
          preceded production        [applied + verified, 20260823035942]

EQ-S2-B   Production application of the non-putter catalog migration
                                     [applied + verified, 20260823042455]

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
