import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope
// (the same arrangement as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-01 — Progress Hub read and count states, exercised by rendering
 * the real server page against a mocked caller-scoped client (no network, no
 * database). A failed or thrown read must not render as an empty history or a
 * zero count; the count names its bounded window; the existing score, family,
 * tempo and status presentation is unchanged.
 *
 * This file deliberately imports nothing added by GJ-PARALLEL-01, so it can
 * also run against the unchanged base page as a control.
 */

type Scenario =
  | { kind: "rows"; rows: Record<string, unknown>[] }
  | { kind: "error" }
  | { kind: "reject" }
  | { kind: "throw_on_from" }
  | { kind: "null_data" };

let scenario: Scenario = { kind: "rows", rows: [] };
/** A1: the status read the page makes (read_analysis_job_states); null = the fake has no reader (the read fails). */
let statusRead: null | ((ids: string[]) => { data: unknown; error: unknown }) = null;
interface Call { table?: string; select?: string; eq?: unknown[]; order?: unknown[]; limit?: number }
let calls: Call[] = [];
const refresh = vi.fn();

function fakeClient() {
  return {
    ...(statusRead ? { rpc: async (_fn: string, args: { p_ids: string[] }) => statusRead!(args.p_ids) } : {}),
    from(table: string) {
      if (scenario.kind === "throw_on_from") throw new Error("client exploded at https://project.supabase.co key=abc");
      const call: Call = { table };
      calls.push(call);
      // Only the read-builder methods the page uses exist: any write method would throw.
      const builder = {
        select(columns: string) { call.select = columns; return builder; },
        eq(...args: unknown[]) { call.eq = args; return builder; },
        order(...args: unknown[]) { call.order = args; return builder; },
        limit(count: number) {
          call.limit = count;
          if (scenario.kind === "reject") return Promise.reject(new Error("TypeError: fetch failed (10.1.2.3:443)"));
          if (scenario.kind === "error") {
            return Promise.resolve({ data: null, error: { message: 'permission denied for table "swing_analysis"', code: "42501" } });
          }
          if (scenario.kind === "null_data") return Promise.resolve({ data: null, error: null });
          if (scenario.kind === "rows") return Promise.resolve({ data: scenario.rows, error: null });
          throw new Error("unreachable");
        },
      };
      return builder;
    },
  };
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => fakeClient()),
  getServerSession: vi.fn(async () => ({ access_token: "synthetic", user: { id: "golfer-1", email: null } })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

import DashboardPage from "@/app/(dashboard)/dashboard/page";
import { getServerSession } from "@/utils/supabase/server";

const SELECT = "id, user_id, status, score, tempo_ratio, created_at, analysis_family, equipment_snapshot, swing_video:swing_videos(club, status, created_at)";

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `a-${n}`, user_id: "golfer-1", status: "complete", score: 80, tempo_ratio: 3,
    created_at: `2026-10-${String(10 + n).padStart(2, "0")}T12:00:00Z`, analysis_family: "full_swing",
    equipment_snapshot: null, swing_video: { club: "7 iron", status: "complete", created_at: "2026-10-01T00:00:00Z" },
    ...over,
  };
}

async function render(s: Scenario) {
  scenario = s;
  const html = renderToStaticMarkup(await DashboardPage());
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return { html, text };
}

beforeEach(() => {
  calls = [];
  statusRead = null;
  refresh.mockClear();
});

describe("Progress Hub — successful reads", () => {
  it("zero rows: a genuine empty history with a zero recent count, labelled as the bounded window", async () => {
    const { text } = await render({ kind: "rows", rows: [] });
    expect(text).toContain("Recent Analyses");
    expect(text).toContain("Up to 10 most recent");
    expect(text).toMatch(/Recent Analyses 0 Up to 10 most recent/);
    expect(text).toContain("Telemetry Array Empty");
    expect(text).toContain("Upload First Swing");
    expect(text).not.toMatch(/Lifetime|Total Analyses|didn.t load|Try again/);
  });

  it("one row: count 1 and the row rendered", async () => {
    const { html, text } = await render({ kind: "rows", rows: [row(1, { score: 82, tempo_ratio: 2.96 })] });
    expect(text).toMatch(/Recent Analyses 1 Up to 10 most recent/);
    expect(text).toContain("82 pts");
    expect(html).toContain('href="/swings/a-1"');
    expect(text).not.toMatch(/Lifetime|Telemetry Array Empty|didn.t load/);
  });

  it("ten rows (the bound): count 10, still described as up to 10 most recent, never as lifetime", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    const { html, text } = await render({ kind: "rows", rows });
    expect(text).toMatch(/Recent Analyses 10 Up to 10 most recent/);
    expect(html.match(/href="\/swings\/a-\d+"/g)?.length).toBe(20); // phone list + table, 10 each
    expect(text).not.toMatch(/Lifetime|Total Analyses/);
  });

  it("the query itself is unchanged: same table, columns, owner filter, order and limit 10; one read only", async () => {
    await render({ kind: "rows", rows: [] });
    expect(calls).toEqual([{
      table: "swing_analysis", select: SELECT, eq: ["user_id", "golfer-1"],
      order: ["created_at", { ascending: false }], limit: 10,
    }]);
  });
});

describe("Progress Hub — failed reads are unavailable, not empty", () => {
  const FAILURES: Scenario[] = [{ kind: "error" }, { kind: "reject" }, { kind: "throw_on_from" }, { kind: "null_data" }];

  for (const failure of FAILURES) {
    it(`${failure.kind}: withholds stats and log, shows a read-only Try again, leaks no detail`, async () => {
      const { html, text } = await render(failure);
      expect(text).toContain("Progress Hub");
      expect(html).toContain('href="/analyze"');
      expect(html).toContain('role="alert"');
      expect(text).toContain("Your analyses didn't load");
      expect(text).toContain("so your stats aren't shown");
      expect(html).toMatch(/<button type="button"[^>]*>.*Try again/);
      // nothing that reads as an empty history, a zero count or a derived statistic
      expect(text).not.toMatch(/Telemetry Array Empty|Upload First Swing|Recent Analyses|Total Analyses|Lifetime|Avg Tempo|Avg Swing Score| pts\b/);
      expect(text).not.toMatch(/\b0\b/);
      // no raw error text, host, key or code
      expect(html).not.toMatch(/permission|42501|fetch failed|10\.1\.2\.3|supabase\.co|key=|exploded/);
      expect(refresh).not.toHaveBeenCalled();
    });
  }
});

describe("Progress Hub — authentication still decides before any read", () => {
  it("no session: the login redirect propagates, nothing is read, no Try again is rendered", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);
    scenario = { kind: "error" };
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(calls).toHaveLength(0);
  });

  it("an Auth verification outage propagates instead of becoming the 'didn't load' panel", async () => {
    vi.mocked(getServerSession).mockRejectedValueOnce(new Error("Supabase Auth verification is unavailable."));
    scenario = { kind: "rows", rows: [] };
    await expect(DashboardPage()).rejects.toThrow("Supabase Auth verification is unavailable.");
    expect(calls).toHaveLength(0);
  });
});

describe("Progress Hub — existing presentation invariants are unchanged", () => {
  const MIXED = [
    row(1, { score: 82, tempo_ratio: 2.96, analysis_family: "full_swing" }),
    row(2, { score: 55, tempo_ratio: 1.5, analysis_family: "putting" }),
    row(3, { score: 70, tempo_ratio: 3.2, analysis_family: null }),
    row(4, { score: null, tempo_ratio: null, analysis_family: "full_swing", status: null }),
    row(5, { score: Number.NaN, tempo_ratio: Number.POSITIVE_INFINITY, analysis_family: "full_swing", status: "failed" }),
  ];

  it("averages use only full-swing-compatible finite observations (putting, null and non-finite excluded)", async () => {
    const { text } = await render({ kind: "rows", rows: MIXED });
    // score: (82 + 70) / 2 = 76; tempo: (2.96 + 3.2) / 2 = 3.08 -> "3.1"
    expect(text).toMatch(/Avg Tempo Ratio 3\.1 Target: 3\.0 : 1/);
    expect(text).toMatch(/Avg Swing Score 76/);
  });

  it("the count is the number of rows read (all five, whatever their family or score)", async () => {
    const { text } = await render({ kind: "rows", rows: MIXED });
    expect(text).toMatch(/Recent Analyses 5 Up to 10 most recent/);
  });

  it("a putt shows no full-swing score or tempo; null family is labelled Full Swing; a row whose status cannot be read says so (A1)", async () => {
    const { text } = await render({ kind: "rows", rows: MIXED });
    expect(text).toContain("82 pts");
    expect(text).toContain("70 pts");
    expect(text).not.toContain("55 pts");
    expect(text).not.toContain("1.5");
    expect((text.match(/Putting/g) ?? []).length).toBe(2); // phone + table label for the one putt
    expect((text.match(/Full Swing/g) ?? []).length).toBe(8); // four full-swing-compatible rows, twice each
    // A1: this fake has no status reader, so the two rows that are not complete read as unavailable (never as the
    // stored status: P2 showed "pending" for the null status and "failed" here)
    expect(text.match(/Status unavailable/g) ?? []).toHaveLength(4); // two rows, phone list + table
    expect(text).not.toMatch(/pending|Not analyzed yet/);
  });

  it("absent scores render neutral, never the red band", async () => {
    const { html } = await render({ kind: "rows", rows: [row(4, { score: null })] });
    expect(html).toContain("text-gray-600 border-white/5");
    expect(html).not.toContain("text-red-400 border-red-500/20");
  });
});

describe("A1 — each row's label comes from the status read; a read that fails says so", () => {
  const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const rows = [
    row(1, { id: U(1), status: "pending", score: null, tempo_ratio: null }),
    row(2, { id: U(2), status: "failed", score: null, tempo_ratio: null }),
    row(3, { id: U(3), status: "pending", score: null, tempo_ratio: null }),
    row(4, { id: U(4), status: "complete" }),
    row(5, { id: U(5), status: "pending", score: null, tempo_ratio: null }),
  ];
  const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

  it("a confirmed absence of work reads Not analyzed yet, a failed attempt Failed, an accepted one Queued; a row the read did not answer says Status unavailable", async () => {
    statusRead = (ids) => ({
      data: [
        { analysisId: U(1), execution: "idle", attempt: null },
        { analysisId: U(2), execution: "failed", attempt: null },
        { analysisId: U(3), execution: "queued", attempt: null },
        { analysisId: U(4), execution: "complete", attempt: null },
      ].filter((s) => ids.includes(s.analysisId)),
      error: null,
    });
    const { text } = await render({ kind: "rows", rows });
    expect(count(text, /Not analyzed yet/g)).toBe(2); // phone list + table
    expect(count(text, /Failed/g)).toBe(2);
    expect(count(text, /Queued/g)).toBe(2);
    expect(count(text, /Status unavailable/g)).toBe(2); // row 5: no answer for it
    expect(calls).toHaveLength(1); // the status read is an RPC; the history read is unchanged
  });

  it("a failed status read: every row that is not complete says Status unavailable (never Not analyzed yet); a completed one stays Complete", async () => {
    statusRead = () => ({ data: null, error: { message: "permission denied for function read_analysis_job_states", code: "42501" } });
    const { text } = await render({ kind: "rows", rows });
    expect(count(text, /Status unavailable/g)).toBe(8);
    expect(text).not.toMatch(/Not analyzed yet|Queued/);
    expect(text).not.toContain("permission denied");
  });
});
