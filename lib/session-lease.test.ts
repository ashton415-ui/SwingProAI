import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JarView, LineageRecord, LineageStore } from "@/utils/supabase/session-lease";

// AG-WEB-READY-03-R1 (+ A1) — the session-publication lease (utils/supabase/session-lease.ts) as a unit: exclusion within
// the tab (FIFO) and across tabs (one exclusive Web Lock, never stolen), bounded and cancellable waits whose abandoned
// lock requests are never granted later, admission of a publish/end section's own refreshes (also when queued before it
// was held), the points at which a refresh section ends (its announcement dispatched, its SDK call settled, a refused
// commit, or the backstop), End Session's hold backstop, and the lineage contract: a holder whose view of the jar shows
// an EARLIER recorded lineage waits, then marks itself untrusted (fail closed); so does a view never recorded (counted
// apart); only a publication's record re-anchors. A1: missing Web Locks, a missing or failing store and missing
// SubtleCrypto are UNTRUSTED (fail closed), never a per-tab or unchecked substitute (R5); lineage work bound to a section
// can never append or anchor after the section ended (R3, forced schedule with its negative control); the view is read
// before the record; the tab's observed lineage never moves backwards (R4 support). A second "tab" is a second module
// registry sharing the lock manager. Fake time; SubtleCrypto is the real one unless a test pauses it.

const KEY = "sb-127-auth-token";
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };
const run = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
/** Runs fake time forward in 25 ms steps until `p` settles (real SubtleCrypto work completes off the fake clock). */
async function drive<T>(p: Promise<T>, maxMs = 10_000): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let t = 0; !done && t <= maxMs; t += 25) {
    await flush(4);
    if (done) break;
    await vi.advanceTimersByTimeAsync(25);
  }
  await flush();
  return p;
}

/**
 * A4 (C3): real SubtleCrypto completion made deterministic against the fake clock. Every digest the module under test
 * starts is tracked — optionally held back `lagTurns` event-loop turns first, as on a loaded machine — and fake time is
 * moved forward only in `step` ms increments taken once no digest is in flight and the work it released has run. A
 * lineage check that interleaves real digests with its fake 25 ms polls can then neither be overtaken by the clock nor
 * left behind it: under load, a bare `await` after a fixed advance left the check's next fake sleep unadvanced (the A3
 * final-suite timeout). The 500 ms settle window itself is untouched: only the scheduling of the test is controlled.
 */
function controlledDigests(lagTurns = 0) {
  const subtle = globalThis.crypto.subtle;
  const real = subtle.digest.bind(subtle);
  const inFlight = new Set<Promise<ArrayBuffer>>();
  let started = 0;
  vi.spyOn(subtle, "digest").mockImplementation((algorithm: AlgorithmIdentifier, data: BufferSource) => {
    started += 1;
    const digest = (async () => {
      for (let i = 0; i < lagTurns; i++) await new Promise<void>((r) => setImmediate(r)); // setImmediate is not faked
      return real(algorithm, data);
    })();
    inFlight.add(digest);
    const done = () => { inFlight.delete(digest); };
    digest.then(done, done);
    return digest;
  });
  const settle = async () => {
    for (let guard = 0; inFlight.size > 0 && guard < 10_000; guard++) {
      await Promise.allSettled(Array.from(inFlight));
      await flush(2);
    }
    await flush(2);
  };
  return {
    started: () => started,
    /** `ms` of fake time, in `step` ms increments, each taken only once no digest is in flight */
    async run(ms: number, step = 5): Promise<void> {
      for (let t = 0; t < ms; t += step) {
        await settle();
        await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
      }
      await settle();
    },
    /** fake time in `step` ms increments (each after every in-flight digest) until `p` settles */
    async drive<T>(p: Promise<T>, maxMs = 10_000, step = 5): Promise<T> {
      let done = false;
      p.then(() => { done = true; }, () => { done = true; });
      for (let t = 0; !done && t <= maxMs; t += step) {
        await settle();
        if (done) break;
        await vi.advanceTimersByTimeAsync(step);
      }
      await settle();
      return p;
    },
  };
}

function lockManager() {
  type Req = { owner: string; callback: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const queue: Req[] = [];
  let holder: Req | null = null;
  const granted: string[] = [];
  const pump = () => {
    if (holder || queue.length === 0) return;
    const r = queue.shift()!;
    holder = r;
    granted.push(r.owner);
    queueMicrotask(() => Promise.resolve().then(() => r.callback()).then((v) => { holder = null; r.resolve(v); pump(); }, (e) => { holder = null; r.reject(e); pump(); }));
  };
  let owner = "tab";
  return {
    granted,
    setOwner: (o: string) => { owner = o; },
    locks: {
      request(_name: string, options: { signal?: AbortSignal }, callback: () => unknown) {
        return new Promise((resolve, reject) => {
          if (options.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          const r: Req = { owner, callback, resolve, reject };
          options.signal?.addEventListener("abort", () => {
            const at = queue.indexOf(r);
            if (at !== -1) { queue.splice(at, 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }
          }, { once: true });
          queue.push(r);
          pump();
        });
      },
    },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function lineageRecord(initial: string[] = []) {
  let record: LineageRecord | null = initial.length ? { epoch: "e1", seq: initial.length, history: initial } : null;
  const hooks = { fail: false, hang: false, readGate: null as Promise<void> | null, reads: 0 };
  const store: LineageStore = {
    async read() {
      hooks.reads += 1;
      if (hooks.readGate) await hooks.readGate;
      if (hooks.fail) throw new Error("synthetic");
      if (hooks.hang) await new Promise(() => undefined);
      return record;
    },
    async append(digest: string, signal?: AbortSignal) {
      if (hooks.hang) await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      if (signal?.aborted) throw new Error("abandoned"); // as the IndexedDB store: checked right before the transaction
      if (hooks.fail) throw new Error("synthetic");
      const h = record?.history ?? [];
      if (h[h.length - 1] !== digest) record = { epoch: record?.epoch ?? "e1", seq: (record?.seq ?? 0) + 1, history: [...h, digest].slice(-8) };
      return record!;
    },
  };
  return { store, hooks, current: () => record, set: (r: LineageRecord | null) => { record = r; } };
}

type Lease = typeof import("@/utils/supabase/session-lease");
let mgr: ReturnType<typeof lockManager>;
let view: JarView = { kind: "absent" };
async function tab(store: LineageStore | null, name = "tab"): Promise<Lease> {
  vi.resetModules();
  mgr.setOwner(name);
  const lease = await import("@/utils/supabase/session-lease");
  lease.configureLease(KEY);
  lease.configureLineage({ jarView: () => view, store });
  return lease;
}
/** A store that has recorded nothing: sections are trusted (nothing to compare with). */
const fresh = () => lineageRecord().store;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"], now: Date.UTC(2026, 10, 20) });
  mgr = lockManager();
  vi.stubGlobal("navigator", { locks: mgr.locks });
  view = { kind: "absent" };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exclusion", () => {
  it("within a tab sections run one at a time in FIFO order; a section counts as active only once held", async () => {
    const lease = await tab(fresh());
    const order: string[] = [];
    const a = await lease.enterSection("storage", { waitMs: 1_000 });
    expect(lease.activeSection()).toBe(a);
    const b = lease.enterSection("storage", { waitMs: 5_000 }).then((s) => { order.push("b"); return s; });
    const c = lease.enterSection("storage", { waitMs: 5_000 }).then((s) => { order.push("c"); return s; });
    await flush();
    expect(order).toEqual([]);
    lease.leaveSection(a!);
    const sb = await b;
    expect(lease.activeSection()).toBe(sb);
    lease.leaveSection(sb!);
    lease.leaveSection((await c)!);
    expect(order).toEqual(["b", "c"]);
    expect(lease.activeSection()).toBeNull();
  });

  it("across tabs one lock: the second tab waits until the first releases; a waiter that times out gives up (never steals) and its request is aborted, so it is never granted later", async () => {
    const shared = fresh();
    const one = await tab(shared, "one");
    const s1 = await one.enterSection("publish", { waitMs: 1_000 });
    const two = await tab(shared, "two");
    const late = two.enterSection("publish", { waitMs: 2_000 });
    await run(2_000);
    expect(await late).toBeNull();
    expect(two.leaseCounters().leaseTimeouts).toBe(1);
    one.leaveSection(s1!);
    await run(100);
    expect(mgr.granted).toEqual(["one"]); // tab two's abandoned request was never granted
    const again = await two.enterSection("publish", { waitMs: 1_000 });
    expect(again).not.toBeNull();
    expect(mgr.granted).toEqual(["one", "two"]);
  });

  it("cancellation: a caller's abort gives up at once, whether queued in the tab or waiting for the cross-tab lock; nothing is granted to it later", async () => {
    const shared = fresh();
    const one = await tab(shared, "one");
    const held = await one.enterSection("end", { waitMs: 1_000 });
    const two = await tab(shared, "two");
    const cancel = new AbortController();
    const waiting = two.enterSection("end", { waitMs: 15_000, signal: cancel.signal });
    await run(100);
    cancel.abort();
    expect(await waiting).toBeNull();
    const inTab = new AbortController();
    const queued = one.enterSection("storage", { waitMs: 15_000, signal: inTab.signal });
    inTab.abort();
    expect(await queued).toBeNull();
    one.leaveSection(held!);
    await run(100);
    expect(mgr.granted).toEqual(["one"]);
    expect(two.leaseCounters().leaseCancels + one.leaseCounters().leaseCancels).toBe(2);
    const pre = new AbortController();
    pre.abort();
    expect(await two.enterSection("end", { waitMs: 1_000, signal: pre.signal })).toBeNull();
  });

  it("A1 R5: without Web Locks (an insecure context) nothing can be ordered across tabs: no section is entered at all (never a per-tab substitute), counted noWebLocks; leaseSupport() says unsupported", async () => {
    vi.stubGlobal("navigator", {});
    const lease = await tab(fresh());
    expect(lease.leaseSupport()).toBe("unsupported");
    expect(await lease.enterSection("storage", { waitMs: 1_000 })).toBeNull();
    expect(await lease.enterRefresh("rA", 1_000)).toBeNull();
    expect(lease.activeSection()).toBeNull();
    expect(lease.leaseCounters().noWebLocks).toBe(2);
    expect(lease.leaseCounters().leaseTimeouts).toBe(0);
    // negative control: with Web Locks, IndexedDB-or-store and SubtleCrypto present, supported
    vi.stubGlobal("navigator", { locks: mgr.locks });
    const ok = await tab(fresh());
    expect(ok.leaseSupport()).toBe("supported");
  });
});

describe("admission and the end of a refresh section", () => {
  it("a publish/end section runs its permit's own refreshes inside it, also one queued before it was held (admittedQueued)", async () => {
    const lease = await tab(fresh());
    const storageSection = await lease.enterSection("storage", { waitMs: 1_000 });
    const end = lease.enterSection("end", { waitMs: 5_000, permit: { kind: "end", sessionId: null, refreshTokens: new Set(["rA"]) } });
    const queuedRefresh = lease.enterRefresh("rA", 5_000); // queued behind the end section
    const other = lease.enterRefresh("rZ", 5_000);
    await flush();
    lease.leaveSection(storageSection!);
    const endSection = await end;
    const admitted = await queuedRefresh;
    expect(admitted).toEqual({ section: endSection, admitted: true });
    expect(lease.leaseCounters().admittedQueued).toBe(1);
    expect(await lease.enterRefresh("rA", 1)).toEqual({ section: endSection, admitted: true }); // while held
    lease.leaveSection(endSection!);
    expect((await other)?.admitted).toBe(false); // an unrelated token waited its turn
  });

  it("a refresh section with an expected commit stays held until the commit is observed AND its announcement dispatched", async () => {
    const lease = await tab(fresh());
    const handle = await lease.enterRefresh("r1", 1_000);
    lease.finishRefresh(handle!, { origin: "r1", result: "r2" });
    lease.noticeDispatched("TOKEN_REFRESHED", "r2");
    expect(lease.activeSection()).toBe(handle!.section); // not committed yet: an unrelated announcement does not end it
    lease.observeCommit("r2");
    lease.noticeDispatched("SIGNED_OUT", null);
    expect(lease.activeSection()).toBe(handle!.section); // wrong announcement
    lease.noticeDispatched("TOKEN_REFRESHED", "r2");
    expect(lease.activeSection()).toBeNull();
  });

  it("a refusal's section ends at the dispatched SIGNED_OUT; a refused commit ends at once; a settled SDK call ends one that got no announcement", async () => {
    const lease = await tab(fresh());
    const a = await lease.enterRefresh("r1", 1_000);
    lease.finishRefresh(a!, { origin: "r1", result: null });
    lease.observeCommit("r1");
    lease.noticeDispatched("SIGNED_OUT", null);
    expect(lease.activeSection()).toBeNull();
    const b = await lease.enterRefresh("r3", 1_000);
    lease.finishRefresh(b!, { origin: "r3", result: "r4" });
    lease.abandonCommit();
    expect(lease.activeSection()).toBeNull();
    const c = await lease.enterRefresh("r5", 1_000);
    lease.finishRefresh(c!, { origin: "r5", result: "r6" });
    lease.refreshCallSettled("r-other");
    expect(lease.activeSection()).toBe(c!.section);
    lease.refreshCallSettled("r5");
    expect(lease.activeSection()).toBeNull();
  });

  it("a commit that never comes ends the section at its 10 s backstop (counted); End Session's hold ends at its holdMs; either end aborts the section's lifetime signal", async () => {
    const lease = await tab(fresh());
    const h = await lease.enterRefresh("r1", 1_000);
    lease.finishRefresh(h!, { origin: "r1", result: "r2" });
    await run(9_999);
    expect([lease.activeSection(), h!.section.lifetime.signal.aborted]).toEqual([h!.section, false]);
    await run(1);
    expect([lease.activeSection(), h!.section.lifetime.signal.aborted]).toEqual([null, true]);
    expect(lease.leaseCounters().commitBackstops).toBe(1);
    const end = await lease.enterSection("end", { waitMs: 1_000, holdMs: 30_000 });
    await run(29_999);
    expect(lease.activeSection()).toBe(end);
    await run(1);
    expect([lease.activeSection(), end!.lifetime.signal.aborted]).toEqual([null, true]);
  });
});

describe("the lineage contract (F5; A1 R5)", () => {
  it("the latest recorded lineage equals this tab's view: trusted at once", async () => {
    view = { kind: "present", refreshToken: "rB" };
    const lease = await tab(fresh());
    const digest = (await lease.lineageDigest(view))!;
    const rec = lineageRecord(["none", digest]);
    const l2 = await tab(rec.store);
    const s = await l2.enterSection("refresh", { waitMs: 1_000 });
    expect(s!.viewTrusted).toBe(true);
  });

  it("this tab's view shows an EARLIER recorded lineage (the previous holder's writes not visible yet): it waits 500 ms, then the section is untrusted and counted (fail closed)", async () => {
    const lease = await tab(fresh());
    const a = (await lease.lineageDigest({ kind: "present", refreshToken: "rA" }))!;
    const b = (await lease.lineageDigest({ kind: "present", refreshToken: "rB" }))!;
    view = { kind: "present", refreshToken: "rA" };
    const l2 = await tab(lineageRecord([a, b]).store);
    const pending = l2.enterSection("refresh", { waitMs: 5_000 });
    await run(400);
    expect(l2.activeSection()).toBeNull(); // still settling
    await run(200);
    const s = await pending;
    expect([s!.viewTrusted, l2.leaseCounters().staleViews]).toEqual([false, 1]);
  });

  // A4 (C3): the catch-up and the refusal at the 500 ms boundary, each with real SubtleCrypto whose completion is
  // controlled against the fake clock (controlledDigests) — also with every digest held back 40 event-loop turns, as on
  // a loaded machine, where the previous bare-await form of the catch-up test hung on its next unadvanced fake sleep.
  for (const lag of [0, 40]) {
    it(`a stale view that catches up within 500 ms is trusted (digests held back ${lag} turns)`, async () => {
      const lease = await tab(fresh());
      const a = (await lease.lineageDigest({ kind: "present", refreshToken: "rA" }))!;
      const b = (await lease.lineageDigest({ kind: "present", refreshToken: "rB" }))!;
      view = { kind: "present", refreshToken: "rA" };
      const l2 = await tab(lineageRecord([a, b]).store);
      const digests = controlledDigests(lag);
      const started = performance.now();
      const pending = l2.enterSection("refresh", { waitMs: 5_000 });
      await digests.run(200);
      expect(l2.activeSection()).toBeNull(); // still settling: this view is the EARLIER recorded lineage
      view = { kind: "present", refreshToken: "rB" };
      const s = await digests.drive(pending);
      expect([s!.viewTrusted, l2.leaseCounters().staleViews]).toEqual([true, 0]);
      expect(performance.now() - started).toBeLessThan(l2.VIEW_SETTLE_MS); // trusted by its catch-up, inside the window
      expect(digests.started()).toBeGreaterThan(2); // the polls really computed digests (real SubtleCrypto)
    });

    it(`negative control: a stale view that catches up only after 500 ms stays untrusted and is counted (digests held back ${lag} turns)`, async () => {
      const lease = await tab(fresh());
      const a = (await lease.lineageDigest({ kind: "present", refreshToken: "rA" }))!;
      const b = (await lease.lineageDigest({ kind: "present", refreshToken: "rB" }))!;
      view = { kind: "present", refreshToken: "rA" };
      const l2 = await tab(lineageRecord([a, b]).store);
      const digests = controlledDigests(lag);
      const started = performance.now();
      const pending = l2.enterSection("refresh", { waitMs: 5_000 });
      await digests.run(560); // past the window, still the earlier lineage
      view = { kind: "present", refreshToken: "rB" }; // too late: the verdict is already due
      const s = await digests.drive(pending);
      expect([s!.viewTrusted, l2.leaseCounters().staleViews]).toEqual([false, 1]);
      expect(performance.now() - started).toBeGreaterThanOrEqual(l2.VIEW_SETTLE_MS);
    });
  }

  it("a view never recorded (a writer outside the contract) is waited out, then UNTRUSTED and counted (fail closed); only a publication's record re-anchors it", async () => {
    const lease = await tab(fresh());
    const a = (await lease.lineageDigest({ kind: "present", refreshToken: "rA" }))!;
    view = { kind: "present", refreshToken: "rOld-bundle" };
    const rec = lineageRecord([a]);
    const l2 = await tab(rec.store);
    const entering = l2.enterSection("refresh", { waitMs: 1_000 });
    await run(400);
    let s = await Promise.race([entering, Promise.resolve("still settling" as const)]);
    expect(s).toBe("still settling"); // waited out first: another context's record may still land
    await run(200);
    s = await entering;
    expect([s!.viewTrusted, l2.leaseCounters().unrecordedViews, l2.leaseCounters().staleViews]).toEqual([false, 1, 0]);
    l2.leaveSection(s!);
    // a publication's permit names what it writes: its record re-anchors this tab's view (nothing else does)
    const publishing = l2.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB" } });
    await run(600);
    const p = (await publishing)!;
    expect(p.viewTrusted).toBe(false);
    view = { kind: "present", refreshToken: "rB" };
    const committing = l2.commitLineage(p, view, true);
    await run(10);
    expect(await committing).toBe(true);
    expect(p.viewTrusted).toBe(true);
    l2.leaveSection(p);
  });

  it("A1 R5: a failing or hanging lineage store, or no store at all, is UNTRUSTED (fail closed, counted lineageUnavailable) — never a trusted view; nothing hangs past the 1 s read bound", async () => {
    view = { kind: "present", refreshToken: "rA" };
    const failing = lineageRecord(["x"]);
    failing.hooks.fail = true;
    const l1 = await tab(failing.store);
    const s1 = await l1.enterSection("refresh", { waitMs: 1_000 });
    expect([s1!.viewTrusted, l1.leaseCounters().lineageUnavailable]).toEqual([false, 1]);
    l1.leaveSection(s1!);
    const hanging = lineageRecord(["x"]);
    hanging.hooks.hang = true;
    const l2 = await tab(hanging.store);
    const s2 = await drive(l2.enterSection("refresh", { waitMs: 5_000 }));
    expect([s2!.viewTrusted, l2.leaseCounters().lineageUnavailable]).toEqual([false, 1]);
    l2.leaveSection(s2!);
    const l3 = await tab(null);
    const s3 = await l3.enterSection("refresh", { waitMs: 1_000 });
    expect([s3!.viewTrusted, l3.leaseSupport()]).toEqual([false, "unsupported"]); // refused before any read
    // and a commit with no store records nothing and reports it
    expect(await l3.commitLineage(s3!, view)).toBe(false);
  });

  it("A1 review (dev-run finding): a lineage read before the lease is configured (no shared client yet) answers unavailable but decides nothing: the browser is still supported, and once configured the store is used", async () => {
    vi.resetModules();
    mgr.setOwner("bare");
    vi.stubGlobal("indexedDB", {}); // present: support is decided by the store, not by a read made too early
    const lease = await import("@/utils/supabase/session-lease");
    expect(await lease.readLineageRecord()).toBe("unavailable"); // no storage key yet
    expect(lease.leaseSupport()).toBe("supported"); // nothing cached from that early read
    const rec = lineageRecord(["x"]);
    lease.configureLease(KEY);
    lease.configureLineage({ jarView: () => view, store: rec.store });
    expect(await lease.readLineageRecord()).toEqual(rec.current());
  });

  it("A1 R5: without SubtleCrypto no digest can be made: the view is untrusted and leaseSupport() says unsupported", async () => {
    view = { kind: "present", refreshToken: "rA" };
    const rec = lineageRecord();
    const lease = await tab(rec.store);
    vi.stubGlobal("crypto", {});
    expect(lease.leaseSupport()).toBe("unsupported");
    const s = await lease.enterSection("refresh", { waitMs: 1_000 });
    expect(s!.viewTrusted).toBe(false);
    expect(await lease.commitLineage(s!, view)).toBe(false);
    expect(rec.current()).toBeNull();
  });

  it("a held section records the jar's lineage (deduplicated) and reports it; an append that hangs past 1 s is aborted, counted, and reported as NOT recorded", async () => {
    const rec = lineageRecord();
    const lease = await tab(rec.store);
    const s = await lease.enterSection("publish", { waitMs: 1_000 });
    view = { kind: "present", refreshToken: "rB" };
    expect(await lease.commitLineage(s!, view)).toBe(true);
    expect(await lease.commitLineage(s!, view)).toBe(true);
    expect(rec.current()?.history).toEqual([await lease.lineageDigest(view)]);
    rec.hooks.hang = true;
    const pending = lease.commitLineage(s!, { kind: "absent" });
    await run(1_000);
    expect(await pending).toBe(false);
    expect(lease.leaseCounters().lineageWriteFailures).toBe(1);
    expect(rec.current()?.history).toHaveLength(1); // the abandoned append never landed
  });

  it("lineage digests: 'none' without a usable session; a per-token SHA-256 that never contains the token", async () => {
    const lease = await tab(fresh());
    expect(await lease.lineageDigest({ kind: "absent" })).toBe("none");
    expect(await lease.lineageDigest({ kind: "unsettled" })).toBe("none");
    const x = (await lease.lineageDigest({ kind: "present", refreshToken: "synthetic-token-x" }))!;
    const y = (await lease.lineageDigest({ kind: "present", refreshToken: "synthetic-token-y" }))!;
    expect([x.length, /^[0-9a-f]+$/.test(x), x !== y, x.includes("synthetic")]).toEqual([64, true, true, false]);
  });
});

describe("A1 R3: lineage work bound to its section's lifetime", () => {
  /** Pauses SubtleCrypto digests of the lineage of `token` until released; every other digest is computed normally. */
  function pauseDigestOf(token: string) {
    const subtle = globalThis.crypto.subtle;
    const real = subtle.digest.bind(subtle);
    const gate = deferred();
    let paused = 0;
    vi.spyOn(subtle, "digest").mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const text = new TextDecoder().decode(data as Uint8Array);
      if (text === `swingproai-lineage:${token}`) {
        paused += 1;
        await gate.promise;
      }
      return real(algorithm, data);
    });
    return { release: () => gate.resolve(), paused: () => paused };
  }

  async function schedule(expireWhilePaused: boolean) {
    const rec = lineageRecord(["x-unrecorded-elsewhere"]);
    view = { kind: "present", refreshToken: "rA" }; // never recorded: A's publish section starts untrusted
    const one = await tab(rec.store, "one");
    // the hold backstop starts once the section is held (after its 500 ms view settle): it ends at about 700 ms, about
    // 100 ms after A's commit starts — everything below happens well inside the commit's 1 s I/O bound (review I3), so
    // the outcome is decided by the section's lifetime, never by that timeout
    const entering = one.enterSection("publish", { waitMs: 1_000, holdMs: 200, permit: { kind: "publish", refreshToken: "rA" } });
    await run(600);
    const a = (await entering)!;
    expect(a.viewTrusted).toBe(false);
    const digest = pauseDigestOf("rA");
    const commitStarted = Date.now();
    const late = one.commitLineage(a, { kind: "present", refreshToken: "rA" }, true); // A's record: digest paused
    await run(10);
    expect(digest.paused()).toBe(1);
    let bRecord: string | null = null;
    if (expireWhilePaused) {
      // A's section expires (its hold backstop) while its digest is still paused
      for (let i = 0; i < 40 && one.activeSection() !== null; i++) await run(25);
      expect([one.activeSection(), a.lifetime.signal.aborted]).toEqual([null, true]);
      expect(Date.now() - commitStarted).toBeLessThan(500);
      view = { kind: "present", refreshToken: "rB" };
      const two = await tab(rec.store, "two");
      const entering2 = two.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB" } });
      await run(600);
      const b = (await entering2)!;
      expect(await two.commitLineage(b, view, true)).toBe(true); // B publishes and records
      bRecord = (await two.lineageDigest(view))!;
      two.leaveSection(b);
    }
    expect(Date.now() - commitStarted).toBeLessThan(1_000); // A's I/O bound has not fired: it decides nothing here
    digest.release(); // A's digest completes late
    await run(10);
    return { recorded: await late, rec, a, one, bRecord };
  }

  it("forced: A's section expires while its digest is paused, B publishes and records, then A's digest completes — nothing of A is appended after B, A's section is not anchored, and it is counted (lateLineage)", async () => {
    const { recorded, rec, a, one, bRecord } = await schedule(true);
    expect(recorded).toBe(false);
    expect(rec.current()!.history.at(-1)).toBe(bRecord); // B stays the latest: no obsolete A record after it
    expect(rec.current()!.history).toHaveLength(2); // [x, B] — A never appended
    expect(a.viewTrusted).toBe(false); // no trusted-tenure flag set after the section ended
    expect(one.leaseCounters().lateLineage).toBe(1);
  });

  it("negative control: the same commit with no expiry records A and anchors A's section", async () => {
    const { recorded, rec, a, one } = await schedule(false);
    expect(recorded).toBe(true);
    expect(rec.current()!.history.at(-1)).toBe(await one.lineageDigest({ kind: "present", refreshToken: "rA" }));
    expect(a.viewTrusted).toBe(true);
    expect(one.leaseCounters().lateLineage).toBe(0);
  });

  it("an append whose section ends while it waits for its transaction is abandoned (aborted before it opens)", async () => {
    const rec = lineageRecord();
    const gate = deferred();
    let waiting = false;
    const slow: LineageStore = { read: rec.store.read, append: async (d, signal) => { waiting = true; await gate.promise; return rec.store.append(d, signal); } };
    view = { kind: "present", refreshToken: "rA" };
    const lease = await tab(slow);
    const s = (await lease.enterSection("publish", { waitMs: 1_000, holdMs: 500 }))!;
    const pending = lease.commitLineage(s, view, true);
    // the digest (off the fake clock) is done and the append is waiting for its transaction BEFORE the section ends, so
    // only the section's lifetime -> I/O signal can abandon it (the post-digest ownership check has already passed, and
    // the 1 s I/O bound has not fired) — review I3
    for (let i = 0; i < 2_000 && !waiting; i++) await flush(1);
    expect(waiting).toBe(true);
    const ended = Date.now();
    await run(500); // the hold backstop ends the section
    expect(Date.now() - ended).toBeLessThan(1_000);
    gate.resolve();
    await run(10);
    expect(await pending).toBe(false);
    expect(rec.current()).toBeNull();
  });
});

describe("A1 review (security F1, QA B1): a change whose record did not land", () => {
  it("leaves the rest of the tenure untrusted: a section handed over within the tab is not trusted, and the jar is no longer the tenure's view", async () => {
    const rec = lineageRecord();
    view = { kind: "present", refreshToken: "rA" };
    const lease = await tab(rec.store);
    const s1 = (await drive(lease.enterSection("publish", { waitMs: 1_000 })))!;
    expect([s1.viewTrusted, s1.viewCheck, lease.tenureMatches(view)]).toEqual([true, "verified", true]); // nothing recorded yet
    const queued = lease.enterSection("refresh", { waitMs: 5_000 }); // handed over within the tab: same tenure
    rec.hooks.fail = true;
    view = { kind: "present", refreshToken: "rB" };
    lease.noteOwnChange(view);
    expect(lease.tenureMatches(view)).toBe(true);
    expect(await drive(lease.commitLineage(s1, view, true))).toBe(false);
    expect([s1.viewTrusted, s1.viewCheck, lease.tenureMatches(view)]).toEqual([false, "unrecorded", false]);
    rec.hooks.fail = false;
    lease.leaveSection(s1);
    const s2 = (await drive(queued))!;
    expect([s2.viewTrusted, s2.viewCheck]).toEqual([false, "unrecorded"]);
    lease.leaveSection(s2);
  });

  it("negative control: a commit that lands keeps the tenure trusted for the section handed over, and its view is the tenure's", async () => {
    const rec = lineageRecord();
    view = { kind: "present", refreshToken: "rA" };
    const lease = await tab(rec.store);
    const s1 = (await drive(lease.enterSection("publish", { waitMs: 1_000 })))!;
    const queued = lease.enterSection("refresh", { waitMs: 5_000 });
    view = { kind: "present", refreshToken: "rB" };
    lease.noteOwnChange(view);
    expect(await drive(lease.commitLineage(s1, view, true))).toBe(true);
    lease.leaveSection(s1);
    const s2 = (await drive(queued))!;
    expect([s2.viewTrusted, s2.viewCheck, lease.tenureMatches(view)]).toEqual([true, "verified", true]);
    expect(lease.tenureMatches({ kind: "present", refreshToken: "rC" })).toBe(false); // anything else written meanwhile
    lease.leaveSection(s2);
  });
});

describe("A1: the view is read before the record, and the observed lineage never moves backwards", () => {
  it("a publication recorded between this reader's view and its record read is never verified as the older view: the reader waits and verifies the newer one", async () => {
    const lease = await tab(fresh());
    const a = (await lease.lineageDigest({ kind: "present", refreshToken: "rA" }))!;
    const b = (await lease.lineageDigest({ kind: "present", refreshToken: "rB" }))!;
    const rec = lineageRecord([a]);
    const gate = deferred();
    rec.hooks.readGate = gate.promise;
    view = { kind: "present", refreshToken: "rA" };
    const reader = await tab(rec.store);
    const checking = reader.checkView(() => ({ value: view, view }), true);
    for (let i = 0; i < 200 && rec.hooks.reads === 0; i++) await flush(1); // the reader has read the view (A) …
    expect(rec.hooks.reads).toBe(1); // … and its record read is in flight (held)
    rec.set({ epoch: "e1", seq: 2, history: [a, b] }); // B published in the meantime …
    view = { kind: "present", refreshToken: "rB" }; // … and visible on the next look
    rec.hooks.readGate = null;
    gate.resolve();
    const checked = await drive(checking);
    expect([checked.verified, checked.value]).toEqual([true, { kind: "present", refreshToken: "rB" }]);
  });

  it("observedLatest keeps the newest record (higher seq) even when an older read resolves later; a new epoch (site data cleared) replaces it; a deleted record clears it", async () => {
    const order: LineageRecord[] = [
      { epoch: "e1", seq: 5, history: ["d4", "d5"] },
      { epoch: "e1", seq: 3, history: ["d3"] },
      { epoch: "e2", seq: 1, history: ["n1"] },
    ];
    let at = 0;
    const lease = await tab({ read: async () => (at < order.length ? order[at++] : null), append: async () => undefined });
    await lease.readLineageRecord();
    expect(lease.observedLatest()).toBe("d5");
    await lease.readLineageRecord();
    expect(lease.observedLatest()).toBe("d5"); // the older read did not move it back
    expect(lease.observedIncludes("d4")).toBe(true);
    await lease.readLineageRecord();
    expect(lease.observedLatest()).toBe("n1");
    await lease.readLineageRecord();
    expect(lease.observedLatest()).toBeNull();
  });
});
