import { describe, expect, it } from "vitest";
import * as readState from "@/lib/golfer-journey-read-state";
import type { DrillHubReads, DrillHubState, ListReadResponse } from "@/lib/golfer-journey-read-state";

/**
 * GJ-PARALLEL-01-R1 (GJ-READ-01) — a known Drill Hub read failure must not wait
 * behind its companion. Each case holds the other read open on purpose and
 * requires the finite "unavailable" state BEFORE releasing it. Then: one Try
 * again recovers while the abandoned read is still open, its late completion
 * cannot overwrite the newer state, presses while pending stay single-flight,
 * abandoned work is cancelled and bounded, and dispose/remount stays safe.
 *
 * The loader is driven through `readDrillHub` exactly as the page does. The
 * pass-through in `loaderFor` lets this same file run against the original
 * candidate as a control (its loader calls `read()` and takes a promise; the
 * corrected loader calls `read(signal)` and takes `{ result, settled }`).
 */

interface Drill { id: string; name: string }
interface UserDrill { drill_id: string; status: "pending" | "submitted" | "verified" | "needs_work"; latest_ai_feedback: string | null }
type Reads = DrillHubReads<Drill, UserDrill>;

const DRILLS: Drill[] = [{ id: "d-1", name: "Gate Drill" }, { id: "d-2", name: "Pump Drill" }];
const PROGRESS: UserDrill[] = [{ drill_id: "d-1", status: "verified", latest_ai_feedback: "Nice." }];
const SQL_ERROR = { message: 'permission denied for table "user_drills" (synthetic)', code: "42501" };
const READY = { phase: "ready", drills: DRILLS, progress: PROGRESS };
const UNAVAILABLE = { phase: "unavailable" };
const LOADING = { phase: "loading" };

const ok = <T,>(data: T[]) => () => Promise.resolve<ListReadResponse<T>>({ data, error: null });
const failure = (kind: "throw" | "reject" | "returned error") => (): Promise<ListReadResponse<never>> => {
  if (kind === "throw") throw new Error(SQL_ERROR.message);
  if (kind === "reject") return Promise.reject(new Error(`TypeError: Failed to fetch (${SQL_ERROR.message})`));
  return Promise.resolve({ data: null, error: SQL_ERROR });
};
function deferredWithReject<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
/** A read that honours cancellation the way the installed client does: an aborted request resolves to an error result. */
function abortAware<T>(signal: AbortSignal | undefined, onSettled: () => void) {
  return () => new Promise<ListReadResponse<T>>((resolve) => {
    const done = () => { onSettled(); resolve({ data: null, error: { message: "AbortError: This operation was aborted" } }); };
    if (!signal) return; // (original candidate: no signal exists, so this read never ends)
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}
function recorder() {
  const states: DrillHubState<Drill, UserDrill>[] = [];
  return { states, publish: (s: DrillHubState<Drill, UserDrill>) => { states.push(s); } };
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

function loaderFor(make: (signal?: AbortSignal) => Reads, publish: (s: DrillHubState<Drill, UserDrill>) => void) {
  const read = (signal?: AbortSignal) => readState.readDrillHub<Drill, UserDrill>(make as (signal: AbortSignal) => Reads, signal);
  return readState.createDrillHubLoader<Drill, UserDrill>(read as never, publish);
}

describe("a known failure is published without waiting for its companion (six cases)", () => {
  for (const side of ["catalog", "progress"] as const) {
    for (const kind of ["throw", "reject", "returned error"] as const) {
      it(`${side} ${kind}, other read held open: unavailable at once; companion cancelled; its late success publishes nothing`, async () => {
        const { states, publish } = recorder();
        const companion = deferred<ListReadResponse<never>>();
        let signalSeen: AbortSignal | undefined;
        const loader = loaderFor((signal) => {
          signalSeen = signal;
          return side === "catalog"
            ? { catalog: failure(kind), progress: () => companion.promise }
            : { catalog: () => companion.promise, progress: failure(kind) };
        }, publish);
        expect(loader.load()).toBe(true);
        await flush();
        expect(states).toEqual([LOADING, UNAVAILABLE]); // before the companion is released
        expect(signalSeen?.aborted).toBe(true); // the companion was told to stop
        companion.resolve({ data: (side === "catalog" ? PROGRESS : DRILLS) as never[], error: null });
        await flush();
        expect(states).toEqual([LOADING, UNAVAILABLE]);
        expect(JSON.stringify(states)).not.toMatch(/permission|42501|Failed to fetch/);
        expect(loader.load()).toBe(true); // Try again is accepted once the companion has ended
      });
    }
  }
});

describe("recovery after a known failure, with the abandoned read still open", () => {
  it("one Try again recovers; the old read's late completion cannot overwrite the newer state", async () => {
    const { states, publish } = recorder();
    const oldCompanion = deferred<ListReadResponse<UserDrill>>();
    let attempt = 0;
    const loader = loaderFor(() => {
      attempt++;
      return attempt === 1
        ? { catalog: failure("returned error"), progress: () => oldCompanion.promise }
        : { catalog: ok(DRILLS), progress: ok(PROGRESS) };
    }, publish);
    loader.load();
    await flush();
    expect(states.at(-1)).toEqual(UNAVAILABLE);
    expect(loader.load()).toBe(true); // accepted while the abandoned read is still open
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE, LOADING, READY]);
    oldCompanion.resolve({ data: [], error: null }); // late "empty progress" from the abandoned load
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE, LOADING, READY]);
  });

  it("presses while the retry is pending stay single-flight", async () => {
    const { states, publish } = recorder();
    const held = deferred<ListReadResponse<UserDrill>>();
    const catalogGate = deferred<ListReadResponse<Drill>>();
    const progressGate = deferred<ListReadResponse<UserDrill>>();
    let attempt = 0;
    const loader = loaderFor(() => {
      attempt++;
      return attempt === 1
        ? { catalog: failure("reject"), progress: () => held.promise }
        : { catalog: () => catalogGate.promise, progress: () => progressGate.promise };
    }, publish);
    loader.load();
    await flush();
    expect(loader.load()).toBe(true);
    expect([loader.load(), loader.load(), loader.load()]).toEqual([false, false, false]);
    expect(attempt).toBe(2);
    catalogGate.resolve({ data: DRILLS, error: null });
    progressGate.resolve({ data: PROGRESS, error: null });
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE, LOADING, READY]);
  });
});

describe("abandoned work is cancelled and bounded", () => {
  it("with cancellation honoured (as the installed client does), every retry is accepted and nothing stays open", async () => {
    const { states, publish } = recorder();
    let settledCompanions = 0;
    let attempt = 0;
    const loader = loaderFor((signal) => {
      attempt++;
      return { catalog: failure("returned error"), progress: abortAware<UserDrill>(signal, () => { settledCompanions++; }) };
    }, publish);
    for (let i = 1; i <= 6; i++) {
      expect(loader.load()).toBe(true);
      await flush();
      expect(states.at(-1)).toEqual(UNAVAILABLE);
      expect(settledCompanions).toBe(i); // each abandoned read ended when cancelled
    }
    expect(attempt).toBe(6);
  });

  it("if a read ignored cancellation, at most DRILL_HUB_MAX_ABANDONED_LOADS loads stay abandoned; Try again resumes when one ends", async () => {
    expect(readState.DRILL_HUB_MAX_ABANDONED_LOADS).toBe(2);
    const { states, publish } = recorder();
    const stuck = [deferred<ListReadResponse<UserDrill>>(), deferred<ListReadResponse<UserDrill>>(), deferred<ListReadResponse<UserDrill>>()];
    let attempt = 0;
    const loader = loaderFor(() => {
      const held = stuck[attempt++];
      return { catalog: failure("returned error"), progress: () => held.promise }; // ignores the signal
    }, publish);
    expect(loader.load()).toBe(true);
    await flush();
    expect(loader.load()).toBe(true);
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE, LOADING, UNAVAILABLE]);
    expect(loader.load()).toBe(false); // bounded: two abandoned loads are still open
    expect(attempt).toBe(2);
    stuck[0].resolve({ data: [], error: null });
    await flush();
    expect(loader.load()).toBe(true);
    expect(attempt).toBe(3);
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE, LOADING, UNAVAILABLE, LOADING, UNAVAILABLE]);
  });
});

describe("dispose and remount", () => {
  it("dispose cancels the in-flight reads and publishes nothing; a remount starts clean", async () => {
    const { states, publish } = recorder();
    const signals: (AbortSignal | undefined)[] = [];
    let settled = 0;
    const mount1 = loaderFor((signal) => {
      signals.push(signal);
      return { catalog: abortAware<Drill>(signal, () => { settled++; }), progress: abortAware<UserDrill>(signal, () => { settled++; }) };
    }, publish);
    mount1.load();
    mount1.dispose();
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(settled).toBe(2);
    expect(states).toEqual([LOADING]);
    expect(mount1.load()).toBe(false);
    const mount2 = loaderFor(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }), publish);
    mount2.load();
    await flush();
    expect(states).toEqual([LOADING, LOADING, READY]);
  });
});

describe("ordering, signals and late outcomes (review follow-ups)", () => {
  it("an abandoned read that rejects late leaves no unhandled rejection and publishes nothing", async () => {
    const { states, publish } = recorder();
    const late = deferredWithReject<ListReadResponse<UserDrill>>();
    const loader = loaderFor(() => ({ catalog: failure("returned error"), progress: () => late.promise }), publish);
    loader.load();
    await flush();
    late.reject(new Error("socket closed after cancel"));
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE]);
    expect(loader.load()).toBe(true);
  });

  it("success does not depend on order: progress first, then catalog", async () => {
    const { states, publish } = recorder();
    const catalog = deferred<ListReadResponse<Drill>>();
    const progress = deferred<ListReadResponse<UserDrill>>();
    const loader = loaderFor(() => ({ catalog: () => catalog.promise, progress: () => progress.promise }), publish);
    loader.load();
    progress.resolve({ data: PROGRESS, error: null });
    await flush();
    expect(states).toEqual([LOADING]);
    catalog.resolve({ data: DRILLS, error: null });
    await flush();
    expect(states).toEqual([LOADING, READY]);
  });

  it("readDrillHub with an outer signal already aborted: the reads see an aborted signal and the result is unavailable", async () => {
    const outer = new AbortController();
    outer.abort();
    let seen: AbortSignal | undefined;
    const read = readState.readDrillHub<Drill, UserDrill>((signal) => {
      seen = signal;
      return { catalog: abortAware<Drill>(signal, () => {}), progress: abortAware<UserDrill>(signal, () => {}) };
    }, outer.signal);
    await expect(read.result).resolves.toEqual(UNAVAILABLE);
    await expect(read.settled).resolves.toBeUndefined();
    expect(seen?.aborted).toBe(true);
  });

  it("readDrillHub with the outer signal aborted after one read succeeded: the other is cancelled, the result is unavailable", async () => {
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    const read = readState.readDrillHub<Drill, UserDrill>((signal) => {
      seen = signal;
      return { catalog: ok(DRILLS), progress: abortAware<UserDrill>(signal, () => {}) };
    }, outer.signal);
    await flush();
    outer.abort();
    await expect(read.result).resolves.toEqual(UNAVAILABLE);
    expect(seen?.aborted).toBe(true);
  });

  it("each load has its own signal: cancelling the failed load's reads leaves the retry's reads running", async () => {
    const { states, publish } = recorder();
    const signals: AbortSignal[] = [];
    const retryCatalog = deferred<ListReadResponse<Drill>>();
    const loader = loaderFor((signal) => {
      signals.push(signal as AbortSignal);
      return signals.length === 1
        ? { catalog: failure("returned error"), progress: abortAware<UserDrill>(signal, () => {}) }
        : { catalog: () => retryCatalog.promise, progress: ok(PROGRESS) };
    }, publish);
    loader.load();
    await flush();
    loader.load();
    await flush();
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    retryCatalog.resolve({ data: DRILLS, error: null });
    await flush();
    expect(states.at(-1)).toEqual(READY);
    expect(signals[1].aborted).toBe(false);
  });

  it("dispose after a known failure (abandoned read still open) and dispose during a pending retry publish nothing more", async () => {
    const { states, publish } = recorder();
    const held = deferred<ListReadResponse<UserDrill>>();
    const signals: AbortSignal[] = [];
    const loader = loaderFor((signal) => {
      signals.push(signal as AbortSignal);
      return signals.length === 1
        ? { catalog: failure("reject"), progress: () => held.promise }
        : { catalog: abortAware<Drill>(signal, () => {}), progress: abortAware<UserDrill>(signal, () => {}) };
    }, publish);
    loader.load();
    await flush();
    loader.load(); // retry pending
    loader.dispose();
    await flush();
    expect(signals[1].aborted).toBe(true);
    held.resolve({ data: PROGRESS, error: null });
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE, LOADING]);
    expect(loader.load()).toBe(false);
  });
});

describe("meanings kept", () => {
  it("both succeed: ready; genuinely empty: ready and empty; no readable session: unavailable without any read", async () => {
    for (const [make, expected] of [
      [() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }), READY],
      [() => ({ catalog: ok<Drill>([]), progress: ok<UserDrill>([]) }), { phase: "ready", drills: [], progress: [] }],
    ] as [() => Reads, unknown][]) {
      const { states, publish } = recorder();
      const loader = loaderFor(make, publish);
      loader.load();
      await flush();
      expect(states).toEqual([LOADING, expected]);
    }
    // the page's makeReads throws before building any read when no session is readable
    const { states, publish } = recorder();
    const loader = loaderFor(() => { throw new Error("no readable session"); }, publish);
    loader.load();
    await flush();
    expect(states).toEqual([LOADING, UNAVAILABLE]);
  });
});
