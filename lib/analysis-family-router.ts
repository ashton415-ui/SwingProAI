/**
 * EQ5A — server analysis router.
 *
 * Classifies the DATABASE-AUTHORED analysis family of an already-fetched,
 * authenticated user-owned swing_analysis row into the one execution route the
 * server may take. It is deliberately pure: it receives a single persisted
 * value and returns a decision. It never sees the request body, presentation
 * state, the golfer's equipment, their tier, or Supabase.
 *
 * public.swing_analysis.analysis_family is written only by
 * apply_swing_analysis_equipment_snapshot() on INSERT and is immutable
 * afterwards, so the value classified here cannot originate from the client.
 */

export type AnalysisFamilyRoute =
  | "full_swing_pipeline"
  | "putting_pipeline"
  | "unsupported_family";

/**
 * The input is `unknown` on purpose. The value reaches this function through an
 * untyped row projection, so the declared column type is an expectation rather
 * than a guarantee; this is the boundary where that expectation is checked
 * instead of assumed.
 *
 * A literal null and a missing value are NOT interchangeable here:
 *
 *   literal null   the database deliberately recorded "no club selected". The
 *                  snapshot producer nulls the family whenever club_id is null,
 *                  and the equipment-context constraint permits that exact
 *                  all-null row. It is the shipping no-club capability, so it
 *                  takes the full-swing route.
 *
 *   missing value  the expected field was absent from the runtime row shape.
 *                  That proves nothing about the golfer's equipment, so it
 *                  fails closed rather than entering full-swing analysis on an
 *                  assumption.
 *
 * Every comparison below is strict for that reason. A loose-equality or
 * falsy-value test would treat the two cases alike and silently reinstate the
 * assumption this router exists to remove.
 */
export function classifyAnalysisFamilyRoute(
  value: unknown,
): AnalysisFamilyRoute {
  if (value === "full_swing" || value === null) {
    return "full_swing_pipeline";
  }

  if (value === "putting") {
    return "putting_pipeline";
  }

  return "unsupported_family";
}
