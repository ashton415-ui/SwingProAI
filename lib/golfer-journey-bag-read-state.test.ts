import { describe, expect, it, vi } from "vitest";
import { cancellable, readBag, BAG_COPY, type BagReads } from "@/lib/golfer-journey-bag-read-state";
import type { ListReadResponse } from "@/lib/golfer-journey-read-state";

/**
 * GJ-PARALLEL-02 — the My Bag read state. Both reads must succeed; the first
 * known failure of either decides at once, cancels the other read through the
 * signal, and the other read's late outcome is ignored. Never rejects.
 */

interface Club { id: string }
interface Row { club_id: string }
type Reads = BagReads<Club, Row>;
const CLUBS: Club[] = [{ id: "c-1" }];
const ROWS: Row[] = [{ club_id: "c-1" }];
const ERROR = { message: 'permission denied for table "swing_telemetry" (synthetic)', code: "42501" };
const READY = { status: "ready", equipment: CLUBS, telemetry: ROWS };
const UNAVAILABLE = { status: "unavailable" };

const ok = <T,>(data: T[]) => () => Promise.resolve<ListReadResponse<T>>({ data, error: null });
const failure = (kind: "throw" | "reject" | "returned error") => (): Promise<ListReadResponse<never>> => {
  if (kind === "throw") throw new Error(ERROR.message);
  if (kind === "reject") return Promise.reject(new Error(`TypeError: fetch failed (${ERROR.message})`));
  return Promise.resolve({ data: null, error: ERROR });
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  p.then((v) => { state.settled = true; state.value = v; });
  return state;
}

describe("readBag — classification", () => {
  it("both succeed: ready with both row sets", async () => {
    await expect(readBag<Club, Row>(() => ({ equipment: ok(CLUBS), telemetry: ok(ROWS) }))).resolves.toEqual(READY);
  });
  it("genuinely empty bag (both succeed, no rows): ready and empty", async () => {
    await expect(readBag<Club, Row>(() => ({ equipment: ok<Club>([]), telemetry: ok<Row>([]) }))).resolves.toEqual({ status: "ready", equipment: [], telemetry: [] });
  });
  it("clubs with no telemetry rows: ready, telemetry genuinely empty", async () => {
    await expect(readBag<Club, Row>(() => ({ equipment: ok(CLUBS), telemetry: ok<Row>([]) }))).resolves.toEqual({ status: "ready", equipment: CLUBS, telemetry: [] });
  });
  for (const [name, read] of [
    ["returned error", () => Promise.resolve({ data: null, error: ERROR })],
    ["returned error carrying real rows", () => Promise.resolve({ data: [{ id: "leaked-row" }], error: ERROR })],
    ["rejection", () => Promise.reject(new Error("socket hang up"))],
    ["synchronous throw", () => { throw new Error("bad query"); }],
    ["null rows", () => Promise.resolve({ data: null, error: null })],
    ["non-array rows", () => Promise.resolve({ data: { id: "x" }, error: null })],
  ] as [string, () => Promise<ListReadResponse<never>>][]) {
    it(`equipment ${name} → unavailable; telemetry ${name} → unavailable`, async () => {
      await expect(readBag<Club, Row>(() => ({ equipment: read, telemetry: ok(ROWS) }))).resolves.toEqual(UNAVAILABLE);
      await expect(readBag<Club, Row>(() => ({ equipment: ok(CLUBS), telemetry: read }))).resolves.toEqual(UNAVAILABLE);
    });
  }
  it("client construction that throws or rejects (after the session decision) is unavailable, without reads", async () => {
    await expect(readBag<Club, Row>(() => { throw new Error("supabaseUrl is required."); })).resolves.toEqual(UNAVAILABLE);
    await expect(readBag<Club, Row>(() => Promise.reject(new Error("cookies() failed")))).resolves.toEqual(UNAVAILABLE);
  });
  it("no error text reaches the result", async () => {
    const r = await readBag<Club, Row>(() => ({ equipment: failure("returned error"), telemetry: failure("reject") }));
    expect(JSON.stringify(r)).not.toMatch(/permission|42501|fetch failed|socket/);
  });
});

describe("readBag — a known failure does not wait for the other read (six cases)", () => {
  for (const side of ["equipment", "telemetry"] as const) {
    for (const kind of ["throw", "reject", "returned error"] as const) {
      it(`${side} ${kind}, other read held open: unavailable before release, cancellation requested, late success ignored`, async () => {
        const held = deferred<ListReadResponse<never>>();
        let signal: AbortSignal | undefined;
        const result = track(readBag<Club, Row>((s) => {
          signal = s;
          return side === "equipment"
            ? { equipment: failure(kind), telemetry: () => held.promise }
            : { equipment: () => held.promise, telemetry: failure(kind) };
        }));
        await flush();
        expect(result.settled).toBe(true);
        expect(result.value).toEqual(UNAVAILABLE);
        expect(signal?.aborted).toBe(true);
        held.resolve({ data: (side === "equipment" ? ROWS : CLUBS) as never[], error: null });
        await flush();
        expect(result.value).toEqual(UNAVAILABLE);
      });
    }
  }

  it("a late rejection of the abandoned read is handled (no unhandled rejection) and changes nothing", async () => {
    const held = deferred<ListReadResponse<never>>();
    const result = track(readBag<Club, Row>(() => ({ equipment: failure("returned error"), telemetry: () => held.promise })));
    await flush();
    held.reject(new Error("aborted late"));
    await flush();
    expect(result.value).toEqual(UNAVAILABLE);
  });

  it("the cancelled read then resolving with an AbortError result changes nothing", async () => {
    const held = deferred<ListReadResponse<never>>();
    let signal: AbortSignal | undefined;
    const result = track(readBag<Club, Row>((s) => { signal = s; return { equipment: failure("returned error"), telemetry: () => held.promise }; }));
    await flush();
    expect(signal?.aborted).toBe(true);
    held.resolve({ data: null, error: { message: "AbortError: This operation was aborted" } });
    await flush();
    expect(result.value).toEqual(UNAVAILABLE);
  });

  it("a retry (a new page render) is independent: the old read completing later cannot change it", async () => {
    const held = deferred<ListReadResponse<never>>();
    const first = track(readBag<Club, Row>(() => ({ equipment: failure("reject"), telemetry: () => held.promise })));
    await flush();
    const second = await readBag<Club, Row>(() => ({ equipment: ok(CLUBS), telemetry: ok(ROWS) }));
    held.resolve({ data: [], error: null });
    await flush();
    expect(first.value).toEqual(UNAVAILABLE);
    expect(second).toEqual(READY);
  });

  it("success needs both reads; order does not matter; nothing is cancelled", async () => {
    const e = deferred<ListReadResponse<Club>>();
    const t = deferred<ListReadResponse<Row>>();
    let signal: AbortSignal | undefined;
    const result = track(readBag<Club, Row>((s) => { signal = s; return { equipment: () => e.promise, telemetry: () => t.promise }; }));
    t.resolve({ data: ROWS, error: null });
    await flush();
    expect(result.settled).toBe(false);
    e.resolve({ data: CLUBS, error: null });
    await flush();
    expect(result.value).toEqual(READY);
    expect(signal?.aborted).toBe(false);
  });

  it("both reads hanging without failing stay pending (no timeout policy is added)", async () => {
    const result = track(readBag<Club, Row>(() => ({ equipment: () => new Promise(() => {}), telemetry: () => new Promise(() => {}) })));
    await flush();
    expect(result.settled).toBe(false);
  });
});

describe("readBag — Next.js control flow is never swallowed", () => {
  for (const digest of ["NEXT_REDIRECT;replace;/login;307;", "NEXT_NOT_FOUND", "DYNAMIC_SERVER_USAGE"]) {
    it(`a ${digest.split(";")[0]} thrown while building the client propagates`, async () => {
      const signal = Object.assign(new Error(digest.split(";")[0]), { digest });
      await expect(readBag<Club, Row>(() => { throw signal; })).rejects.toBe(signal);
      await expect(readBag<Club, Row>(() => Promise.reject(signal))).rejects.toBe(signal);
    });
  }
  it("an ordinary error (no Next digest) while building the client is unavailable", async () => {
    await expect(readBag<Club, Row>(() => { throw Object.assign(new Error("x"), { digest: "123456" }); })).resolves.toEqual(UNAVAILABLE);
  });
});

describe("cancellable and copy", () => {
  it("attaches the signal through the query's own abortSignal and returns that query", () => {
    const query = { abortSignal: vi.fn(function (this: unknown) { return query; }) } as unknown as { abortSignal(s: AbortSignal): typeof query };
    const signal = new AbortController().signal;
    expect(cancellable(query, signal)).toBe(query);
    expect((query.abortSignal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(signal);
  });
  it("golfer-facing copy is plain and makes no fitting promise", () => {
    for (const s of Object.values(BAG_COPY)) {
      expect(s).not.toMatch(/error|sql|supabase|jwt|token|exception|\d{3}|fitting/i);
    }
  });
});
