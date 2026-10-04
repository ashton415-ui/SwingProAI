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
import {
  IDEMPOTENT_REPLAY_HEADER,
  LIST_LIMIT,
  PG_FOREIGN_KEY_VIOLATION,
  PLAN_COLUMNS,
  PLAN_ITEM_COLUMNS,
  mapAll,
  parseIdempotencyKey,
  parsePlanCreateOutcome,
  parsePlanCreateRequest,
  parsePlanListQuery,
  readJsonBody,
  requestFingerprint,
  toPlanDto,
  toPlanItemDto,
} from "@/lib/api/v1-practice-dto";

/**
 * GET  /api/v1/practice/plans?status=active|archived
 * POST /api/v1/practice/plans
 *
 * The caller's own practice plans. Reads run on the caller's client, so RLS
 * decides what is visible. Creation goes through `pi_create_practice_plan` on
 * the server-only elevated client, which writes the plan and all of its items
 * in one transaction; the owner is always the verified identity.
 *
 * With PRACTICE_INTELLIGENCE_ENABLED off, both methods answer 404 before
 * authenticating or touching the database.
 */

const FEATURE_UNAVAILABLE_MESSAGE = "This feature is not available.";
const UNAVAILABLE_MESSAGE = "Practice plans are temporarily unavailable. Please retry.";
const INTERNAL_MESSAGE = "The request could not be completed.";
const DRILL_NOT_FOUND_MESSAGE = "A selected drill could not be found.";
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

    const query = parsePlanListQuery(new URL(request.url));
    if (!query.ok) {
      return v1ValidationError(requestId);
    }

    let builder = auth.client
      .from("practice_plans")
      .select(PLAN_COLUMNS)
      .eq("user_id", auth.userId);
    if (query.status !== null) {
      builder = builder.eq("status", query.status);
    }
    const { data, error } = await builder.order("created_at", { ascending: false }).limit(LIST_LIMIT);

    if (error) {
      return v1Error("SERVER_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE, requestId, 503);
    }
    const plans = mapAll(data, toPlanDto);
    return plans === null ? internal() : v1Success({ plans }, requestId);
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

    const body = parsePlanCreateRequest(await readJsonBody(request, false));
    if (body === null) {
      return v1ValidationError(requestId);
    }

    const fingerprint = requestFingerprint("practice.plan.create", {}, body);

    let rpc;
    try {
      const admin = createAdminClient();
      rpc = await admin.rpc("pi_create_practice_plan", {
        p_user_id: auth.userId,
        p_idempotency_key: idempotencyKey,
        p_request_fingerprint: fingerprint,
        p_title: body.title,
        p_focus: body.focus,
        p_items: body.items,
      });
    } catch {
      // A missing server configuration throws on construction: an outage.
      return unavailable();
    }

    if (rpc.error) {
      // A drill removed between the function's check and its insert.
      if ((rpc.error as { code?: unknown }).code === PG_FOREIGN_KEY_VIOLATION) {
        return v1Error("DRILL_NOT_FOUND", DRILL_NOT_FOUND_MESSAGE, requestId, 409);
      }
      return unavailable();
    }

    const outcome = parsePlanCreateOutcome(rpc.data);
    if (outcome === null) {
      return internal();
    }
    switch (outcome.outcome) {
      case "idempotency_conflict":
        return v1Error("IDEMPOTENCY_CONFLICT", IDEMPOTENCY_CONFLICT_MESSAGE, requestId, 409);
      case "drill_not_found":
        return v1Error("DRILL_NOT_FOUND", DRILL_NOT_FOUND_MESSAGE, requestId, 409);
    }

    // The answer is read back on the caller's own client, so it shows exactly
    // what RLS lets the caller see.
    const plan = await auth.client
      .from("practice_plans")
      .select(PLAN_COLUMNS)
      .eq("id", outcome.planId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (plan.error) {
      return unavailable();
    }
    const items = await auth.client
      .from("practice_plan_items")
      .select(PLAN_ITEM_COLUMNS)
      .eq("plan_id", outcome.planId)
      .eq("user_id", auth.userId)
      .order("position", { ascending: true });
    if (items.error) {
      return unavailable();
    }

    const planDto = toPlanDto(plan.data);
    const itemDtos = mapAll(items.data, toPlanItemDto);
    if (planDto === null || itemDtos === null || itemDtos.length === 0) {
      return internal();
    }

    const replayed = outcome.outcome === "replayed";
    return v1Success({ plan: { ...planDto, items: itemDtos } }, requestId, {
      status: replayed ? 200 : 201,
      headers: replayed ? { [IDEMPOTENT_REPLAY_HEADER]: "true" } : undefined,
    });
  } catch {
    return internal();
  }
}
