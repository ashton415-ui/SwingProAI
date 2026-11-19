import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDrillHubLoader,
  readDrillHub,
  DRILL_HUB_UNAVAILABLE_COPY,
  type DrillHubRead,
  type DrillHubResult,
  type DrillHubState,
  type ListReadResponse,
} from "@/lib/golfer-journey-read-state";
import DrillsPage from "@/app/(dashboard)/drills/page";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope
// (the same arrangement as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-01 — Drill Hub loading. The catalog and the golfer's progress are
 * read together; the hub is ready only when both succeed. A failure of either
 * (returned error, rejection, throw, client construction) is one finite
 * "unavailable" state that carries no drills, statuses, counts or error text.
 * Try again reuses one loader: no stacked reads, no stale or post-unmount
 * completion replacing newer state.
 */

interface Drill { id: string; name: string; target_metric: string; the_why: string; the_how: string; the_feel: string }
interface UserDrill { drill_id: string; status: "pending" | "submitted" | "verified" | "needs_work"; latest_ai_feedback: string | null }

const DRILLS: Drill[] = [
  { id: "d-1", name: "Gate Drill", target_metric: "club_path", the_why: "w", the_how: "h", the_feel: "f" },
  { id: "d-2", name: "Pump Drill", target_metric: "lag", the_why: "w", the_how: "h", the_feel: "f" },
];
const PROGRESS: UserDrill[] = [{ drill_id: "d-1", status: "verified", latest_ai_feedback: "Nice." }];
const SQL_ERROR = { message: 'relation "public.user_drills" permission denied; JWT expired for 7f3c', code: "42501" };

const ok = <T,>(data: T[]): (() => Promise<ListReadResponse<T>>) => () => Promise.resolve({ data, error: null });
const failed = <T,>(): (() => Promise<ListReadResponse<T>>) => () => Promise.resolve({ data: null, error: SQL_ERROR });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function recorder() {
  const states: DrillHubState<Drill, UserDrill>[] = [];
  return { states, publish: (s: DrillHubState<Drill, UserDrill>) => states.push(s) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// R1: readDrillHub returns { result, settled }; these classification tests look at the result.
const hub = <D, P>(make: Parameters<typeof readDrillHub<D, P>>[0]) => readDrillHub<D, P>(make).result;
// R1: a loader read returns { result, settled }; a plain promise is both.
const asRead = (p: Promise<DrillHubResult<Drill, UserDrill>>): DrillHubRead<Drill, UserDrill> => ({ result: p, settled: p.then(() => undefined, () => undefined) });

describe("readDrillHub — classification of the two reads", () => {
  it("both reads succeed: ready with the catalog and the progress", async () => {
    await expect(hub(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }))).resolves.toEqual({
      phase: "ready", drills: DRILLS, progress: PROGRESS,
    });
  });

  it("a genuinely empty catalog with successful progress is ready and empty (not an error)", async () => {
    await expect(hub(() => ({ catalog: ok<Drill>([]), progress: ok<UserDrill>([]) }))).resolves.toEqual({
      phase: "ready", drills: [], progress: [],
    });
  });

  it("successful catalog with no progress rows yet is ready (every drill genuinely not started)", async () => {
    await expect(hub(() => ({ catalog: ok(DRILLS), progress: ok<UserDrill>([]) }))).resolves.toEqual({
      phase: "ready", drills: DRILLS, progress: [],
    });
  });

  it("catalog returns an error: unavailable", async () => {
    await expect(hub(() => ({ catalog: failed<Drill>(), progress: ok(PROGRESS) }))).resolves.toEqual({ phase: "unavailable" });
  });

  it("progress returns an error: unavailable — never ready with empty progress (which would read as all pending, 0 verified)", async () => {
    const result = await hub(() => ({ catalog: ok(DRILLS), progress: failed<UserDrill>() }));
    expect(result).toEqual({ phase: "unavailable" });
    expect(result).not.toHaveProperty("drills");
    expect(result).not.toHaveProperty("progress");
  });

  it("both reads return errors: unavailable", async () => {
    await expect(hub(() => ({ catalog: failed<Drill>(), progress: failed<UserDrill>() }))).resolves.toEqual({ phase: "unavailable" });
  });

  it("a rejected catalog or progress promise is unavailable and does not reject", async () => {
    await expect(hub(() => ({ catalog: () => Promise.reject(new Error("TypeError: Failed to fetch")), progress: ok(PROGRESS) })))
      .resolves.toEqual({ phase: "unavailable" });
    await expect(hub(() => ({ catalog: ok(DRILLS), progress: () => Promise.reject(new Error("socket hang up")) })))
      .resolves.toEqual({ phase: "unavailable" });
  });

  it("a read function that throws synchronously is unavailable", async () => {
    await expect(hub(() => ({ catalog: () => { throw new Error("bad query"); }, progress: ok(PROGRESS) })))
      .resolves.toEqual({ phase: "unavailable" });
  });

  it("client construction (or a missing session) that throws is unavailable, and does not reject", async () => {
    const makeReads = vi.fn((): never => { throw new Error("supabaseUrl is required."); });
    await expect(hub<Drill, UserDrill>(makeReads)).resolves.toEqual({ phase: "unavailable" });
    expect(makeReads).toHaveBeenCalledTimes(1);
  });

  it("null data without an error is unavailable, not an empty catalog", async () => {
    await expect(hub(() => ({ catalog: () => Promise.resolve({ data: null, error: null }), progress: ok(PROGRESS) })))
      .resolves.toEqual({ phase: "unavailable" });
  });

  it("no error text from either read reaches the result", async () => {
    const result = await hub(() => ({ catalog: failed<Drill>(), progress: () => Promise.reject(new Error("JWT 7f3c")) }));
    expect(JSON.stringify(result)).not.toMatch(/relation|permission|JWT|7f3c|42501|fetch/i);
  });
});

describe("createDrillHubLoader — one finite load at a time", () => {
  it("publishes loading, then exactly one ready result", async () => {
    const { states, publish } = recorder();
    const loader = createDrillHubLoader((signal) => readDrillHub(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }), signal), publish);
    expect(loader.load()).toBe(true);
    expect(states).toEqual([{ phase: "loading" }]);
    await flush();
    expect(states).toEqual([{ phase: "loading" }, { phase: "ready", drills: DRILLS, progress: PROGRESS }]);
  });

  it("a thrown or rejected read ends in a finite unavailable state (no permanent loading, no unhandled rejection)", async () => {
    for (const read of [
      () => { throw new Error("sync"); },
      () => ({ result: Promise.reject(new Error("async")), settled: Promise.resolve() }),
    ] as (() => DrillHubRead<Drill, UserDrill>)[]) {
      const { states, publish } = recorder();
      const loader = createDrillHubLoader(read, publish);
      loader.load();
      await flush();
      expect(states).toEqual([{ phase: "loading" }, { phase: "unavailable" }]);
      expect(loader.load()).toBe(true); // not stuck pending
    }
  });

  it("Try again after a failure clears the error (publishes loading) and recovers to ready", async () => {
    const { states, publish } = recorder();
    let attempt = 0;
    const loader = createDrillHubLoader((signal) => {
      attempt++;
      return readDrillHub(() => ({ catalog: ok(DRILLS), progress: attempt === 1 ? failed<UserDrill>() : ok(PROGRESS) }), signal);
    }, publish);
    loader.load();
    await flush();
    expect(states.at(-1)).toEqual({ phase: "unavailable" });
    expect(loader.load()).toBe(true);
    expect(states.at(-1)).toEqual({ phase: "loading" });
    await flush();
    expect(states).toEqual([
      { phase: "loading" }, { phase: "unavailable" },
      { phase: "loading" }, { phase: "ready", drills: DRILLS, progress: PROGRESS },
    ]);
  });

  it("repeated Try again while a load is pending does not stack reads", async () => {
    const { states, publish } = recorder();
    const gate = deferred<DrillHubResult<Drill, UserDrill>>();
    const read = vi.fn(() => asRead(gate.promise));
    const loader = createDrillHubLoader(read, publish);
    expect(loader.load()).toBe(true);
    expect(loader.load()).toBe(false);
    expect(loader.load()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ phase: "loading" }]);
    gate.resolve({ phase: "unavailable" });
    await flush();
    expect(states).toEqual([{ phase: "loading" }, { phase: "unavailable" }]);
    expect(loader.load()).toBe(true); // allowed again once settled
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a completion after dispose (unmount) is dropped, and a disposed loader starts nothing", async () => {
    const { states, publish } = recorder();
    const gate = deferred<DrillHubResult<Drill, UserDrill>>();
    const read = vi.fn(() => asRead(gate.promise));
    const loader = createDrillHubLoader(read, publish);
    loader.load();
    loader.dispose();
    gate.resolve({ phase: "ready", drills: DRILLS, progress: PROGRESS });
    await flush();
    expect(states).toEqual([{ phase: "loading" }]);
    expect(loader.load()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a stale load from a disposed mount cannot replace the newer mount's state (React StrictMode remount)", async () => {
    const { states, publish } = recorder(); // one page state, two mounts
    const first = deferred<DrillHubResult<Drill, UserDrill>>();
    const second = deferred<DrillHubResult<Drill, UserDrill>>();
    const mount1 = createDrillHubLoader(() => asRead(first.promise), publish);
    mount1.load();
    mount1.dispose();
    const mount2 = createDrillHubLoader(() => asRead(second.promise), publish);
    mount2.load();
    second.resolve({ phase: "ready", drills: DRILLS, progress: PROGRESS });
    await flush();
    first.resolve({ phase: "unavailable" }); // the older, slower load finishes last
    await flush();
    expect(states.at(-1)).toEqual({ phase: "ready", drills: DRILLS, progress: PROGRESS });
    expect(states.filter((s) => s.phase === "unavailable")).toHaveLength(0);
  });

  it("the loader invokes only the read it was given, once per load, with that load's own cancellation signal", async () => {
    const read = vi.fn((signal: AbortSignal) => readDrillHub(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }), signal));
    const loader = createDrillHubLoader(read, () => {});
    loader.load();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toHaveLength(1);
    expect(read.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(read.mock.calls[0][0].aborted).toBe(false);
  });
});

describe("Drill Hub page wiring", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const page = readFileSync(path.join(ROOT, "app/(dashboard)/drills/page.tsx"), "utf8");

  it("first paint is a finite loading status with no counts, statuses or empty-state claim", () => {
    const html = renderToStaticMarkup(React.createElement(DrillsPage));
    const text = html.replace(/<[^>]+>/g, " ");
    expect(html).toContain('role="status"');
    expect(text).toContain("Loading drills…");
    expect(text).not.toMatch(/\d+\/\d+|Pending|Needs Work|Submitted|to fix|No Drills Available Yet|Try again|didn.t load/);
    // "Verified" appears only in the static subtitle "Practice · Submit · Get Verified", never as a status
    expect(text.match(/Verified/g)).toEqual(["Verified"]);
    expect(text).toContain("Get Verified");
  });

  it("the page loads through the helper with the unchanged queries and shows no raw error text", () => {
    expect(page).toContain("createDrillHubLoader<Drill, UserDrill>(");
    expect(page).toContain("readDrillHub(");
    expect(page).toContain('cancellable(supabase.from("drills").select("id, name, target_metric, the_why, the_how, the_feel").eq("drill_family", "full_swing").order("name"), readSignal)');
    expect(page).toContain('cancellable(supabase.from("user_drills").select("drill_id, status, latest_ai_feedback"), readSignal)');
    expect(page).toContain("return query.abortSignal(signal);");
    // a refused Try again (abandoned-read bound) is announced rather than silently ignored
    expect(page).toContain("setRetryRefused(!started && hubPhase === \"unavailable\");");
    expect(page).toContain("DRILL_HUB_UNAVAILABLE_COPY.stillFinishing");
    expect(page).not.toMatch(/fetchError|drillsRes\.error\.message|Promise\.all/);
    expect(page).toContain("DRILL_HUB_UNAVAILABLE_COPY");
    expect(page).toContain("loader.dispose()");
    // a progress read without a readable session would be anonymous (zero rows = all "pending"): refused
    expect(page).toContain('if (!getSessionFromCookie()) throw new Error("no readable session");');
  });

  it("the golfer-facing failure copy is plain language with no technical detail", () => {
    for (const text of Object.values(DRILL_HUB_UNAVAILABLE_COPY)) {
      expect(text).not.toMatch(/error|sql|supabase|jwt|token|exception|status code|\d{3}/i);
    }
  });
});
