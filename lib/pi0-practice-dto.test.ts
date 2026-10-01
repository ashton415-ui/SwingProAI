import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";

import {
  canonicalJson,
  mapAll,
  parseIdempotencyKey,
  parsePathId,
  parsePlanCreateOutcome,
  parsePlanCreateRequest,
  parsePlanListQuery,
  parseResultRecordOutcome,
  parseResultRecordRequest,
  parseSessionCompleteRequest,
  parseSessionListQuery,
  parseSessionStartRequest,
  readAllPages,
  READ_PAGE_LIMIT,
  READ_PAGE_SIZE,
  requestFingerprint,
  toPlanDto,
  toPlanItemDto,
  toResultDto,
  toSessionDto,
} from "./api/v1-practice-dto";
import { derivePlanProgress } from "./practice-progress";
import { isPracticeIntelligenceEnabled, isCoachMarketplaceEnabled } from "./feature-flags";

/**
 * PI-0 — pure request parsing, fingerprinting, DTO mapping, progress
 * derivation and the feature flag. No route, client or database is involved.
 */

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "0f000000-0000-4000-8000-000000000001";

const headersOf = (value: string | null) => ({ get: (n: string) => (n === "Idempotency-Key" ? value : null) });

// ─── Feature flag ─────────────────────────────────────────────────────────────

describe("isPracticeIntelligenceEnabled", () => {
  const original = process.env.PRACTICE_INTELLIGENCE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
    else process.env.PRACTICE_INTELLIGENCE_ENABLED = original;
  });

  it("is off by default and for every value but the word true", () => {
    delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
    expect(isPracticeIntelligenceEnabled()).toBe(false);
    for (const v of ["", "false", "0", "1", "yes", "on", "enabled", "truee", "t"]) {
      process.env.PRACTICE_INTELLIGENCE_ENABLED = v;
      expect(isPracticeIntelligenceEnabled(), v).toBe(false);
    }
    for (const v of ["true", "TRUE", " True "]) {
      process.env.PRACTICE_INTELLIGENCE_ENABLED = v;
      expect(isPracticeIntelligenceEnabled(), v).toBe(true);
    }
  });

  it("is independent of the coach marketplace flag and of any NEXT_PUBLIC_ variable", () => {
    delete process.env.PRACTICE_INTELLIGENCE_ENABLED;
    const coach = process.env.COACH_MARKETPLACE_ENABLED;
    process.env.COACH_MARKETPLACE_ENABLED = "true";
    process.env.NEXT_PUBLIC_PRACTICE_INTELLIGENCE_ENABLED = "true";
    try {
      expect(isCoachMarketplaceEnabled()).toBe(true);
      expect(isPracticeIntelligenceEnabled()).toBe(false);
    } finally {
      if (coach === undefined) delete process.env.COACH_MARKETPLACE_ENABLED;
      else process.env.COACH_MARKETPLACE_ENABLED = coach;
      delete process.env.NEXT_PUBLIC_PRACTICE_INTELLIGENCE_ENABLED;
    }
  });
});

// ─── Identifiers ──────────────────────────────────────────────────────────────

describe("identifiers", () => {
  it("accepts only a lowercase canonical Idempotency-Key, unmodified", () => {
    expect(parseIdempotencyKey(headersOf(KEY))).toBe(KEY);
    for (const bad of [null, "", KEY.toUpperCase(), ` ${KEY}`, KEY.replace(/-/g, ""), `${KEY}x`, "x".repeat(36)]) {
      expect(parseIdempotencyKey(headersOf(bad)), String(bad)).toBeNull();
    }
  });

  it("normalises a path id to lowercase and refuses anything else", () => {
    expect(parsePathId(UUID_A.toUpperCase())).toBe(UUID_A);
    for (const bad of [undefined, null, "", "abc", `${UUID_A}/x`, 5]) expect(parsePathId(bad)).toBeNull();
  });
});

// ─── Fingerprint ──────────────────────────────────────────────────────────────

describe("request fingerprint", () => {
  it("serialises deterministically with sorted keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: null, y: "x" }], c: true } })).toBe(
      '{"a":{"c":true,"d":[2,{"y":"x","z":null}]},"b":1}',
    );
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });

  it("is sha256 hex over operation, params and body", () => {
    const expected = createHash("sha256")
      .update('{"body":{"x":1},"operation":"op","params":{"id":"p"}}', "utf8")
      .digest("hex");
    expect(requestFingerprint("op", { id: "p" }, { x: 1 })).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the operation, a path parameter or the body, and not with key order", () => {
    const base = requestFingerprint("op", { id: "p" }, { a: 1, b: 2 });
    expect(requestFingerprint("op", { id: "p" }, { b: 2, a: 1 })).toBe(base);
    expect(requestFingerprint("op2", { id: "p" }, { a: 1, b: 2 })).not.toBe(base);
    expect(requestFingerprint("op", { id: "q" }, { a: 1, b: 2 })).not.toBe(base);
    expect(requestFingerprint("op", { id: "p" }, { a: 1, b: 3 })).not.toBe(base);
  });

  it("fingerprints normalised input: equivalent requests agree", () => {
    const a = parsePlanCreateRequest({ title: " T ", items: [{ drillId: UUID_A.toUpperCase(), targetNote: "" }] });
    const b = parsePlanCreateRequest({ items: [{ targetReps: null, drillId: UUID_A }], focus: null, title: "T" });
    expect(a).toEqual(b);
    expect(requestFingerprint("x", {}, a)).toBe(requestFingerprint("x", {}, b));
  });
});

// ─── Parsers ──────────────────────────────────────────────────────────────────

describe("parsePlanCreateRequest", () => {
  it("normalises text, ids and absent optionals", () => {
    expect(
      parsePlanCreateRequest({
        title: "  Wedges ",
        focus: "  ",
        items: [{ drillId: UUID_A.toUpperCase(), targetReps: 10, targetNote: " slow " }],
      }),
    ).toEqual({ title: "Wedges", focus: null, items: [{ drillId: UUID_A, targetReps: 10, targetNote: "slow" }] });
  });

  it("counts characters, not UTF-16 units", () => {
    expect(parsePlanCreateRequest({ title: "⛳".repeat(120), items: [{ drillId: UUID_A }] })).not.toBeNull();
    expect(parsePlanCreateRequest({ title: "🏌".repeat(120), items: [{ drillId: UUID_A }] })).not.toBeNull();
    expect(parsePlanCreateRequest({ title: "🏌".repeat(121), items: [{ drillId: UUID_A }] })).toBeNull();
  });

  it("refuses unknown keys, wrong types and out-of-range values", () => {
    const item = { drillId: UUID_A };
    for (const bad of [
      undefined,
      null,
      [],
      { title: "t" },
      { title: "t", items: [] },
      { title: "t", items: {} },
      { title: "", items: [item] },
      { title: "t", items: [item], extra: 1 },
      { title: "t", items: [{ ...item, extra: 1 }] },
      { title: "t", items: [{ drillId: UUID_A, targetReps: 0 }] },
      { title: "t", items: [{ drillId: UUID_A, targetReps: 501 }] },
      { title: "t", items: [{ drillId: UUID_A, targetReps: Number.NaN }] },
      { title: "t", items: [null] },
      { title: "t", items: Array.from({ length: 21 }, () => item) },
    ]) {
      expect(parsePlanCreateRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parseSessionStartRequest / parseSessionCompleteRequest", () => {
  it("accepts an empty object and normalises planId and notes", () => {
    expect(parseSessionStartRequest({})).toEqual({ planId: null, notes: null });
    expect(parseSessionStartRequest({ planId: UUID_B.toUpperCase(), notes: " n " })).toEqual({
      planId: UUID_B,
      notes: "n",
    });
    expect(parseSessionStartRequest({ planId: "x" })).toBeNull();
    expect(parseSessionStartRequest({ status: "completed" })).toBeNull();
  });

  it("accepts exactly the two end outcomes", () => {
    expect(parseSessionCompleteRequest({ outcome: "completed" })).toEqual({ outcome: "completed" });
    expect(parseSessionCompleteRequest({ outcome: "abandoned" })).toEqual({ outcome: "abandoned" });
    for (const bad of [{}, { outcome: "in_progress" }, { outcome: "COMPLETED" }, { outcome: "completed", x: 1 }]) {
      expect(parseSessionCompleteRequest(bad)).toBeNull();
    }
  });
});

describe("parseResultRecordRequest", () => {
  it("requires some evidence and keeps successes within attempts", () => {
    expect(parseResultRecordRequest({ drillId: UUID_A, attempts: 0 })).toMatchObject({ attempts: 0, successes: null });
    expect(parseResultRecordRequest({ drillId: UUID_A, attempts: 5, successes: 5 })).toMatchObject({ successes: 5 });
    expect(parseResultRecordRequest({ drillId: UUID_A, selfRating: 1 })).toMatchObject({ selfRating: 1 });
    expect(parseResultRecordRequest({ drillId: UUID_A, note: "x" })).toMatchObject({ note: "x" });
    for (const bad of [
      { drillId: UUID_A },
      { drillId: UUID_A, attempts: null, selfRating: null, note: null },
      { drillId: UUID_A, attempts: 5, successes: 6 },
      { drillId: UUID_A, successes: 0 },
      { drillId: UUID_A, attempts: 1001 },
      { drillId: UUID_A, selfRating: 5.5 },
      { drillId: UUID_A, attempts: 1, planId: UUID_B },
      { drillId: UUID_A, attempts: 1, evidenceType: "user_entered" },
      { drillId: UUID_A, attempts: 1, recordedAt: "2026-01-01" },
    ]) {
      expect(parseResultRecordRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("list queries", () => {
  it("accepts no filter or exactly one known status", () => {
    const u = (q: string) => new URL(`https://x.test/p${q}`);
    expect(parsePlanListQuery(u(""))).toEqual({ ok: true, status: null });
    expect(parsePlanListQuery(u("?status=archived"))).toEqual({ ok: true, status: "archived" });
    expect(parsePlanListQuery(u("?status=in_progress"))).toEqual({ ok: false });
    expect(parseSessionListQuery(u("?status=in_progress"))).toEqual({ ok: true, status: "in_progress" });
    expect(parseSessionListQuery(u("?status=completed&status=abandoned"))).toEqual({ ok: false });
    expect(parseSessionListQuery(u("?page=2"))).toEqual({ ok: false });
  });
});

// ─── Function outcomes ────────────────────────────────────────────────────────

describe("function outcomes", () => {
  it("accepts exactly the documented outcomes", () => {
    expect(parsePlanCreateOutcome({ outcome: "created", plan_id: UUID_A })).toEqual({ outcome: "created", planId: UUID_A });
    expect(parsePlanCreateOutcome({ outcome: "drill_not_found" })).toEqual({ outcome: "drill_not_found" });
    expect(parsePlanCreateOutcome({ outcome: "created" })).toBeNull();
    expect(parsePlanCreateOutcome({ outcome: "session_not_found" })).toBeNull();
    expect(parsePlanCreateOutcome(null)).toBeNull();
    expect(parseResultRecordOutcome({ outcome: "replayed", result_id: UUID_B })).toEqual({
      outcome: "replayed",
      resultId: UUID_B,
    });
    expect(parseResultRecordOutcome({ outcome: "plan_item_invalid" })).toEqual({ outcome: "plan_item_invalid" });
    expect(parseResultRecordOutcome({ outcome: "whatever" })).toBeNull();
  });
});

// ─── DTOs ─────────────────────────────────────────────────────────────────────

describe("row → DTO", () => {
  const planRow = {
    id: UUID_A,
    title: "T",
    focus: null,
    origin: "golfer",
    status: "active",
    archived_at: null,
    created_at: "2026-09-30T00:00:00Z",
    updated_at: "2026-09-30T00:00:00Z",
    user_id: UUID_B,
    idempotency_key: KEY,
    request_fingerprint: "f".repeat(64),
  };

  it("maps a plan and drops owner and idempotency bookkeeping", () => {
    const dto = toPlanDto(planRow);
    expect(dto).toEqual({
      id: UUID_A,
      title: "T",
      focus: null,
      origin: "golfer",
      status: "active",
      archivedAt: null,
      createdAt: "2026-09-30T00:00:00Z",
      updatedAt: "2026-09-30T00:00:00Z",
    });
    expect(JSON.stringify(dto)).not.toMatch(/user|idempotency|fingerprint/i);
  });

  it("refuses a row that does not match the schema", () => {
    expect(toPlanDto({ ...planRow, origin: "coach" })).toBeNull();
    expect(toPlanDto({ ...planRow, status: "deleted" })).toBeNull();
    expect(toPlanItemDto({ id: UUID_A, drill_id: UUID_B, position: 0, target_reps: null, target_note: null })).toBeNull();
    expect(
      toSessionDto({ id: UUID_A, plan_id: null, status: "paused", started_at: "x", ended_at: null, notes: null, created_at: "x" }),
    ).toBeNull();
  });

  it("maps a result only when it is user-entered", () => {
    const row = {
      id: UUID_A,
      session_id: UUID_B,
      plan_id: null,
      plan_item_id: null,
      drill_id: UUID_A,
      evidence_type: "user_entered",
      attempts: 3,
      successes: 1,
      self_rating: null,
      note: null,
      recorded_at: "2026-09-30T00:00:00Z",
      user_id: UUID_B,
    };
    expect(toResultDto(row)).toMatchObject({ evidenceType: "user_entered", attempts: 3, successes: 1 });
    expect(toResultDto({ ...row, evidence_type: "measured" })).toBeNull();
    expect(toResultDto({ ...row, evidence_type: "ai_inference" })).toBeNull();
    expect(JSON.stringify(toResultDto(row))).not.toContain("userId");
  });

  it("never answers with a partial list", () => {
    expect(mapAll([planRow, { ...planRow, status: "x" }], toPlanDto)).toBeNull();
    expect(mapAll(null, toPlanDto)).toBeNull();
    expect(mapAll([planRow], toPlanDto)).toHaveLength(1);
  });
});

// ─── Paged reads ──────────────────────────────────────────────────────────────

describe("readAllPages", () => {
  it("reads until a short page and returns every row", async () => {
    const total = READ_PAGE_SIZE * 2 + 3;
    const ranges: [number, number][] = [];
    const rows = await readAllPages(async (from, to) => {
      ranges.push([from, to]);
      return { data: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i), error: null };
    });
    expect(rows).toHaveLength(total);
    expect(ranges[0]).toEqual([0, READ_PAGE_SIZE - 1]);
    expect(ranges).toHaveLength(3);
  });

  it("fails closed on an error or when the page limit is reached", async () => {
    expect(await readAllPages(async () => ({ data: null, error: { code: "x" } }))).toBeNull();
    let calls = 0;
    const full = await readAllPages(async () => {
      calls += 1;
      return { data: new Array(READ_PAGE_SIZE).fill(0), error: null };
    });
    expect(full).toBeNull();
    expect(calls).toBe(READ_PAGE_LIMIT);
  });
});

// ─── Progress ─────────────────────────────────────────────────────────────────

describe("derivePlanProgress", () => {
  const items = [
    { id: "i1", drillId: "d1" },
    { id: "i2", drillId: "d2" },
  ];
  const sessions = [
    { id: "s1", status: "completed" },
    { id: "s2", status: "completed" },
    { id: "s3", status: "abandoned" },
    { id: "s4", status: "in_progress" },
  ];
  const r = (sessionId: string, planItemId: string | null, attempts: number | null, successes: number | null, recordedAt: string) => ({
    sessionId,
    planItemId,
    attempts,
    successes,
    recordedAt,
  });

  it("is empty-safe: nothing recorded is null, not zero", () => {
    expect(derivePlanProgress(items, [], [])).toEqual([
      { planItemId: "i1", drillId: "d1", completedSessionCount: 0, totalAttempts: null, totalSuccesses: null, lastPracticedAt: null },
      { planItemId: "i2", drillId: "d2", completedSessionCount: 0, totalAttempts: null, totalSuccesses: null, lastPracticedAt: null },
    ]);
  });

  it("counts distinct completed sessions and sums only recorded values", () => {
    const [p1, p2] = derivePlanProgress(items, sessions, [
      r("s1", "i1", 10, 4, "2026-09-30T10:00:00Z"),
      r("s1", "i1", 5, null, "2026-09-30T10:05:00Z"),
      r("s2", "i1", null, null, "2026-09-30T11:00:00+00:00"),
      r("s3", "i1", 100, 100, "2026-09-30T12:00:00Z"),
      r("s4", "i1", 100, 100, "2026-09-30T13:00:00Z"),
      r("s1", null, 7, 7, "2026-09-30T14:00:00Z"),
      r("s2", "i2", 0, 0, "2026-09-30T09:00:00Z"),
      r("unknown", "i2", 9, 9, "2026-09-30T15:00:00Z"),
    ]);
    expect(p1).toEqual({
      planItemId: "i1",
      drillId: "d1",
      completedSessionCount: 2,
      totalAttempts: 15,
      totalSuccesses: 4,
      lastPracticedAt: "2026-09-30T11:00:00+00:00",
    });
    expect(p2).toEqual({
      planItemId: "i2",
      drillId: "d2",
      completedSessionCount: 1,
      totalAttempts: 0,
      totalSuccesses: 0,
      lastPracticedAt: "2026-09-30T09:00:00Z",
    });
  });

  it("reports counts and sums only — no percentage, score or rate", () => {
    const [p] = derivePlanProgress(items, sessions, [r("s1", "i1", 10, 5, "2026-09-30T10:00:00Z")]);
    expect(Object.keys(p).sort()).toEqual([
      "completedSessionCount",
      "drillId",
      "lastPracticedAt",
      "planItemId",
      "totalAttempts",
      "totalSuccesses",
    ]);
  });

  it("does not mutate its inputs", () => {
    const results = [r("s1", "i1", 1, 1, "2026-09-30T10:00:00Z")];
    const snapshot = JSON.stringify([items, sessions, results]);
    derivePlanProgress(items, sessions, results);
    expect(JSON.stringify([items, sessions, results])).toBe(snapshot);
  });
});
