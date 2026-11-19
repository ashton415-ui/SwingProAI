import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope
// (the same arrangement as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-02 — My Bag page, rendered for real against a fake caller-scoped
 * client (no network, no database). Each table read is a controllable thenable
 * that records the query it was built from, so the tests can also hold one read
 * open on purpose.
 *
 * This file deliberately imports nothing added by GJ-PARALLEL-02, so it also
 * runs against the accepted pre-change page as a control.
 */

type Outcome =
  | { kind: "rows"; rows: unknown[] }
  | { kind: "error"; withRows?: boolean }
  | { kind: "reject" }
  | { kind: "throw" } // the client throws while the query is being built
  | { kind: "null" }
  | { kind: "held"; gate: Promise<unknown> };

interface Call { table: string; ops: unknown[][]; signal?: AbortSignal }
let outcomes: Record<string, Outcome> = {};
let calls: Call[] = [];
let throwOnCreate = false;
const ERROR = { message: 'permission denied for table "user_equipment" (synthetic 42501)', code: "42501" };

function fakeServerClient() {
  if (throwOnCreate) throw new Error("supabaseUrl is required (synthetic)");
  return {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const outcome = outcomes[table];
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "not", "order"]) {
        builder[op] = (...args: unknown[]) => {
          if (outcome.kind === "throw" && op === "select") throw new Error("synthetic client failure while building");
          call.ops.push([op, ...args]);
          return builder;
        };
      }
      builder.abortSignal = (signal: AbortSignal) => { call.signal = signal; return builder; };
      builder.then = (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) => {
        const settle = (): Promise<unknown> => {
          switch (outcome.kind) {
            case "rows": return Promise.resolve({ data: outcome.rows, error: null });
            case "error": return Promise.resolve({ data: outcome.withRows ? (table === "user_equipment" ? CLUBS : TELEMETRY) : null, error: ERROR });
            case "null": return Promise.resolve({ data: null, error: null });
            case "reject": return Promise.reject(new Error("TypeError: fetch failed (synthetic 10.9.9.9)"));
            case "held": return outcome.gate.then(() => ({ data: [], error: null }));
            default: return Promise.reject(new Error("unreachable"));
          }
        };
        return settle().then(onFulfilled, onRejected);
      };
      return builder;
    },
  };
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => fakeServerClient()),
  getServerSession: vi.fn(async () => ({ access_token: "synthetic", user: { id: "golfer-1", email: null } })),
}));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) })); // the remove handler is not exercised
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

import BagPage from "@/app/(dashboard)/bag/page";
import { getServerSession } from "@/utils/supabase/server";

const EQUIPMENT_SELECT = "id, club_type, club_designation, brand, model, shaft_flex, shaft_weight, loft_deg, custom_club, custom_brand, custom_model, is_primary, created_at";
const club = (id: string, over: Record<string, unknown> = {}) => ({
  id, club_type: "Iron", club_designation: "7", brand: "Synthetic", model: `Model ${id}`, shaft_flex: "Regular", shaft_weight: 95,
  loft_deg: 34, custom_club: false, custom_brand: null, custom_model: null, is_primary: false, created_at: "2026-10-01T00:00:00Z", ...over,
});
const CLUBS = [club("c-driver", { club_type: "Driver", club_designation: null, model: "Driver One", loft_deg: 10.5 }), club("c-7i")];
const TELEMETRY = [
  { club_id: "c-driver", swing_speed_mph: 112, ball_speed_mph: 168, smash_factor: 1.5, launch_angle_deg: 12, carry_yards: 280, created_at: "2026-10-03" },
  { club_id: "c-driver", swing_speed_mph: 90, ball_speed_mph: 120, smash_factor: 1.3, launch_angle_deg: 10, carry_yards: 200, created_at: "2026-10-02" }, // older: ignored
  { club_id: "c-7i", swing_speed_mph: 82, ball_speed_mph: 112, smash_factor: 1.39, launch_angle_deg: 18, carry_yards: 160, created_at: "2026-10-03" },
];

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}
async function render() {
  const html = renderToStaticMarkup(await BagPage());
  return { html, text: text(html) };
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
function deferred() { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; }

beforeEach(() => {
  calls = [];
  throwOnCreate = false;
  outcomes = { user_equipment: { kind: "rows", rows: CLUBS }, swing_telemetry: { kind: "rows", rows: TELEMETRY } };
});

describe("My Bag — both reads succeed", () => {
  it("populated: clubs grouped by type, newest telemetry per club, existing ratings and average unchanged", async () => {
    const { text: t } = await render();
    expect(t).toMatch(/Driver\s*1 · 1 tracked/);
    expect(t).toMatch(/Iron\s*1 · 1 tracked/);
    expect(t).toContain("Synthetic Driver One");
    expect(t).toContain("112 mph");        // newest driver row, not the older 90 mph
    expect(t).not.toContain("90 mph");
    expect(t).toContain("280 yds");
    expect(t).toContain("excellent");      // smash 1.5 → excellent (existing thresholds)
    expect(t).toContain("average");        // smash 1.39 → average
    expect(t).toMatch(/Bag avg swing speed\s*97\.0 mph/); // (112 + 82) / 2
    expect(t).toContain("2 clubs · 2 tracked");
    expect(t).not.toMatch(/didn.t load|Your bag is empty/);
  });

  it("genuinely empty: the empty bag with Add First Club", async () => {
    outcomes = { user_equipment: { kind: "rows", rows: [] }, swing_telemetry: { kind: "rows", rows: [] } };
    const { text: t } = await render();
    expect(t).toContain("Your bag is empty");
    expect(t).toContain("Add First Club");
    expect(t).not.toMatch(/didn.t load/);
  });

  it("clubs but no telemetry rows: real clubs with a genuine no-data state", async () => {
    outcomes.swing_telemetry = { kind: "rows", rows: [] };
    const { text: t } = await render();
    expect(t).toContain("Synthetic Driver One");
    expect((t.match(/No data/g) ?? []).length).toBe(2);
    expect(t).toContain("2 clubs · 0 tracked");
    expect(t).not.toMatch(/didn.t load|mph/);
  });

  it("the reads are unchanged: same tables, columns, owner and archive filters, ordering", async () => {
    await render();
    const eq = calls.find((c) => c.table === "user_equipment")!;
    const tel = calls.find((c) => c.table === "swing_telemetry")!;
    expect(eq.ops).toEqual([["select", EQUIPMENT_SELECT], ["eq", "user_id", "golfer-1"], ["eq", "is_archived", false], ["order", "created_at", { ascending: true }]]);
    expect(tel.ops).toEqual([["select", "*"], ["eq", "user_id", "golfer-1"], ["not", "club_id", "is", null], ["order", "created_at", { ascending: false }]]);
    expect(calls).toHaveLength(2);
  });
});

describe("My Bag — a failed read is unavailable, never an empty bag or zero", () => {
  const FAILURES: [string, Outcome][] = [
    ["returned error (no rows)", { kind: "error" }],
    ["returned error carrying real rows", { kind: "error", withRows: true }],
    ["rejected read", { kind: "reject" }],
    ["thrown while building", { kind: "throw" }],
    ["no row array", { kind: "null" }],
  ];
  for (const table of ["user_equipment", "swing_telemetry"]) {
    for (const [name, outcome] of FAILURES) {
      it(`${table}: ${name}`, async () => {
        outcomes[table] = outcome;
        const { html, text: t } = await render();
        expect(t).toContain("Your bag didn't load");
        expect(html).toContain('role="alert"');
        expect(html).toMatch(/<button type="button"[^>]*>.*Try again/);
        expect(t).not.toMatch(/Your bag is empty|Add First Club|No data|tracked|mph|yds|Bag avg|Virtual Bag|\b0 clubs?\b/);
        expect(t).not.toMatch(/Synthetic|Driver One|Model c-7i/); // rows that came with an error are never shown
        expect(html).not.toMatch(/permission|42501|fetch failed|10\.9\.9\.9|synthetic client failure/);
      });
    }
  }

  it("the client cannot be built (after the unchanged session decision): unavailable", async () => {
    throwOnCreate = true;
    const { text: t } = await render();
    expect(t).toContain("Your bag didn't load");
    expect(calls).toHaveLength(0);
  });

  it("the honest copy: no promise of AI shaft fitting anywhere on the page", async () => {
    for (const rows of [CLUBS, []]) {
      outcomes.user_equipment = { kind: "rows", rows };
      const { text: t } = await render();
      expect(t).not.toMatch(/shaft fitting|fitting recommendations/i);
    }
  });
});

describe("My Bag — a known failure does not wait for the other read (six cases)", () => {
  for (const failing of ["user_equipment", "swing_telemetry"]) {
    const other = failing === "user_equipment" ? "swing_telemetry" : "user_equipment";
    for (const [name, outcome] of [["throw", { kind: "throw" }], ["reject", { kind: "reject" }], ["returned error", { kind: "error" }]] as [string, Outcome][]) {
      it(`${failing} ${name}, ${other} held open: the error view renders before release, and the held read is cancelled`, async () => {
        const held = deferred();
        outcomes[failing] = outcome;
        outcomes[other] = { kind: "held", gate: held.gate };
        let resolved = false;
        const page = BagPage().then((el) => { resolved = true; return el; });
        page.catch(() => {});
        await flush();
        expect(resolved).toBe(true); // the page resolved (not rejected) while the other read is still open
        const signal = calls.find((c) => c.table === other)?.signal;
        expect(signal?.aborted).toBe(true);
        held.release();
        const t = text(renderToStaticMarkup(await page));
        expect(t).toContain("Your bag didn't load");
        expect(t).not.toMatch(/Your bag is empty|No data|tracked/);
      });
    }
  }
});

describe("My Bag — authentication still decides first", () => {
  it("no session: the login redirect propagates and nothing is read", async () => {
    vi.mocked(getServerSession).mockResolvedValueOnce(null);
    await expect(BagPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(calls).toHaveLength(0);
  });

  it("an Auth verification outage propagates instead of becoming the 'didn't load' view", async () => {
    vi.mocked(getServerSession).mockRejectedValueOnce(new Error("Supabase Auth verification is unavailable."));
    await expect(BagPage()).rejects.toThrow("Supabase Auth verification is unavailable.");
    expect(calls).toHaveLength(0);
  });
});
