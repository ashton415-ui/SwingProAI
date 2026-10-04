import { headers } from "next/headers";
import { resolveRouteAuth } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPracticeIntelligenceEnabled } from "@/lib/feature-flags";
import { requirePracticeAccess } from "@/lib/practice-entitlement-authority";
import {
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
  v1ValidationError,
} from "@/lib/api/v1-response";
import { PG_UNIQUE_VIOLATION } from "@/lib/api/v1-analysis-dto";
import {
  IDEMPOTENT_REPLAY_HEADER,
  LIST_LIMIT,
  PG_FOREIGN_KEY_VIOLATION,
  SESSION_COLUMNS,
  SESSION_IDEMPOTENCY_COLUMNS,
  mapAll,
  parseIdempotencyKey,
  parseSessionListQuery,
  parseSessionStartRequest,
  readJsonBody,
  requestFingerprint,
  toSessionDto,
} from "@/lib/api/v1-practice-dto";

/**
 * GET  /api/v1/practice/sessions?status=in_progress|completed|abandoned
 * POST /api/v1/practice/sessions
 *
 * The caller's own practice sessions. A golfer has at most one session in
 * progress; the database enforces that with a partial unique index, and this
 * route turns the refusal into PRACTICE_SESSION_ALREADY_ACTIVE.
 *
 * Starting a session is a single INSERT on the server-only elevated client
 * whose `user_id` is the verified identity. A named plan must be the caller's
 * own active plan, which is decided on the caller's client; the composite
 * foreign key (plan_id, user_id) makes a plan owned by anyone else impossible
 * to reference even if that check were bypassed.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice sessions are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const PLAN_NOT_FOUND_MESSAGE = "The practice plan could not be found.";
const ALREADY_ACTIVE_MESSAGE = "A practice session is already in progress.";
const IDEMPOTENCY_CONFLICT_MESSAGE = "This Idempotency-Key was already used for a different request.";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveRequestId(await headers());
  if (!isPracticeIntelligenceEnabled()) {
    return v1Error("FEATURE_UNAVAILABLE", FEATURE_UNAVAILABLE_MESSAGE, requestId, 404);
  }

  const internal = () => v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    const refused = await requirePracticeAccess(auth, requestId);
    if (refused) return refused;

    const query = parseSessionListQuery(new URL(request.url));
    if (!query.ok) {
      return v1ValidationError(requestId);
    }

    let builder = auth.client
      .from("practice_sessions")
      .select(SESSION_COLUMNS)
      .eq("user_id", auth.userId);
    if (query.status !== null) {
      builder = builder.eq("status", query.status);
    }
    const { data, error } = await builder.order("started_at", { ascending: false }).limit(LIST_LIMIT);

    if (error) {
      return v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
    }
    const sessions = mapAll(data, toSessionDto);
    return sessions === null ? internal() : v1Success({ sessions }, requestId);
  } catch {
    return internal();
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(await headers());
  if (!isPracticeIntelligenceEnabled()) {
    return v1Error("FEATURE_UNAVAILABLE", FEATURE_UNAVAILABLE_MESSAGE, requestId, 404);
  }

  const unavailable = () =>
    v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
  const internal = () => v1Error("INTERNAL_ERROR", INTERNAL_MESSAGE, requestId, 500);

  try {
    const auth = await resolveRouteAuth();
    if (auth.status !== "authenticated") {
      return v1AuthErrorResponse(auth, requestId) ?? internal();
    }

    const refused = await requirePracticeAccess(auth, requestId);
    if (refused) return refused;

    const idempotencyKey = parseIdempotencyKey(request.headers);
    if (idempotencyKey === null) {
      return v1ValidationError(requestId);
    }

    // A session may be started with no body at all.
    const body = parseSessionStartRequest(await readJsonBody(request, true));
    if (body === null) {
      return v1ValidationError(requestId);
    }

    const fingerprint = requestFingerprint("practice.session.start", {}, body);

    const readByKey = () =>
      auth.client
        .from("practice_sessions")
        .select(SESSION_IDEMPOTENCY_COLUMNS)
        .eq("user_id", auth.userId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

    const answerExisting = (row: Record<string, unknown>): Response => {
      if (row.request_fingerprint !== fingerprint) {
        return v1Error("IDEMPOTENCY_CONFLICT", IDEMPOTENCY_CONFLICT_MESSAGE, requestId, 409);
      }
      const dto = toSessionDto(row);
      return dto === null
        ? internal()
        : v1Success({ session: dto }, requestId, { headers: { [IDEMPOTENT_REPLAY_HEADER]: "true" } });
    };

    // 1. The same key answers the way it answered the first time.
    const existing = await readByKey();
    if (existing.error) {
      return unavailable();
    }
    if (existing.data) {
      return answerExisting(existing.data);
    }

    // 2. A named plan must be the caller's own and still active.
    if (body.planId !== null) {
      const plan = await auth.client
        .from("practice_plans")
        .select("id, status")
        .eq("id", body.planId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (plan.error) {
        return unavailable();
      }
      if (!plan.data || plan.data.status !== "active") {
        return v1Error("PRACTICE_PLAN_NOT_FOUND", PLAN_NOT_FOUND_MESSAGE, requestId, 404);
      }
    }

    // 3. The single trusted write. `user_id` is the verified identity; status,
    // started_at and ended_at are left to their database defaults.
    let inserted;
    try {
      const admin = createAdminClient();
      inserted = await admin
        .from("practice_sessions")
        .insert({
          user_id: auth.userId,
          plan_id: body.planId,
          notes: body.notes,
          idempotency_key: idempotencyKey,
          request_fingerprint: fingerprint,
        })
        .select(SESSION_COLUMNS)
        .single();
    } catch {
      return unavailable();
    }

    if (!inserted.error) {
      const dto = toSessionDto(inserted.data);
      return dto === null ? internal() : v1Success({ session: dto }, requestId, { status: 201 });
    }

    const code = (inserted.error as { code?: unknown }).code;
    if (code === PG_FOREIGN_KEY_VIOLATION) {
      return v1Error("PRACTICE_PLAN_NOT_FOUND", PLAN_NOT_FOUND_MESSAGE, requestId, 404);
    }
    if (code !== PG_UNIQUE_VIOLATION) {
      return unavailable();
    }

    // 4. Either a concurrent request with this key won, or another session is
    // already in progress. Exactly one re-read by key decides which.
    const afterConflict = await readByKey();
    if (afterConflict.error) {
      return unavailable();
    }
    if (afterConflict.data) {
      return answerExisting(afterConflict.data);
    }
    return v1Error("PRACTICE_SESSION_ALREADY_ACTIVE", ALREADY_ACTIVE_MESSAGE, requestId, 409);
  } catch {
    return internal();
  }
}
