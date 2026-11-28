import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChunks } from "@supabase/ssr";
import type { LineageRecord, LineageStore } from "@/utils/supabase/session-lease";
import { bindingAdmits, sessionBinding } from "@/utils/supabase/session-cookie-layout";

// AG-WEB-READY-03-R1 — the layout-managed session storage (utils/supabase/session-storage.ts) at the level of its own
// compare-and-set rules: every change to the session key is decided by one synchronous read of the jar at the moment of
// the change, inside a held section of the session-publication lease. So no placement of a concurrent change — before
// the send, during the answer, between the SDK's hand-over and its save — can make it save a stale answer or remove
// another sign-in's session: the rule reads the jar the change is applied to. Removals never throw (a throw inside the
// SDK's refusal commit would leave its single-flight refresh unresolved for every waiter); a skipped removal is counted
// and the SIGNED_OUT that follows is dropped by the event fence (lib/session-publication.test.ts). Synthetic values only.
// A1: every session READ outside a held section is verified against the recorded lineage first (R1: a stale, never
// recorded or unverifiable view is refused with the SDK's marked retryable error — never handed over, never "no
// session"); every write and removal also sets the server-visible binding cookie in the same synchronous step (R2); a
// change whose lineage record does not land is not acknowledged (R5). The lock is a single-tab Web Locks shim.

const KEY = "sb-127-auth-token";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string, sid: string) => `${b64({ alg: "HS256" })}.${b64({ sub, session_id: sid, exp: 2_000_000_000 })}.sig`;
const session = (who: string, refresh: string, opts: { sid?: string; pad?: number; noExpiresAt?: boolean } = {}) =>
  JSON.stringify({
    access_token: jwt(who, opts.sid ?? `sid-${who}`),
    refresh_token: refresh,
    ...(opts.noExpiresAt ? {} : { expires_at: 2_000_000_000 }),
    user: { id: who, p: "p".repeat(opts.pad ?? 0) },
  });

/** document.cookie over a Map (honours Max-Age=0), with a switch that drops writes (a browser refusing a cookie). */
function installJar() {
  const store = new Map<string, string>();
  const state = { dropWritesOf: null as RegExp | null, writes: 0, raw: [] as string[] };
  const doc = {
    get cookie() {
      return Array.from(store, ([n, v]) => `${n}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      state.writes += 1;
      state.raw.push(raw);
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      if (state.dropWritesOf?.test(name)) return;
      if (attrs.some((a) => /max-age=0$/i.test(a.trim()))) store.delete(name);
      else store.set(name, pair.slice(eq + 1).trim());
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { location: { protocol: "http:" }, document: doc });
  vi.stubGlobal("navigator", { locks: singleTabLocks() });
  const put = (value: string) => {
    for (const c of createChunks(KEY, value) as { name: string; value: string }[]) store.set(c.name, encodeURIComponent(c.value));
  };
  const family = () => Array.from(store.keys()).filter((n) => n === KEY || n.startsWith(`${KEY}.`));
  const held = () => {
    const names = family();
    if (names.length === 0) return null;
    const value = names.includes(KEY) ? store.get(KEY)! : names.sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop())).map((n) => store.get(n)!).join("");
    return (JSON.parse(decodeURIComponent(value)) as { refresh_token: string }).refresh_token;
  };
  return { store, state, put, family, held };
}

/** navigator.locks for one tab: exclusive, FIFO, granted as soon as free, abort signals honoured until granted. */
function singleTabLocks() {
  const queue: { run: () => void; signal?: AbortSignal }[] = [];
  let busy = false;
  const pump = () => {
    if (busy || queue.length === 0) return;
    busy = true;
    queue.shift()!.run();
  };
  return {
    request(_name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown>) {
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        const entry = {
          signal: options.signal,
          run: () => {
            void Promise.resolve().then(callback).then(
              (v) => { busy = false; resolve(v); pump(); },
              (e) => { busy = false; reject(e); pump(); },
            );
          },
        };
        options.signal?.addEventListener("abort", () => {
          const at = queue.indexOf(entry);
          if (at !== -1) { queue.splice(at, 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }
        }, { once: true });
        queue.push(entry);
        pump();
      });
    },
  };
}

const lineageHooks = { fail: false, failAppend: false };
let lineageRecord: LineageRecord | null = null;
function memoryLineage(): LineageStore {
  lineageRecord = null;
  lineageHooks.fail = false;
  lineageHooks.failAppend = false;
  return {
    async read() {
      if (lineageHooks.fail) throw new Error("synthetic lineage failure");
      return lineageRecord;
    },
    async append(digest: string, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("abandoned");
      if (lineageHooks.fail || lineageHooks.failAppend) throw new Error("synthetic lineage failure");
      const h = lineageRecord?.history ?? [];
      if (h[h.length - 1] !== digest) lineageRecord = { epoch: "e1", seq: (lineageRecord?.seq ?? 0) + 1, history: [...h, digest].slice(-8) };
      return lineageRecord!;
    },
  };
}
/** Records `refreshTokens` (or "none" for null) as this browser's lineage history, oldest first. */
async function recorded(...refreshTokens: (string | null)[]) {
  const history: string[] = [];
  for (const token of refreshTokens) history.push((await lease.lineageDigest(token === null ? { kind: "absent" } : { kind: "present", refreshToken: token }))!);
  lineageRecord = { epoch: "e1", seq: history.length, history };
}

type Lease = typeof import("@/utils/supabase/session-lease");
type Storage = typeof import("@/utils/supabase/session-storage");
let lease: Lease;
let storage: Storage;
let jar: ReturnType<typeof installJar>;
let sdk: ReturnType<Storage["createSessionStorage"]>;

beforeEach(async () => {
  vi.resetModules();
  jar = installJar();
  lease = await import("@/utils/supabase/session-lease");
  storage = await import("@/utils/supabase/session-storage");
  lease.configureLease(KEY);
  lease.configureLineage({ jarView: () => ({ kind: "absent" }), store: memoryLineage() });
  sdk = storage.createSessionStorage(KEY);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A held refresh section for `origin` whose answer (result, or a refusal) has been handed to the SDK. */
async function refreshSection(origin: string, result: string | null) {
  const handle = await lease.enterRefresh(origin, 1_000);
  if (handle === null) throw new Error("no section");
  if (result === null) storage.recordRefusal(origin);
  else storage.recordContinuation(origin, result);
  lease.finishRefresh(handle, { origin, result });
  return handle.section;
}
const refused = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (e) {
    return (e as { name?: string }).name ?? "thrown";
  }
};

describe("saves: a compare-and-set against the jar at the moment of the save", () => {
  it("the answer to a refresh of exactly the stored token is saved (and commits its section)", async () => {
    jar.put(session("A", "rA1"));
    const section = await refreshSection("rA1", "rA2");
    await sdk.setItem(KEY, session("A", "rA2"));
    expect(jar.held()).toBe("rA2");
    expect(section.committed).toBe(true);
  });

  for (const [label, change] of [
    ["the jar was emptied (End Session) before the save", (j: ReturnType<typeof installJar>) => j.store.clear()],
    ["the jar now holds B (another sign-in) before the save", (j: ReturnType<typeof installJar>) => { j.store.clear(); j.put(session("B", "rB1")); }],
    ["the jar holds an ambiguous mix before the save", (j: ReturnType<typeof installJar>) => j.store.set(`${KEY}.1`, "x")],
  ] as const) {
    it(`CAS: ${label} — the stale answer is refused with the SDK's retryable error and nothing is written`, async () => {
      jar.put(session("A", "rA1"));
      await refreshSection("rA1", "rA2");
      change(jar);
      const before = new Map(jar.store);
      expect(await refused(sdk.setItem(KEY, session("A", "rA2")))).toBe("AuthRetryableFetchError");
      expect(jar.store).toEqual(before);
      expect(storage.sessionDiagnostics().refusedSaves).toBe(1);
    });
  }

  it("a new token with no continuation record and no permit (the SDK's own sign-in on the shared client, R16) is refused", async () => {
    jar.put(session("A", "rA1"));
    expect(await refused(sdk.setItem(KEY, session("X", "rX1")))).toBe("AuthRetryableFetchError");
    expect(jar.held()).toBe("rA1");
  });

  it("re-saving the token already stored writes nothing (a stale view can never rewrite an older copy)", async () => {
    jar.put(session("A", "rA1"));
    const writes = jar.state.writes;
    await sdk.setItem(KEY, session("A", "rA1"));
    expect(jar.state.writes).toBe(writes);
  });

  it("a publish section's permit allows exactly its own new token, whatever the jar held", async () => {
    jar.put(session("A", "rA1", { pad: 5000 }));
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    await sdk.setItem(KEY, session("B", "rB1"));
    expect(jar.held()).toBe("rB1");
    expect(jar.family()).toEqual([KEY]); // every older chunk removed
    expect(await refused(sdk.setItem(KEY, session("C", "rC1")))).toBe("AuthRetryableFetchError");
    lease.leaveSection(section!);
  });

  it("a section whose view of the jar is not current (stale lineage) never continues what it sees", async () => {
    jar.put(session("A", "rA1"));
    const section = await refreshSection("rA1", "rA2");
    section.viewTrusted = false;
    expect(await refused(sdk.setItem(KEY, session("A", "rA2")))).toBe("AuthRetryableFetchError");
    expect(jar.held()).toBe("rA1");
  });

  it("a section whose view is not current removes nothing it sees — not even an exact refusal — and End Session ends nothing locally (another sign-in may hold these names)", async () => {
    jar.put(session("A", "rA1", { sid: "sid-A" }));
    const refreshing = await refreshSection("rA1", null);
    refreshing.viewTrusted = false;
    await sdk.removeItem(KEY);
    expect(jar.held()).toBe("rA1");
    lease.leaveSection(refreshing);
    const ending = await lease.enterSection("end", { waitMs: 1_000, permit: { kind: "end", sessionId: "sid-A", refreshTokens: new Set(["rA1"]) } });
    ending!.viewTrusted = false;
    await sdk.removeItem(KEY);
    await storage.endLocally(ending!);
    expect(jar.held()).toBe("rA1");
    expect(storage.sessionDiagnostics().endedLocally).toBe(0);
    lease.leaveSection(ending!);
  });

  it("a publication plans over every name a reader accepts, so chunks this tab cannot see yet are never left beside the new layout", async () => {
    jar.put(session("A", "rA1", { pad: 9000 })); // chunked: .0 .. .n
    const hidden = Array.from(jar.store.keys()).filter((n) => n !== `${KEY}.0`);
    expect(hidden.length).toBeGreaterThan(0);
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    // what this tab "sees": only .0 (the other chunks were written by a context whose writes are not visible here yet)
    const realGet = Object.getOwnPropertyDescriptor(document, "cookie")!.get!;
    const doc = document as unknown as { cookie: string };
    const seenOnly = () => (realGet.call(doc) as string).split("; ").filter((p) => !hidden.some((n) => p.startsWith(`${n}=`))).join("; ");
    let hide = true;
    Object.defineProperty(doc, "cookie", { configurable: true, get: () => (hide ? seenOnly() : realGet.call(doc)), set: Object.getOwnPropertyDescriptor(document, "cookie")!.set });
    try {
      await sdk.setItem(KEY, session("B", "rB1")); // bare B: the write must still remove A's hidden chunks
    } catch {
      // a verify read through the hidden view may refuse; what matters is what the jar holds
    } finally {
      hide = false;
    }
    lease.leaveSection(section!);
    expect(jar.family().filter((n) => n !== KEY)).toEqual([]);
    expect(jar.held()).toBe("rB1");
  });

  it("a value that would need more than 16 chunks is never written (oversized: refused, counted)", async () => {
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rBig" } });
    expect(await refused(sdk.setItem(KEY, session("B", "rBig", { pad: 60_000 })))).toBe("AuthRetryableFetchError");
    expect(jar.family()).toEqual([]);
    expect(storage.sessionDiagnostics().oversizedSaves).toBe(1);
    lease.leaveSection(section!);
  });

  it("a layout the browser did not keep as written is never acknowledged: what was written is removed and the save fails", async () => {
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    jar.state.dropWritesOf = new RegExp(`^${KEY}\\.0$`); // the head chunk is refused
    expect(await refused(sdk.setItem(KEY, session("B", "rB1", { pad: 5000 })))).toBe("AuthRetryableFetchError");
    jar.state.dropWritesOf = null;
    expect(jar.family()).toEqual([]);
    expect(storage.sessionDiagnostics().writeVerifyFailures).toBe(1);
    lease.leaveSection(section!);
  });
});

describe("removals: never throw; only the refused session, the ended lineage, or no usable session", () => {
  it("the refusal of exactly the stored token removes it (and commits the section)", async () => {
    jar.put(session("A", "rA1", { pad: 5000 }));
    const section = await refreshSection("rA1", null);
    await sdk.removeItem(KEY);
    expect(jar.family()).toEqual([]);
    expect(section.committed).toBe(true);
  });

  it("a refusal for A when the jar now holds B: B stays, nothing thrown, counted (the SIGNED_OUT that follows is dropped by the fence)", async () => {
    jar.put(session("A", "rA1"));
    await refreshSection("rA1", null);
    jar.store.clear();
    jar.put(session("B", "rB1"));
    expect(await refused(sdk.removeItem(KEY))).toBeNull();
    expect(jar.held()).toBe("rB1");
    expect(storage.sessionDiagnostics().skippedRemovals).toBe(1);
  });

  it("the SDK's removal outside any section (its second removal, S8; or signOut on the shared client, R16) leaves a stored session", async () => {
    jar.put(session("B", "rB1"));
    expect(await refused(sdk.removeItem(KEY))).toBeNull();
    expect(jar.held()).toBe("rB1");
  });

  it("an unusable stored value (no expires_at) or an ambiguous jar is no session to the SDK (nothing it could fail to remove: no SIGNED_OUT loop); a trusted removal still clears either", async () => {
    jar.put(session("A", "rA1", { noExpiresAt: true }));
    expect(await sdk.getItem(KEY)).toBeNull();
    await sdk.removeItem(KEY);
    expect(jar.family()).toEqual([]);
    jar.store.set(KEY, "x");
    jar.store.set(`${KEY}.0`, "y");
    expect(await sdk.getItem(KEY)).toBeNull();
    await sdk.removeItem(KEY);
    expect(jar.family()).toEqual([]);
    expect(storage.sessionDiagnostics().unusableRemovals).toBe(2);
  });

  it("an end section removes its own lineage (by refresh token or by session_id), never another account's session, and clears the verifier and user roots", async () => {
    jar.put(session("A", "rA2", { sid: "sid-A" }));
    jar.store.set(`${KEY}-code-verifier`, "v");
    jar.store.set(`${KEY}-user`, "u");
    const section = await lease.enterSection("end", { waitMs: 1_000, permit: { kind: "end", sessionId: "sid-A", refreshTokens: new Set(["rA1"]) } });
    await storage.endLocally(section!);
    // A1: every session cookie, the verifier and the user root are gone; only the binding remains, recording "none"
    expect(Array.from(jar.store.entries())).toEqual([["swingproai-session-binding", "none"]]);
    lease.leaveSection(section!);
    jar.put(session("B", "rB1", { sid: "sid-B" }));
    const other = await lease.enterSection("end", { waitMs: 1_000, permit: { kind: "end", sessionId: "sid-A", refreshTokens: new Set(["rA2"]) } });
    await storage.endLocally(other!);
    expect(jar.held()).toBe("rB1");
    lease.leaveSection(other!);
  });
});

describe("reads", () => {
  it("getItem returns a complete layout's value, null for an ambiguous or absent jar; other keys read the SDK's own cookie", async () => {
    expect(await sdk.getItem(KEY)).toBeNull();
    jar.put(session("A", "rA1", { pad: 5000 }));
    expect(await sdk.getItem(KEY)).toBe(session("A", "rA1", { pad: 5000 }));
    jar.store.set(KEY, "shadow");
    const started = Date.now();
    expect(await sdk.getItem(KEY)).toBeNull(); // ambiguous throughout: waited out (VIEW_SETTLE_MS), then no session
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    jar.store.set(`${KEY}-code-verifier`, encodeURIComponent("verifier value"));
    expect(await sdk.getItem(`${KEY}-code-verifier`)).toBe("verifier value");
  });

  it("a reader that catches another tab's chunked replacement mid-write (headless: no .0 for a moment) waits it out and reads the new session, never 'no session' (QA F-A)", async () => {
    jar.put(session("C", "rC1", { pad: 9000 }));
    const next = session("C", "rC2", { pad: 9000 });
    jar.store.delete(`${KEY}.0`); // the writer removed the old head first (session-cookie-layout.ts write order)
    const reading = sdk.getItem(KEY);
    await new Promise((r) => setTimeout(r, 120)); // the reader is still waiting
    const chunks = createChunks(KEY, next) as { name: string; value: string }[];
    for (const c of chunks.slice(1)) jar.store.set(c.name, encodeURIComponent(c.value));
    jar.store.set(chunks[0].name, encodeURIComponent(chunks[0].value)); // the head last
    expect(await reading).toBe(next);
  });

  it("publishDirect stores only inside its own held publish section, with its permit's token", async () => {
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    expect(await storage.publishDirect(section!, JSON.parse(session("C", "rC1")))).toBe(false);
    expect(await storage.publishDirect(section!, JSON.parse(session("B", "rB1")))).toBe(true);
    lease.leaveSection(section!);
    expect(await storage.publishDirect(section!, JSON.parse(session("B", "rB1")))).toBe(false); // no longer held
    expect(jar.held()).toBe("rB1");
  });
});

describe("A1 R1: every read outside a held section is verified against the recorded lineage", () => {
  const reasonOf = async (work: Promise<unknown>) => {
    try {
      await work;
      return "resolved";
    } catch (e) {
      return [(e as { name?: string }).name, storage.sessionUnverifiedReason(e)];
    }
  };

  it("an unexpired A in the jar while the lineage records B: after waiting 500 ms the read is REFUSED (marked unverified, the SDK's retryable error) — never A, never 'no session'; the stale and never-recorded cases are named apart", async () => {
    jar.put(session("A", "rA1"));
    await recorded("rB1"); // A never recorded here
    const started = Date.now();
    expect(await reasonOf(sdk.getItem(KEY))).toEqual(["AuthRetryableFetchError", "unrecorded"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await recorded("rA1", "rB1"); // A recorded before B: this tab's view is older
    expect(await reasonOf(sdk.getItem(KEY))).toEqual(["AuthRetryableFetchError", "stale"]);
    expect(storage.sessionDiagnostics().unverifiedReads).toBe(2);
    expect(jar.held()).toBe("rA1"); // nothing removed
  });

  it("an absent jar while the lineage records B is refused too (a sync failure is never a sign-out); 'none' recorded last is a real sign-out (null)", async () => {
    await recorded("rB1");
    expect(await reasonOf(sdk.getItem(KEY))).toEqual(["AuthRetryableFetchError", "unrecorded"]);
    await recorded("rB1", null);
    expect(await sdk.getItem(KEY)).toBeNull();
  });

  it("negative controls: the recorded session is read at once; a view that catches up within 500 ms is read as the newer session; nothing recorded yet (before the first publication) reads the jar as before", async () => {
    jar.put(session("B", "rB1"));
    await recorded("rA1", "rB1");
    expect(await sdk.getItem(KEY)).toBe(session("B", "rB1"));
    jar.store.clear();
    jar.put(session("A", "rA1"));
    const reading = sdk.getItem(KEY);
    await new Promise((r) => setTimeout(r, 100));
    jar.store.clear();
    jar.put(session("B", "rB1")); // the previous holder's write becomes visible here
    expect(await reading).toBe(session("B", "rB1"));
    lineageRecord = null;
    jar.store.clear();
    jar.put(session("Z", "rZ1"));
    expect(await sdk.getItem(KEY)).toBe(session("Z", "rZ1"));
  });

  it("R5: a failing lineage store or missing SubtleCrypto refuses the read (unavailable / unsupported) and removes nothing", async () => {
    jar.put(session("A", "rA1"));
    lineageHooks.fail = true;
    expect(await reasonOf(sdk.getItem(KEY))).toEqual(["AuthRetryableFetchError", "unavailable"]);
    lineageHooks.fail = false;
    vi.stubGlobal("crypto", {});
    expect(await reasonOf(sdk.getItem(KEY))).toEqual(["AuthRetryableFetchError", "unsupported"]);
    expect(jar.held()).toBe("rA1");
  });

  it("inside this tab's held section the section's own verdict decides: trusted reads the jar at once, untrusted is refused", async () => {
    jar.put(session("A", "rA1"));
    await recorded("rA1");
    const section = await lease.enterSection("storage", { waitMs: 1_000 });
    expect(section!.viewTrusted).toBe(true);
    expect(await sdk.getItem(KEY)).toBe(session("A", "rA1"));
    section!.viewTrusted = false;
    expect(await reasonOf(sdk.getItem(KEY))).toEqual(["AuthRetryableFetchError", "stale"]);
    lease.leaveSection(section!);
  });
});

describe("A1 R2: the binding cookie is set in the same step as every session write and removal", () => {
  const BINDING = "swingproai-session-binding";
  const rawFor = (name: string) => jar.state.raw.filter((r) => r.startsWith(`${name}=`));

  it("a publication writes the session, then the binding of its access token (same attributes, 30 days); a removal writes 'none'; End Session's local end writes 'none'", async () => {
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    const value = session("B", "rB1", { sid: "sid-B" });
    await sdk.setItem(KEY, value);
    const expected = await sessionBinding(JSON.parse(value).access_token);
    expect(jar.store.get(BINDING)).toBe(expected);
    const writes = jar.state.raw.map((r) => r.split("=")[0]);
    expect(writes.lastIndexOf(BINDING)).toBeGreaterThan(writes.lastIndexOf(KEY)); // after the session layout
    expect(rawFor(BINDING).at(-1)).toMatch(/; Max-Age=2592000; Path=\/; SameSite=Lax$/);
    lease.leaveSection(section!);
    const refreshing = await refreshSection("rB1", null);
    await sdk.removeItem(KEY);
    expect([jar.family(), jar.store.get(BINDING)]).toEqual([[], "none"]);
    lease.leaveSection(refreshing);
    jar.put(session("C", "rC1", { sid: "sid-C" }));
    lineageRecord = null;
    const ending = await lease.enterSection("end", { waitMs: 1_000, permit: { kind: "end", sessionId: "sid-C", refreshTokens: new Set(["rC1"]) } });
    jar.store.set(BINDING, "stale");
    await storage.endLocally(ending!);
    expect([jar.family(), jar.store.get(BINDING)]).toEqual([[], "none"]);
    lease.leaveSection(ending!);
  });

  it("a refused save writes no binding; a binding the browser does not keep makes the save fail (never acknowledged) and leaves no session behind", async () => {
    jar.put(session("A", "rA1"));
    expect(await refused(sdk.setItem(KEY, session("X", "rX1")))).toBe("AuthRetryableFetchError");
    expect(jar.store.has(BINDING)).toBe(false);
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    jar.state.dropWritesOf = new RegExp(`^${BINDING}$`);
    expect(await refused(sdk.setItem(KEY, session("B", "rB1")))).toBe("AuthRetryableFetchError");
    jar.state.dropWritesOf = null;
    expect(jar.family()).toEqual([]);
    expect(storage.sessionDiagnostics().writeVerifyFailures).toBe(1);
    lease.leaveSection(section!);
  });
});

describe("A1 R5: a change whose lineage record does not land is not acknowledged", () => {
  it("a save whose append fails throws the SDK's retryable error (no announcement follows), marks the section and sets the binding 'none'; every later read refuses the unrecorded session, also with NOTHING recorded before (review m1: no planted record)", async () => {
    expect(lineageRecord).toBeNull(); // nothing ever recorded in this browser
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    lineageHooks.failAppend = true;
    expect(await refused(sdk.setItem(KEY, session("B", "rB1")))).toBe("AuthRetryableFetchError");
    expect(storage.sectionChangeUnrecorded(section!)).toBe(true);
    expect(storage.sessionDiagnostics().unrecordedChanges).toBe(1);
    expect(jar.held()).toBe("rB1"); // written, never acknowledged ...
    expect(jar.store.get("swingproai-session-binding")).toBe("none"); // ... and refused by the server
    expect(await bindingAdmits(Array.from(jar.store, ([name, value]) => ({ name, value })), JSON.parse(session("B", "rB1")).access_token)).toBe("mismatch");
    lease.leaveSection(section!);
    lineageHooks.failAppend = false;
    expect(lineageRecord).toBeNull();
    try {
      await sdk.getItem(KEY);
      throw new Error("read was not refused");
    } catch (e) {
      expect(storage.sessionUnverifiedReason(e)).toBe("unrecorded");
    }
  });

  it("negative control: the same save whose append lands is bound and read back (nothing recorded before)", async () => {
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    await sdk.setItem(KEY, session("B", "rB1"));
    expect(await bindingAdmits(Array.from(jar.store, ([name, value]) => ({ name, value })), JSON.parse(session("B", "rB1")).access_token)).toBe("bound");
    lease.leaveSection(section!);
    expect(await sdk.getItem(KEY)).toBe(session("B", "rB1"));
  });

  it("a session written over a removal by something outside the contract (binding 'none') is refused by every browser reader, as by the server, even with nothing recorded to compare with", async () => {
    jar.put(session("A", "rA1"));
    const refreshing = await refreshSection("rA1", null);
    await sdk.removeItem(KEY); // binding 'none'
    lease.leaveSection(refreshing);
    jar.put(session("C", "rC1")); // an old bundle's page writes C whole (no binding of its own)
    lineageRecord = null; // nothing recorded to compare with (site data cleared)
    try {
      await sdk.getItem(KEY);
      throw new Error("read was not refused");
    } catch (e) {
      expect(storage.sessionUnverifiedReason(e)).toBe("unrecorded");
    }
  });

  it("a removal whose append fails never throws, but marks the section (its SIGNED_OUT is not delivered: lib/session-publication.test.ts)", async () => {
    jar.put(session("A", "rA1"));
    const section = await refreshSection("rA1", null);
    lineageHooks.failAppend = true;
    expect(await refused(sdk.removeItem(KEY))).toBeNull();
    expect(jar.family()).toEqual([]);
    expect(storage.sectionChangeUnrecorded(section)).toBe(true);
    lease.leaveSection(section);
  });

  it("publishDirect reports false when its record does not land", async () => {
    const section = await lease.enterSection("publish", { waitMs: 1_000, permit: { kind: "publish", refreshToken: "rB1" } });
    lineageHooks.failAppend = true;
    expect(await storage.publishDirect(section!, JSON.parse(session("B", "rB1")))).toBe(false);
    lease.leaveSection(section!);
  });
});
