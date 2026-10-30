import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import type { AuthenticatedCaller } from "@/utils/supabase/server";
import {
  accessOf,
  resolveAnalysisAccess,
  type AnalysisAccess,
} from "@/lib/analysis-entitlement-authority";
import {
  isPersistedPuttingAnalysisV1,
  type PersistedPuttingAnalysisV1,
} from "@/lib/putting-analysis-contract";
import { isPersistedPuttingScoreV1 } from "@/lib/putting-score-presentation-eq5f-f";
import {
  FULL_SWING_METRIC_KEYS,
  isAngleEstimate,
  isTempoEstimate,
  readMetricEvidence,
  type FullSwingMetricKey,
} from "@/lib/full-swing-analysis-contract";

/**
 * SwingProAI — unified analysis-result read authority (ENT-1C).
 *
 * The shared application boundary for reading a stored analysis result, for
 * the web pages, the analysis API and the native v1 API alike. Every reader
 * gets the same answer from the same four steps:
 *
 *   1. ownership — the caller's own session reads the identity columns, with
 *      RLS and an explicit user_id filter. Another golfer's analysis, and a
 *      missing one, are the same answer. No relationship other than ownership
 *      grants a read today; a coach is not an owner.
 *   2. entitlement — the caller's own users row (analysis-entitlement-authority).
 *   3. payload — the jsonb result columns are read by the server-only writer,
 *      bounded by the analysis id AND the user id ownership has just proved.
 *      The elevated client decides nothing; it fetches what step 1 already
 *      established the caller owns. (ENT-1D will make these columns unreadable
 *      to browser roles, so this is also the only path that will keep working.)
 *   4. serialization — an explicit allow-list per field, nested fields
 *      included. Anything not named below never reaches a response, a prop or
 *      rendered HTML; a raw row is never returned.
 *
 * Classification of the stored payload (ENT-1C product rulings):
 *
 *   core, every legitimate account (FREE included, kept after a downgrade):
 *     score, feedback, swing estimates (full_swing_metrics: each value with its
 *     source, S6-R1), swing_highlights, mechanical_deficiencies,
 *     and the named metrics keys below — scoring breakdown, evidence limits, fault tags,
 *     foundational drills, posture / swing-plane / impact notes, practice
 *     focus, pro cue and feel. The current producer writes all of these
 *     identically for every tier, so none of it is an advanced or ultra-deep
 *     result, and it was available to every golfer before.
 *   putting (existing tier-only contract): putting_analysis, putting_score,
 *     each only when the stored envelope passes its strict v1 validator.
 *   withheld (no producer, consumer or contract): putt_analytics,
 *     launch_monitor_summary, fusion_notes, ai_equipment_recommendations.
 *     They are not read at all.
 *
 * Fail closed: an unreadable ownership read or payload read is `unavailable`;
 * an unresolved entitlement serves core feedback with nothing premium.
 */

/**
 * Columns a caller's own session may read. They identify the analysis and
 * carry its core scalar summary; ENT-1D's column grant should match this list.
 */
export const ANALYSIS_OWNER_COLUMNS =
  "id, swing_video_id, user_id, club_id, status, analysis_family, equipment_snapshot, analysis_mode, created_at, " +
  "score, feedback, tempo_ratio, swing_speed_mph, spine_angle, hip_rotation, shoulder_rotation";

/** The result payload, read only by the server after ownership is proved. */
export const ANALYSIS_PAYLOAD_COLUMNS =
  "id, user_id, metrics, swing_highlights, mechanical_deficiencies, putting_analysis, putting_score";

// ─── Result shape ─────────────────────────────────────────────────────────────

/**
 * S6-R1A. checkpoint, joint and severity are null when not assessed. The only
 * producer (app/api/analyze-swing/route.ts) has never assessed a checkpoint or
 * a joint position: since its first version it wrote checkpoint "impact" and
 * x/y 0.5 for every item, and since e2b1dda severity "minor" with joint
 * "general". Those exact constants are read as "not assessed"; anything else a
 * row carries is kept as stored.
 */
export interface AnalysisHighlight {
  readonly checkpoint: string | null;
  readonly positive_movement: string;
  readonly mechanical_benefit: string;
}

export interface AnalysisDeficiency {
  readonly checkpoint: string | null;
  /** A named joint or area when one was recorded; positions are never served (never assessed). */
  readonly joint_coordinate: { readonly joint: string } | string | null;
  readonly fault_description: string;
  readonly severity: "minor" | "major" | null;
  /**
   * Named for a drill, but the current producer writes the fault's explanation
   * here and leaves the title empty. Classified as core improvement-area text.
   */
  readonly corrective_drill_title: string;
  readonly corrective_drill_detail: string | null;
}

export interface AnalysisPillar {
  readonly rating: string;
  readonly observation: string;
  readonly correction: string;
}

export interface AnalysisDrill {
  readonly name: string;
  readonly the_why: string;
  readonly the_how: string;
  readonly the_feel: string;
}

/** The core metrics keys. Every other key in the stored jsonb is dropped. */
export interface AnalysisCoreMetrics {
  scoring_breakdown?: string;
  /** S6-R1: what the video did not let the model judge. */
  evidence_limits?: string;
  spine_angle?: number;
  hip_rotation?: number;
  shoulder_rotation?: number;
  spine_angle_deg?: number;
  hip_rotation_deg?: number;
  shoulder_rotation_deg?: number;
  tempo_ratio?: string;
  fault_tags?: string[];
  suggestions?: string[];
  drills?: AnalysisDrill[];
  posture?: AnalysisPillar | null;
  swing_plane?: AnalysisPillar | null;
  impact?: AnalysisPillar | null;
  practice_focus?: string;
  pro_cue?: string;
  the_feel?: string;
  /** Legacy free-text note some early full-swing rows carry; shown in history. */
  putting_analysis?: string;
}

/**
 * One analysis as the caller may receive it. Row-compatible field names, so
 * the existing web consumers keep working; built only by
 * serializeAnalysisResult.
 */
export interface AnalysisResultView {
  readonly id: string;
  readonly swing_video_id: string | null;
  readonly user_id: string;
  readonly club_id: string | null;
  readonly status: string;
  readonly analysis_family: "full_swing" | "putting" | null;
  readonly equipment_snapshot: unknown;
  readonly analysis_mode: string | null;
  readonly created_at: string | null;
  readonly score: number | null;
  readonly feedback: string | null;
  readonly tempo_ratio: number | null;
  readonly swing_speed_mph: number | null;
  readonly spine_angle: number | null;
  readonly hip_rotation: number | null;
  readonly shoulder_rotation: number | null;
  /**
   * S6-R1. The four full-swing estimates, each with the source it was stored
   * under; null for a putt. The surfaces present these, never the raw columns.
   */
  readonly full_swing_metrics: FullSwingMetricsView | null;
  readonly metrics: AnalysisCoreMetrics | null;
  readonly swing_highlights: AnalysisHighlight[];
  readonly mechanical_deficiencies: AnalysisDeficiency[];
  readonly putting_analysis: PersistedPuttingAnalysisV1 | null;
  readonly putting_score: Record<string, unknown> | null;
}

// ─── Field sanitizers ─────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const strList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

/** The producer's constant checkpoint: never an assessment (see AnalysisHighlight). */
const PLACEHOLDER_CHECKPOINT = "impact";

/** A stored checkpoint, or null when absent, empty or the producer's constant. */
function assessedCheckpoint(value: unknown): string | null {
  const checkpoint = str(value);
  return checkpoint && checkpoint !== PLACEHOLDER_CHECKPOINT ? checkpoint : null;
}

export function sanitizeHighlights(value: unknown): AnalysisHighlight[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      checkpoint: assessedCheckpoint(item.checkpoint),
      positive_movement: str(item.positive_movement) ?? "",
      mechanical_benefit: str(item.mechanical_benefit) ?? "",
    }];
  });
}

/** The producer's constant joint name since e2b1dda: never an assessment. */
const PLACEHOLDER_JOINT = "general";

/** A named joint or area, or null. Coordinates are dropped: none was ever assessed. */
function sanitizeJoint(value: unknown): AnalysisDeficiency["joint_coordinate"] {
  if (typeof value === "string") return value.trim() && value !== PLACEHOLDER_JOINT ? value : null;
  if (isRecord(value)) {
    const joint = str(value.joint);
    return joint && joint.trim() && joint !== PLACEHOLDER_JOINT ? { joint } : null;
  }
  return null;
}

/**
 * A stored severity, or null. Rows carrying the producer's placeholder joint
 * ("general") were written with the constant "minor", which is not an
 * assessment; rows from the first producer (a model-named area) keep theirs.
 */
function assessedSeverity(item: Record<string, unknown>): AnalysisDeficiency["severity"] {
  const joint = item.joint_coordinate;
  const placeholder = isRecord(joint) ? joint.joint === PLACEHOLDER_JOINT : joint === PLACEHOLDER_JOINT;
  if (placeholder) return null;
  return item.severity === "major" || item.severity === "minor" ? item.severity : null;
}

export function sanitizeDeficiencies(value: unknown): AnalysisDeficiency[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      checkpoint: assessedCheckpoint(item.checkpoint),
      joint_coordinate: sanitizeJoint(item.joint_coordinate),
      fault_description: str(item.fault_description) ?? "",
      severity: assessedSeverity(item),
      corrective_drill_title: str(item.corrective_drill_title) ?? "",
      corrective_drill_detail: str(item.corrective_drill_detail) ?? null,
    }];
  });
}

function sanitizePillar(value: unknown): AnalysisPillar | null {
  if (!isRecord(value)) return null;
  return {
    rating: str(value.rating) ?? "",
    observation: str(value.observation) ?? "",
    correction: str(value.correction) ?? "",
  };
}

function sanitizeDrills(value: unknown): AnalysisDrill[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      name: str(item.name) ?? "",
      the_why: str(item.the_why) ?? "",
      the_how: str(item.the_how) ?? "",
      the_feel: str(item.the_feel) ?? "",
    }];
  });
}

/** Field-level allow-list over the mixed metrics jsonb. */
export function sanitizeCoreMetrics(value: unknown): AnalysisCoreMetrics | null {
  if (!isRecord(value)) return null;
  const out: AnalysisCoreMetrics = {};
  const assign = <K extends keyof AnalysisCoreMetrics>(key: K, v: AnalysisCoreMetrics[K] | undefined) => {
    if (v !== undefined) out[key] = v;
  };
  assign("scoring_breakdown", str(value.scoring_breakdown));
  assign("evidence_limits", str(value.evidence_limits));
  assign("spine_angle", num(value.spine_angle));
  assign("hip_rotation", num(value.hip_rotation));
  assign("shoulder_rotation", num(value.shoulder_rotation));
  assign("spine_angle_deg", num(value.spine_angle_deg));
  assign("hip_rotation_deg", num(value.hip_rotation_deg));
  assign("shoulder_rotation_deg", num(value.shoulder_rotation_deg));
  assign("tempo_ratio", str(value.tempo_ratio));
  assign("fault_tags", strList(value.fault_tags));
  assign("suggestions", strList(value.suggestions));
  assign("drills", sanitizeDrills(value.drills));
  if ("posture" in value) out.posture = sanitizePillar(value.posture);
  if ("swing_plane" in value) out.swing_plane = sanitizePillar(value.swing_plane);
  if ("impact" in value) out.impact = sanitizePillar(value.impact);
  assign("practice_focus", str(value.practice_focus));
  assign("pro_cue", str(value.pro_cue));
  assign("the_feel", str(value.the_feel));
  assign("putting_analysis", str(value.putting_analysis));
  return out;
}

// ─── Full-swing estimates: value and source together (S6-R1) ──────────────────

/**
 * Where a presented value came from. "ai_video_estimate": the model's own
 * value from the video, recorded with its source. "unrecorded": a row written
 * before sources were recorded, so the origin of its value is not known.
 */
export type FullSwingMetricSource = "ai_video_estimate" | "unrecorded";

export interface FullSwingMetricView {
  /** Null when the value is unavailable. Zero is a value. */
  readonly value: number | string | null;
  readonly source: FullSwingMetricSource;
  /** A client-supplied estimate recorded beside the value; unverified (origin cannot be verified), never the value. */
  readonly client_unverified_estimate: number | string | null;
}

export type FullSwingMetricsView = Readonly<Record<FullSwingMetricKey, FullSwingMetricView>>;

/** A legacy numeric tempo column (e.g. 2.5) in the stored "N:1" form, or null. */
function legacyTempo(value: unknown): string | null {
  const n = num(value);
  if (n === undefined || n <= 0 || n >= 100) return null;
  const formatted = `${Math.round(n * 100) / 100}:1`;
  return isTempoEstimate(formatted) ? formatted : null;
}

/**
 * The four estimates from the canonical stored fields only.
 *
 * A row with recorded metric evidence is read from that evidence alone: the
 * value is the AI's estimate (null when the video did not show it) and the
 * client's estimate stays a separate, unverified entry. A row without it
 * predates source recording, so its value — the dedicated column, else the
 * same-named metrics key that rows written before the columns carry — is
 * "unrecorded". The legacy *_deg keys are not read: no current producer writes
 * them. Every value is re-validated; anything malformed is unavailable.
 */
export function resolveFullSwingMetrics(row: Record<string, unknown>): FullSwingMetricsView {
  const metrics = isRecord(row.metrics) ? row.metrics : {};
  const evidence = readMetricEvidence(metrics.metric_evidence);
  const out = {} as Record<FullSwingMetricKey, FullSwingMetricView>;
  for (const key of FULL_SWING_METRIC_KEYS) {
    if (evidence) {
      out[key] = {
        value: evidence[key].ai_video_estimate,
        source: "ai_video_estimate",
        client_unverified_estimate: evidence[key].client_unverified_estimate,
      };
      continue;
    }
    let value: number | string | null;
    if (key === "tempo_ratio") {
      value = isTempoEstimate(metrics.tempo_ratio) ? metrics.tempo_ratio : legacyTempo(row.tempo_ratio);
    } else {
      value = isAngleEstimate(row[key]) ? (row[key] as number) : isAngleEstimate(metrics[key]) ? (metrics[key] as number) : null;
    }
    out[key] = { value, source: "unrecorded", client_unverified_estimate: null };
  }
  return out;
}

function familyOf(value: unknown): AnalysisResultView["analysis_family"] {
  return value === "full_swing" || value === "putting" ? value : null;
}

/**
 * Builds the authorized view from an owned row and its payload (they may be
 * one combined row, as the completion write returns). `access` decides the
 * premium classes; core fields depend on ownership alone.
 */
export function serializeAnalysisResult(
  row: Record<string, unknown>,
  access: AnalysisAccess,
): AnalysisResultView {
  const family = familyOf(row.analysis_family);
  const puttingVisible = access.puttingAnalysis && family === "putting";
  return {
    id: str(row.id) ?? "",
    swing_video_id: str(row.swing_video_id) ?? null,
    user_id: str(row.user_id) ?? "",
    club_id: str(row.club_id) ?? null,
    status: str(row.status) ?? "",
    analysis_family: family,
    equipment_snapshot: isRecord(row.equipment_snapshot) ? row.equipment_snapshot : null,
    analysis_mode: str(row.analysis_mode) ?? null,
    created_at: str(row.created_at) ?? null,
    score: num(row.score) ?? null,
    feedback: str(row.feedback) ?? null,
    tempo_ratio: num(row.tempo_ratio) ?? null,
    swing_speed_mph: num(row.swing_speed_mph) ?? null,
    spine_angle: num(row.spine_angle) ?? null,
    hip_rotation: num(row.hip_rotation) ?? null,
    shoulder_rotation: num(row.shoulder_rotation) ?? null,
    full_swing_metrics: family === "putting" ? null : resolveFullSwingMetrics(row),
    metrics: sanitizeCoreMetrics(row.metrics),
    swing_highlights: sanitizeHighlights(row.swing_highlights),
    mechanical_deficiencies: sanitizeDeficiencies(row.mechanical_deficiencies),
    putting_analysis:
      puttingVisible && isPersistedPuttingAnalysisV1(row.putting_analysis) ? row.putting_analysis : null,
    putting_score:
      puttingVisible && isPersistedPuttingScoreV1(row.putting_score)
        ? (row.putting_score as unknown as Record<string, unknown>)
        : null,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

type Caller = Pick<AuthenticatedCaller, "userId" | "client">;

/**
 * The payload of analyses the caller has already been proved to own, read by
 * the server-only client and bounded by those ids AND the caller's user id.
 * Rows are re-checked against both rather than trusted on the filter alone.
 * `null` when the read cannot be completed.
 */
export async function readOwnedAnalysisPayloads(
  analysisIds: readonly string[],
  ownerId: string,
): Promise<Map<string, Record<string, unknown>> | null> {
  const payloads = new Map<string, Record<string, unknown>>();
  if (analysisIds.length === 0) return payloads;
  try {
    const { data, error } = await createAdminClient()
      .from("swing_analysis")
      .select(ANALYSIS_PAYLOAD_COLUMNS)
      .in("id", [...analysisIds])
      .eq("user_id", ownerId);
    if (error || !Array.isArray(data)) return null;
    for (const item of data as unknown[]) {
      if (!isRecord(item) || item.user_id !== ownerId || typeof item.id !== "string") return null;
      if (!analysisIds.includes(item.id)) return null;
      payloads.set(item.id, item);
    }
    return payloads;
  } catch {
    return null;
  }
}

export type AuthorizedAnalysisRead =
  | {
      readonly status: "ok";
      readonly result: AnalysisResultView;
      readonly access: AnalysisAccess;
      /** The joined swing_videos row, when one was requested. Server use only. */
      readonly video: unknown;
    }
  | { readonly status: "not_found" }
  | { readonly status: "unavailable" };

/** Merges the caller-proved row with its payload, payload values last. */
function combine(owned: Record<string, unknown>, payload: Record<string, unknown> | undefined) {
  return { ...owned, ...(payload ?? {}) };
}

/**
 * One analysis, as the caller may receive it.
 * `videoColumns` adds a swing_videos join to the ownership read.
 */
export async function readAuthorizedAnalysis(
  caller: Caller,
  analysisId: string,
  options: { readonly videoColumns?: string } = {},
): Promise<AuthorizedAnalysisRead> {
  const columns = options.videoColumns
    ? `${ANALYSIS_OWNER_COLUMNS}, swing_video:swing_videos(${options.videoColumns})`
    : ANALYSIS_OWNER_COLUMNS;

  let owned: Record<string, unknown>;
  try {
    const { data, error } = await caller.client
      .from("swing_analysis")
      .select(columns)
      .eq("id", analysisId)
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (error) return { status: "unavailable" };
    if (!isRecord(data)) return { status: "not_found" };
    if (data.id !== analysisId || data.user_id !== caller.userId) return { status: "not_found" };
    owned = data;
  } catch {
    return { status: "unavailable" };
  }

  const [decision, payloads] = await Promise.all([
    resolveAnalysisAccess(caller.client, caller.userId),
    readOwnedAnalysisPayloads([analysisId], caller.userId),
  ]);
  const access = accessOf(decision);
  if (payloads === null) return { status: "unavailable" };

  return {
    status: "ok",
    result: serializeAnalysisResult(combine(owned, payloads.get(analysisId)), access),
    access,
    video: owned.swing_video ?? null,
  };
}

/**
 * Authorizes a history list a page has already read on the caller's own
 * session — identity and core columns only, never payload columns — and
 * returns it in the same `{ data, error }` shape, each row replaced by its
 * authorized view (plus the joined `swing_video`, server use only). Rows that
 * are not the caller's are dropped. A failed payload read is an error, never a
 * list of raw rows.
 */
export async function authorizeOwnedAnalysisRows(
  caller: Caller,
  owned: { readonly data: unknown; readonly error: unknown },
): Promise<{
  data: (AnalysisResultView & { swing_video: unknown })[] | null;
  error: { message: string } | null;
}> {
  const unavailable = { data: null, error: { message: "analysis history unavailable" } };
  if (owned.error || !Array.isArray(owned.data)) return unavailable;
  const rows = (owned.data as unknown[]).filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) && typeof row.id === "string" && row.user_id === caller.userId,
  );
  const [decision, payloads] = await Promise.all([
    resolveAnalysisAccess(caller.client, caller.userId),
    readOwnedAnalysisPayloads(
      rows.map((row) => row.id as string),
      caller.userId,
    ),
  ]);
  const access = accessOf(decision);
  if (payloads === null) return unavailable;
  return {
    data: rows.map((row) => ({
      ...serializeAnalysisResult(combine(row, payloads.get(row.id as string)), access),
      swing_video: row.swing_video ?? null,
    })),
    error: null,
  };
}

/**
 * Authorizes one analysis row a page has already read on the caller's own
 * session (identity and core columns only). `null` when the row is not the
 * caller's or its payload cannot be read.
 */
export async function authorizeOwnedAnalysisRow(
  caller: Caller,
  owned: unknown,
): Promise<{ readonly result: AnalysisResultView; readonly access: AnalysisAccess } | null> {
  if (!isRecord(owned) || typeof owned.id !== "string" || owned.user_id !== caller.userId) return null;
  const [decision, payloads] = await Promise.all([
    resolveAnalysisAccess(caller.client, caller.userId),
    readOwnedAnalysisPayloads([owned.id], caller.userId),
  ]);
  const access = accessOf(decision);
  if (payloads === null) return null;
  return { result: serializeAnalysisResult(combine(owned, payloads.get(owned.id)), access), access };
}
