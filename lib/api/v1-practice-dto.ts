import { createHash } from "node:crypto";
import { isUuid } from "@/lib/api/v1-analysis-dto";

/**
 * SwingProAI — V1 Practice Intelligence (PI-0) request and response shapes.
 *
 * Everything here is pure: parsing, normalisation, the idempotency fingerprint
 * and the mapping from database rows to the DTOs a client sees. The routes own
 * authentication, database access and HTTP answers.
 *
 * Two rules run through the whole module:
 *
 *   * A request is parsed exactly. Unknown keys, wrong types and out-of-range
 *     values are refused rather than repaired, and the refusal says nothing
 *     about which rule failed (see `v1ValidationError`).
 *   * A DTO never carries `user_id`, `idempotency_key` or
 *     `request_fingerprint`. Ownership is implied by who asked; the other two
 *     are server bookkeeping.
 */

// ─── Database codes ───────────────────────────────────────────────────────────

/** A foreign key refused the write — here, a drill that no longer exists. */
export const PG_FOREIGN_KEY_VIOLATION = "23503";

// ─── Limits (mirroring the migration's CHECK constraints) ─────────────────────

export const PLAN_TITLE_MAX = 120;
export const PLAN_FOCUS_MAX = 500;
export const PLAN_ITEMS_MIN = 1;
export const PLAN_ITEMS_MAX = 20;
export const TARGET_REPS_MIN = 1;
export const TARGET_REPS_MAX = 500;
export const TARGET_NOTE_MAX = 500;
export const SESSION_NOTES_MAX = 1000;
export const RESULT_ATTEMPTS_MAX = 1000;
export const RESULT_NOTE_MAX = 1000;
export const SELF_RATING_MIN = 1;
export const SELF_RATING_MAX = 5;

/** The most rows any list endpoint answers with. */
export const LIST_LIMIT = 100;

// ─── Vocabularies ─────────────────────────────────────────────────────────────

export const PLAN_STATUSES = ["active", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const SESSION_STATUSES = ["in_progress", "completed", "abandoned"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** How a session may end. */
export const SESSION_OUTCOMES = ["completed", "abandoned"] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

function isPlanStatus(value: unknown): value is PlanStatus {
  return (PLAN_STATUSES as readonly unknown[]).includes(value);
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (SESSION_STATUSES as readonly unknown[]).includes(value);
}

// ─── Projections ──────────────────────────────────────────────────────────────
// Written out rather than `*`, so a column added later cannot reach a response
// without someone editing these lines.

export const PLAN_COLUMNS = "id, title, focus, origin, status, archived_at, created_at, updated_at";
export const PLAN_ITEM_COLUMNS = "id, plan_id, drill_id, position, target_reps, target_note, created_at";
export const SESSION_COLUMNS = "id, plan_id, status, started_at, ended_at, notes, created_at";
/** Session columns plus the fingerprint, for the idempotent start only. Never mapped to a DTO. */
export const SESSION_IDEMPOTENCY_COLUMNS = `${SESSION_COLUMNS}, request_fingerprint`;
export const RESULT_COLUMNS =
  "id, session_id, plan_id, plan_item_id, drill_id, evidence_type, attempts, successes, self_rating, note, recorded_at, created_at";
/** The result columns progress is derived from. */
export const PROGRESS_RESULT_COLUMNS = "id, session_id, plan_item_id, attempts, successes, recorded_at";

// ─── Identifiers ──────────────────────────────────────────────────────────────

/** The one accepted Idempotency-Key form: a lowercase canonical UUID. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAY_HEADER = "Idempotent-Replayed";

/**
 * The request's Idempotency-Key, or `null` when it is missing or not exactly a
 * lowercase canonical UUID. Nothing is trimmed or lower-cased: a key the
 * client did not send byte for byte is not the key it will retry with.
 */
export function parseIdempotencyKey(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get(IDEMPOTENCY_KEY_HEADER);
  return raw !== null && CANONICAL_UUID.test(raw) ? raw : null;
}

/** A path identifier, normalised to lowercase, or `null` when it is not a UUID. */
export function parsePathId(raw: unknown): string | null {
  return isUuid(raw) ? raw.toLowerCase() : null;
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted at every depth, arrays in order.
 * Only the plain JSON values the parsers below produce are accepted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  throw new Error("canonicalJson: unsupported value");
}

/**
 * The sha256 hex fingerprint of one request: its operation, its path
 * parameters and its already-validated, normalised body. Two requests with
 * the same key and the same fingerprint are the same request.
 */
export function requestFingerprint(
  operation: string,
  params: Record<string, string>,
  body: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, params, body }), "utf8")
    .digest("hex");
}

// ─── Body parsing helpers ─────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/** Length in characters (code points), which is what PostgreSQL's length() counts. */
function charLength(value: string): number {
  return Array.from(value).length;
}

/**
 * An optional free-text field: absent or null → null; a string is trimmed and
 * an empty result becomes null. `undefined` is returned for anything invalid.
 */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return charLength(trimmed) <= max ? trimmed : undefined;
}

/** An optional integer in [min, max]: absent or null → null; `undefined` when invalid. */
function optionalInteger(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/** An optional UUID: absent or null → null; lowercased; `undefined` when invalid. */
function optionalUuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return isUuid(value) ? value.toLowerCase() : undefined;
}

// ─── Plan create ──────────────────────────────────────────────────────────────

export interface PlanItemInput {
  drillId: string;
  targetReps: number | null;
  targetNote: string | null;
}

export interface PlanCreateInput {
  title: string;
  focus: string | null;
  items: PlanItemInput[];
}

const PLAN_CREATE_KEYS = ["title", "focus", "items"] as const;
const PLAN_ITEM_KEYS = ["drillId", "targetReps", "targetNote"] as const;

export function parsePlanCreateRequest(body: unknown): PlanCreateInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, PLAN_CREATE_KEYS)) return null;

  if (typeof body.title !== "string") return null;
  const title = body.title.trim();
  const titleLength = charLength(title);
  if (titleLength < 1 || titleLength > PLAN_TITLE_MAX) return null;

  const focus = optionalText(body.focus, PLAN_FOCUS_MAX);
  if (focus === undefined) return null;

  if (!Array.isArray(body.items)) return null;
  if (body.items.length < PLAN_ITEMS_MIN || body.items.length > PLAN_ITEMS_MAX) return null;

  const items: PlanItemInput[] = [];
  for (const raw of body.items) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, PLAN_ITEM_KEYS)) return null;
    if (!isUuid(raw.drillId)) return null;
    const targetReps = optionalInteger(raw.targetReps, TARGET_REPS_MIN, TARGET_REPS_MAX);
    if (targetReps === undefined) return null;
    const targetNote = optionalText(raw.targetNote, TARGET_NOTE_MAX);
    if (targetNote === undefined) return null;
    items.push({ drillId: raw.drillId.toLowerCase(), targetReps, targetNote });
  }

  return { title, focus, items };
}

// ─── Session start ────────────────────────────────────────────────────────────

export interface SessionStartInput {
  planId: string | null;
  notes: string | null;
}

const SESSION_START_KEYS = ["planId", "notes"] as const;

export function parseSessionStartRequest(body: unknown): SessionStartInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, SESSION_START_KEYS)) return null;
  const planId = optionalUuid(body.planId);
  if (planId === undefined) return null;
  const notes = optionalText(body.notes, SESSION_NOTES_MAX);
  if (notes === undefined) return null;
  return { planId, notes };
}

// ─── Result record ────────────────────────────────────────────────────────────

export interface ResultRecordInput {
  planItemId: string | null;
  drillId: string;
  attempts: number | null;
  successes: number | null;
  selfRating: number | null;
  note: string | null;
}

const RESULT_RECORD_KEYS = ["planItemId", "drillId", "attempts", "successes", "selfRating", "note"] as const;

/**
 * One user-entered result. At least one of attempts, selfRating or note must
 * carry something, and successes are only meaningful against attempts, so
 * successes without attempts — or above them — is refused.
 */
export function parseResultRecordRequest(body: unknown): ResultRecordInput | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, RESULT_RECORD_KEYS)) return null;

  const planItemId = optionalUuid(body.planItemId);
  if (planItemId === undefined) return null;
  if (!isUuid(body.drillId)) return null;
  const attempts = optionalInteger(body.attempts, 0, RESULT_ATTEMPTS_MAX);
  if (attempts === undefined) return null;
  const successes = optionalInteger(body.successes, 0, RESULT_ATTEMPTS_MAX);
  if (successes === undefined) return null;
  const selfRating = optionalInteger(body.selfRating, SELF_RATING_MIN, SELF_RATING_MAX);
  if (selfRating === undefined) return null;
  const note = optionalText(body.note, RESULT_NOTE_MAX);
  if (note === undefined) return null;

  if (successes !== null && (attempts === null || successes > attempts)) return null;
  if (attempts === null && selfRating === null && note === null) return null;

  return { planItemId, drillId: body.drillId.toLowerCase(), attempts, successes, selfRating, note };
}

// ─── Session complete ─────────────────────────────────────────────────────────

const SESSION_COMPLETE_KEYS = ["outcome"] as const;

export function parseSessionCompleteRequest(body: unknown): { outcome: SessionOutcome } | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, SESSION_COMPLETE_KEYS)) return null;
  const { outcome } = body;
  if (!(SESSION_OUTCOMES as readonly unknown[]).includes(outcome)) return null;
  return { outcome: outcome as SessionOutcome };
}

// ─── List filters ─────────────────────────────────────────────────────────────

/** `?status=`: absent → no filter; present → must be exactly one vocabulary member. */
function parseStatusFilter<T extends string>(
  url: URL,
  allowed: readonly T[],
): { ok: true; status: T | null } | { ok: false } {
  const keys = Array.from(url.searchParams.keys());
  if (keys.some((key) => key !== "status")) return { ok: false };
  const values = url.searchParams.getAll("status");
  if (values.length === 0) return { ok: true, status: null };
  if (values.length > 1) return { ok: false };
  const value = values[0];
  return (allowed as readonly string[]).includes(value) ? { ok: true, status: value as T } : { ok: false };
}

export function parsePlanListQuery(url: URL): { ok: true; status: PlanStatus | null } | { ok: false } {
  return parseStatusFilter(url, PLAN_STATUSES);
}

export function parseSessionListQuery(url: URL): { ok: true; status: SessionStatus | null } | { ok: false } {
  return parseStatusFilter(url, SESSION_STATUSES);
}

/**
 * Reads a JSON body. An empty body reads as `{}` when `emptyAsObject` is set,
 * so a session can be started without one. `undefined` means unparseable.
 */
export async function readJsonBody(request: Request, emptyAsObject: boolean): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (text.trim().length === 0) return emptyAsObject ? {} : undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ─── Function outcomes ────────────────────────────────────────────────────────

export type PlanCreateOutcome =
  | { outcome: "created" | "replayed"; planId: string }
  | { outcome: "idempotency_conflict" | "drill_not_found" };

export function parsePlanCreateOutcome(raw: unknown): PlanCreateOutcome | null {
  if (!isPlainObject(raw)) return null;
  if (raw.outcome === "created" || raw.outcome === "replayed") {
    return isUuid(raw.plan_id) ? { outcome: raw.outcome, planId: raw.plan_id } : null;
  }
  if (raw.outcome === "idempotency_conflict" || raw.outcome === "drill_not_found") {
    return { outcome: raw.outcome };
  }
  return null;
}

export type ResultRecordOutcome =
  | { outcome: "created" | "replayed"; resultId: string }
  | {
      outcome:
        | "idempotency_conflict"
        | "session_not_found"
        | "session_not_active"
        | "drill_not_found"
        | "plan_item_invalid";
    };

const RESULT_FAILURE_OUTCOMES = [
  "idempotency_conflict",
  "session_not_found",
  "session_not_active",
  "drill_not_found",
  "plan_item_invalid",
] as const;

export function parseResultRecordOutcome(raw: unknown): ResultRecordOutcome | null {
  if (!isPlainObject(raw)) return null;
  if (raw.outcome === "created" || raw.outcome === "replayed") {
    return isUuid(raw.result_id) ? { outcome: raw.outcome, resultId: raw.result_id } : null;
  }
  if ((RESULT_FAILURE_OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
    return { outcome: raw.outcome as (typeof RESULT_FAILURE_OUTCOMES)[number] };
  }
  return null;
}

// ─── Row → DTO ────────────────────────────────────────────────────────────────

export interface PracticePlanItemDto {
  id: string;
  position: number;
  drillId: string;
  targetReps: number | null;
  targetNote: string | null;
}

export interface PracticePlanDto {
  id: string;
  title: string;
  focus: string | null;
  origin: "golfer";
  status: PlanStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeSessionDto {
  id: string;
  planId: string | null;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface PracticeResultDto {
  id: string;
  sessionId: string;
  planId: string | null;
  planItemId: string | null;
  drillId: string;
  evidenceType: "user_entered";
  attempts: number | null;
  successes: number | null;
  selfRating: number | null;
  note: string | null;
  recordedAt: string;
}

type Row = Record<string, unknown>;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

/** Each mapper returns `null` for a row that does not match the schema; the route answers 500. */
export function toPlanDto(row: unknown): PracticePlanDto | null {
  if (!isPlainObject(row)) return null;
  const r = row as Row;
  if (!isUuid(r.id) || !isString(r.title) || !isNullableString(r.focus)) return null;
  if (r.origin !== "golfer" || !isPlanStatus(r.status)) return null;
  if (!isNullableString(r.archived_at) || !isString(r.created_at) || !isString(r.updated_at)) return null;
  return {
    id: r.id,
    title: r.title,
    focus: r.focus,
    origin: "golfer",
    status: r.status,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toPlanItemDto(row: unknown): PracticePlanItemDto | null {
  if (!isPlainObject(row)) return null;
  const r = row as Row;
  if (!isUuid(r.id) || !isUuid(r.drill_id)) return null;
  if (typeof r.position !== "number" || !Number.isInteger(r.position) || r.position < 1) return null;
  if (!isNullableInteger(r.target_reps) || !isNullableString(r.target_note)) return null;
  return {
    id: r.id,
    position: r.position,
    drillId: r.drill_id,
    targetReps: r.target_reps,
    targetNote: r.target_note,
  };
}

export function toSessionDto(row: unknown): PracticeSessionDto | null {
  if (!isPlainObject(row)) return null;
  const r = row as Row;
  if (!isUuid(r.id) || !isNullableUuid(r.plan_id) || !isSessionStatus(r.status)) return null;
  if (!isString(r.started_at) || !isNullableString(r.ended_at)) return null;
  if (!isNullableString(r.notes) || !isString(r.created_at)) return null;
  return {
    id: r.id,
    planId: r.plan_id,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export function toResultDto(row: unknown): PracticeResultDto | null {
  if (!isPlainObject(row)) return null;
  const r = row as Row;
  if (!isUuid(r.id) || !isUuid(r.session_id) || !isNullableUuid(r.plan_id)) return null;
  if (!isNullableUuid(r.plan_item_id) || !isUuid(r.drill_id)) return null;
  if (r.evidence_type !== "user_entered") return null;
  if (!isNullableInteger(r.attempts) || !isNullableInteger(r.successes) || !isNullableInteger(r.self_rating)) {
    return null;
  }
  if (!isNullableString(r.note) || !isString(r.recorded_at)) return null;
  return {
    id: r.id,
    sessionId: r.session_id,
    planId: r.plan_id,
    planItemId: r.plan_item_id,
    drillId: r.drill_id,
    evidenceType: "user_entered",
    attempts: r.attempts,
    successes: r.successes,
    selfRating: r.self_rating,
    note: r.note,
    recordedAt: r.recorded_at,
  };
}

/** Maps every row, or `null` if any row is malformed — never a partial list. */
export function mapAll<T>(rows: unknown, map: (row: unknown) => T | null): T[] | null {
  if (!Array.isArray(rows)) return null;
  const out: T[] = [];
  for (const row of rows) {
    const dto = map(row);
    if (dto === null) return null;
    out.push(dto);
  }
  return out;
}

// ─── Paged reads ──────────────────────────────────────────────────────────────

/** Rows requested per page; below any PostgREST max-rows setting in use. */
export const READ_PAGE_SIZE = 500;
/** Pages read before giving up rather than answering from a partial set. */
export const READ_PAGE_LIMIT = 20;

/**
 * Reads every row of a query page by page, so a derived answer (progress) is
 * never computed from a silently truncated set. `page(from, to)` must apply a
 * stable order. Returns `null` on any error or when the page limit is reached.
 */
export async function readAllPages(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<unknown[] | null> {
  const rows: unknown[] = [];
  for (let index = 0; index < READ_PAGE_LIMIT; index += 1) {
    const from = index * READ_PAGE_SIZE;
    const { data, error } = await page(from, from + READ_PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) return null;
    rows.push(...data);
    if (data.length < READ_PAGE_SIZE) return rows;
  }
  return null;
}
