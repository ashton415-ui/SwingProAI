// ENT-1D — the PREVIOUS application's exact swing_analysis write shapes
// (git HEAD 168bd88, app/api/analyze-swing/route.ts), issued through
// supabase-js with the same service-role writer the old route used. Each one
// reports the rows it moved or the database's refusal, so a suite can assert
// either. Used to show what the execution claim guard admits and refuses.

import { admin } from "./ent1d-fixtures";

export type LegacyResult =
  | { readonly kind: "rows"; readonly rows: number }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

async function run(query: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<LegacyResult> {
  const { data, error } = await query;
  if (error) return { kind: "refused", code: String(error.code ?? ""), message: String(error.message ?? "") };
  return { kind: "rows", rows: Array.isArray(data) ? data.length : -1 };
}

const table = () => admin.from("swing_analysis");

/** Full-swing claim, HEAD :898-905. Status only. */
export const legacyFullSwingClaim = (id: string, userId: string) =>
  run(table().update({ status: "processing" }).eq("id", id).eq("user_id", userId)
    .or("analysis_family.is.null,analysis_family.eq.full_swing").in("status", ["pending", "failed"]).select("id"));

/** Putting "processing" write, HEAD :562-566. No status filter. */
export const legacyPuttingProcessing = (id: string, userId: string) =>
  run(table().update({ status: "processing" }).eq("id", id).eq("user_id", userId).select("id"));

/** Full-swing completion, HEAD :1222-1227. */
export const legacyFullSwingComplete = (id: string, userId: string) =>
  run(table().update({ status: "complete", score: 70, feedback: "old app result", metrics: { drills: [] }, swing_highlights: [], mechanical_deficiencies: [] })
    .eq("id", id).eq("user_id", userId).eq("status", "processing").select());

/** Full-swing failure, HEAD :508-513. */
export const legacyFullSwingFail = (id: string, userId: string) =>
  run(table().update({ status: "failed" }).eq("id", id).eq("status", "processing").eq("user_id", userId).select("id"));

const PUTT_SCORE = { basis: "qualitative_classification_index", coverage: { percent: 100, scorable_sections: 6, total_sections: 6 }, score: 80, score_version: 1, source_classification_version: 1 };

/** Putting completion, HEAD :679-690. No status filter. */
export const legacyPuttingComplete = (id: string, userId: string) =>
  run(table().update({ status: "complete", putting_analysis: { note: "old app putt" }, putting_score: PUTT_SCORE })
    .eq("id", id).eq("user_id", userId).eq("analysis_family", "putting").is("putting_score", null).select());

/** Putting failure, HEAD :540-545. No status and no claim filter. */
export const legacyPuttingFail = (id: string, userId: string) =>
  run(table().update({ status: "failed" }).eq("id", id).eq("user_id", userId).select("id"));

// ── The MAIN-LINE route (main 7ad1238, the build most likely serving today) ──
// Its full-swing writes filter on neither status nor claim, and on a refused
// processing write it logs and calls the provider anyway (main route.ts
// :829-844). Its completion and failure writes are equally unfiltered
// (:1144-1148, :1166-1168). Its putting path matches HEAD 168bd88's.

/** Full-swing "Mark as processing", main :832-836. No status filter; errors are ignored. */
export const mainFullSwingProcessing = (id: string, userId: string) =>
  run(table().update({ status: "processing" }).eq("id", id).eq("user_id", userId).select("id"));

/** Full-swing completion, main :1144-1148. No status or claim filter. */
export const mainFullSwingComplete = (id: string, userId: string) =>
  run(table().update({ status: "complete", score: 66, feedback: "main-line result", metrics: { drills: [] }, swing_highlights: [], mechanical_deficiencies: [] })
    .eq("id", id).eq("user_id", userId).select());

/** Full-swing failure, main :1166-1168. No status or claim filter. */
export const mainFullSwingFail = (id: string, userId: string) =>
  run(table().update({ status: "failed" }).eq("id", id).eq("user_id", userId).select("id"));
