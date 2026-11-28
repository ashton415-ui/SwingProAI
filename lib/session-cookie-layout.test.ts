import { describe, it, expect } from "vitest";
import { createChunks } from "@supabase/ssr";
import {
  MAX_SESSION_CHUNKS,
  authStorageRoots,
  familyMember,
  familyNames,
  jwtClaims,
  parseCookieHeader,
  planFamilyRemoval,
  planSessionWrite,
  readEnvelope,
  readSessionLayout,
  safeResumeTarget,
  sessionCookieKey,
  withStoredExpiry,
  withUsableExpiry,
  type CookieOperation,
} from "@/utils/supabase/session-cookie-layout";

// AG-WEB-READY-03-R1 — the one session cookie layout every reader and the browser's writer share
// (utils/supabase/session-cookie-layout.ts). Pure functions; synthetic values only.
// F6: malformed family members (".00", ".x", five digits, a bare "<key>.") are family names — they make a jar
// ambiguous and every removal removes them — and the writer never writes a layout the readers cannot read (more than
// MAX_SESSION_CHUNKS chunks). The write order is checked by replaying every plan on a jar and reading the jar after
// every single cookie operation (AM-X4): only the old session, an ambiguous jar, or the new session may be seen —
// never no session (an absent jar must always mean a real removal) and never a complete layout joining two sessions.

const KEY = "sb-127-auth-token";
const ORIGIN = "http://127.0.0.1:3941";

/** A jar as a Map in insertion order, written exactly as the operations say. */
function jar(entries: [string, string][] = []) {
  const m = new Map<string, string>(entries);
  return {
    m,
    header: () => Array.from(m, ([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; "),
    apply(op: CookieOperation) {
      if (op.value === null) m.delete(op.name);
      else m.set(op.name, op.value);
    },
    names: () => Array.from(m.keys()),
  };
}
const layoutOf = (header: string) => readSessionLayout(parseCookieHeader(header), KEY);
const session = (who: string, pad = 0) =>
  JSON.stringify({ access_token: `access-${who}`, refresh_token: `refresh-${who}`, expires_at: 2_000_000_000, user: { id: who, p: "p".repeat(pad) } });
const chunksOf = (value: string) => createChunks(KEY, value).map((c: { name: string; value: string }) => [c.name, c.value] as [string, string]);

/** Replays `plan` on `j` and returns the reader's view after each operation ("old" / "new" / kind). */
function replay(j: ReturnType<typeof jar>, plan: CookieOperation[], oldValue: string | null, newValue: string) {
  const seen: string[] = [];
  for (const op of plan) {
    j.apply(op);
    const l = layoutOf(j.header());
    seen.push(l.kind !== "present" ? l.kind : l.value === newValue ? "new" : l.value === oldValue ? "old" : "MIXED");
  }
  return seen;
}

describe("family membership (F6)", () => {
  it("canonical indices are chunks; every other <key>.<suffix> is malformed; other names are not members", () => {
    expect(familyMember(KEY, KEY)).toBe("bare");
    expect([0, 1, 9, 15, 9999].map((i) => familyMember(`${KEY}.${i}`, KEY))).toEqual([0, 1, 9, 15, 9999]);
    for (const suffix of ["00", "01", "007", "x", "", "-1", "1.0", "12345", " 1", "1 "]) expect(familyMember(`${KEY}.${suffix}`, KEY)).toBe("malformed");
    for (const name of [`${KEY}-code-verifier`, `${KEY}-user`, `${KEY}x`, "sb-127-auth", `x${KEY}`]) expect(familyMember(name, KEY)).toBeNull();
  });

  it("familyNames includes malformed members of every root, once each, in jar order", () => {
    const pairs = parseCookieHeader(`${KEY}.00=a; other=1; ${KEY}=b; ${KEY}-user.x=c; ${KEY}=d; ${KEY}-code-verifier=e`);
    expect(familyNames(pairs, authStorageRoots(KEY))).toEqual([`${KEY}.00`, KEY, `${KEY}-user.x`, `${KEY}-code-verifier`]);
  });
});

describe("readSessionLayout: exactly one complete layout, everything else ambiguous (AM-L4)", () => {
  const value = session("a");
  const chunks = chunksOf(session("a", 4000));
  it("absent, bare and chunked layouts", () => {
    expect(layoutOf("other=1").kind).toBe("absent");
    expect(layoutOf(`${KEY}=${encodeURIComponent(value)}`)).toEqual({ kind: "present", value, names: [KEY], shape: "bare" });
    const chunked = layoutOf(chunks.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; "));
    expect(chunked.kind === "present" && chunked.shape).toBe("chunked");
    expect(chunked.kind === "present" && chunked.value).toBe(session("a", 4000));
  });
  for (const [label, header] of [
    ["bare beside chunks", `${KEY}=x; ${KEY}.0=y; ${KEY}.1=z`],
    ["a gap", `${KEY}.0=y; ${KEY}.2=z`],
    ["a headless tail", `${KEY}.1=z`],
    ["a stray higher index", `${KEY}.0=y; ${KEY}.1=z; ${KEY}.3=w`],
    ["a duplicated name", `${KEY}=x; ${KEY}=x`],
    ["an empty value", `${KEY}=`],
    ["a value with no '='", `${KEY}`],
    ["an undecodable value", `${KEY}=%E0%A4%A`],
    ["a malformed member alone (.00)", `${KEY}.00=x`],
    ["a malformed member beside a complete bare session", `${KEY}=x; ${KEY}.x=y`],
    ["a malformed member beside complete chunks", `${KEY}.0=y; ${KEY}.1=z; ${KEY}.01=w`],
    ["chunk index 16 (over the reader's maximum)", Array.from({ length: 17 }, (_, i) => `${KEY}.${i}=v`).join("; ")],
  ] as const) {
    it(`ambiguous: ${label}`, () => expect(layoutOf(header).kind).toBe("ambiguous"));
  }
  it("16 contiguous chunks are the most a reader accepts", () => {
    const l = layoutOf(Array.from({ length: MAX_SESSION_CHUNKS }, (_, i) => `${KEY}.${i}=v${i}`).join("; "));
    expect(l.kind).toBe("present");
  });
});

describe("planSessionWrite: every intermediate jar is old, ambiguous or new (AM-X4, AM-L1-L3)", () => {
  const cases: [string, [string, string][], string | null, string][] = [
    ["absent → bare", [], null, session("b")],
    ["absent → chunked", [], null, session("b", 5000)],
    ["bare → bare (one overwrite)", [[KEY, session("a")]], session("a"), session("b")],
    ["bare → chunked (AM-L1)", [[KEY, session("a")]], session("a"), session("b", 5000)],
    ["chunked → bare (AM-L2)", chunksOf(session("a", 5000)), session("a", 5000), session("b")],
    ["chunked 3 → chunked 2 (AM-L3)", chunksOf(session("a", 8000)), session("a", 8000), session("b", 4000)],
    ["chunked 2 → chunked 3 (AM-L3)", chunksOf(session("a", 4000)), session("a", 4000), session("b", 8000)],
    ["legacy bare + chunks → chunked", [[KEY, session("x")], ...chunksOf(session("a", 4000))], null, session("b", 5000)],
    ["legacy malformed + gap → bare", [[`${KEY}.00`, "x"], [`${KEY}.0`, "y"], [`${KEY}.2`, "z"]], null, session("b")],
  ];
  for (const [label, start, oldValue, newValue] of cases) {
    it(label, () => {
      const j = jar(start);
      const plan = planSessionWrite(j.names(), KEY, newValue);
      expect(plan).not.toBeNull();
      const seen = replay(j, plan as CookieOperation[], oldValue, newValue);
      expect(seen.at(-1)).toBe("new");
      expect(seen.filter((s) => s === "MIXED")).toEqual([]);
      if (start.length > 0) expect(seen.filter((s) => s === "absent")).toEqual([]);
      if (oldValue !== null) expect(seen.slice(0, seen.indexOf("new")).every((s) => s === "old" || s === "ambiguous")).toBe(true);
      // only the new layout's names remain, read by every reader as the new session
      expect(j.names().sort()).toEqual(createChunks(KEY, newValue).map((c: { name: string }) => c.name).sort());
    });
  }

  it("the writer refuses a value needing more than 16 chunks (never acknowledges a layout no reader can read)", () => {
    let pad = 0;
    while (createChunks(KEY, session("big", pad)).length <= MAX_SESSION_CHUNKS) pad += 1000;
    expect(planSessionWrite([], KEY, session("big", pad))).toBeNull();
    const fits = session("big", pad - 1000);
    expect(createChunks(KEY, fits).length).toBeLessThanOrEqual(MAX_SESSION_CHUNKS);
    expect(planSessionWrite([], KEY, fits)).not.toBeNull();
  });

  it("the 3180-character boundary: at most 3180 encoded characters is bare, 3181 is chunked, and both read back", () => {
    for (const target of [3180, 3181]) {
      const base = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1, user: { id: "u", p: "" } });
      const value = base.replace('"p":""', `"p":"${"p".repeat(target - encodeURIComponent(base).length)}"`);
      expect(encodeURIComponent(value).length).toBe(target);
      const j = jar();
      for (const op of planSessionWrite([], KEY, value) as CookieOperation[]) j.apply(op);
      const l = layoutOf(j.header());
      expect([l.kind, l.kind === "present" && l.shape, l.kind === "present" && l.value === value]).toEqual(["present", target === 3180 ? "bare" : "chunked", true]);
    }
  });
});

describe("planFamilyRemoval: heads first, every member including malformed ones (AM-E8)", () => {
  it("removes bare, .0, a gap's .3, a malformed .00, in head-first order; the jar is never a complete layout of what remains", () => {
    const names = [`${KEY}.1`, `${KEY}.3`, KEY, `${KEY}.00`, `${KEY}.0`];
    const plan = planFamilyRemoval(names, KEY);
    expect(plan.map((o) => o.name)).toEqual([KEY, `${KEY}.0`, `${KEY}.1`, `${KEY}.3`, `${KEY}.00`]);
    expect(plan.every((o) => o.value === null)).toBe(true);
    const j = jar(chunksOf(session("a", 5000)));
    const seen = replay(j, planFamilyRemoval(j.names(), KEY), session("a", 5000), "never");
    expect(seen.at(-1)).toBe("absent");
    expect(seen.slice(0, -1).every((s) => s === "ambiguous")).toBe(true);
  });
});

describe("envelope, claims, key", () => {
  it("readEnvelope needs both tokens; expires_at only when a finite positive number", () => {
    expect(readEnvelope("not json")).toBeNull();
    expect(readEnvelope(JSON.stringify({ access_token: "a" }))).toBeNull();
    expect(readEnvelope(JSON.stringify({ access_token: "a", refresh_token: "" }))).toBeNull();
    expect(readEnvelope(JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: -1 }))?.expiresAt).toBeNull();
    expect(readEnvelope(JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 5 }))?.expiresAt).toBe(5);
  });
  it("A4 (C4): a stored expires_at of null is reconstructed from the access token's exp; a numeric one is read as stored; no usable exp gives null", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const access = (claims: Record<string, unknown>) => `h.${b64(claims)}.sig`;
    expect(readEnvelope(JSON.stringify({ access_token: access({ exp: 4_000_000_000 }), refresh_token: "r", expires_at: null }))?.expiresAt).toBe(4_000_000_000);
    expect(readEnvelope(JSON.stringify({ access_token: access({ exp: 4_000_000_000 }), refresh_token: "r", expires_at: 5 }))?.expiresAt).toBe(5); // legacy: as stored
    expect(readEnvelope(JSON.stringify({ access_token: access({ exp: 4_000_000_000 }), refresh_token: "r" }))?.expiresAt).toBeNull(); // no key: not reconstructed
    for (const exp of [undefined, "4000000000", -1, 0, Number.NaN]) {
      expect(readEnvelope(JSON.stringify({ access_token: access({ exp }), refresh_token: "r", expires_at: null }))?.expiresAt).toBeNull();
    }
    expect(readEnvelope(JSON.stringify({ access_token: "not-a-jwt", refresh_token: "r", expires_at: null }))?.expiresAt).toBeNull();
  });
  it("A4 (C4): withStoredExpiry keeps the key and sets it null (key order kept; nothing else changes); withUsableExpiry gives the SDK the token's exp, and leaves any other value alone", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `h.${b64({ sub: "u", exp: 4_000_000_000 })}.sig`;
    const sdk = JSON.stringify({ access_token: token, token_type: "bearer", expires_in: 3600, expires_at: 3_999_999_999, refresh_token: "r", user: { id: "u" } });
    const stored = withStoredExpiry(sdk);
    expect(stored).toBe(JSON.stringify({ access_token: token, token_type: "bearer", expires_in: 3600, expires_at: null, refresh_token: "r", user: { id: "u" } }));
    expect(Object.keys(JSON.parse(stored))).toEqual(Object.keys(JSON.parse(sdk)));
    expect(withStoredExpiry(stored)).toBe(stored); // idempotent
    const handed = JSON.parse(withUsableExpiry(stored)) as Record<string, unknown>;
    expect(handed).toEqual({ ...JSON.parse(stored), expires_at: 4_000_000_000 });
    // a value already numeric (legacy, or a previous bundle's write), a value with no key, an unreadable one: unchanged
    expect(withUsableExpiry(sdk)).toBe(sdk);
    const noKey = JSON.stringify({ access_token: token, refresh_token: "r" });
    expect(withUsableExpiry(noKey)).toBe(noKey);
    expect(withUsableExpiry("not json")).toBe("not json");
    expect(withStoredExpiry("not json")).toBe("not json");
    expect(withStoredExpiry("[1]")).toBe("[1]");
    // a null expiry with no usable exp claim stays null (the SDK then never refreshes it; Auth still verifies the token)
    const noExp = JSON.stringify({ access_token: "not-a-jwt", refresh_token: "r", expires_at: null });
    expect(withUsableExpiry(noExp)).toBe(noExp);
  });
  it("A4 (C4): a value that needs two chunks while it carries a numeric expiry and one when its expiry is null changes its chunk count on rewrite, and the plan leaves exactly the new layout", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `h.${b64({ sub: "u", exp: 4_000_000_000 })}.sig`;
    // grow a padded session until its numeric form needs two chunks while the null form still fits in one
    let pad = 0;
    const numericOf = (n: number) => JSON.stringify({ access_token: token, refresh_token: "r", expires_at: 4_000_000_000, user: { id: "u", p: "p".repeat(n) } });
    while (createChunks(KEY, withStoredExpiry(numericOf(pad + 1))).length === 1) pad += 1;
    const numeric = numericOf(pad + 1);
    const stored = withStoredExpiry(numeric);
    if (createChunks(KEY, numeric).length === 1) throw new Error("fixture: the numeric form did not cross the boundary");
    expect([createChunks(KEY, withStoredExpiry(numericOf(pad))).length, createChunks(KEY, numericOf(pad)).length]).toEqual([1, 2]);
    // the jar holds the previous writer's two chunks; this writer stores the null form, which is one bare value
    const before = createChunks(KEY, numericOf(pad)).map((c: { name: string }) => c.name);
    const plan = planSessionWrite(before, KEY, withStoredExpiry(numericOf(pad))) as CookieOperation[];
    const jar = new Map<string, string>(createChunks(KEY, numericOf(pad)).map((c: { name: string; value: string }) => [c.name, c.value]));
    for (const op of plan) {
      if (op.value === null) jar.delete(op.name);
      else jar.set(op.name, op.value);
    }
    const layout = readSessionLayout(Array.from(jar, ([name, value]) => ({ name, value })), KEY);
    expect([layout.kind, layout.kind === "present" ? layout.shape : null]).toEqual(["present", "bare"]);
    expect(layout.kind === "present" && readEnvelope(layout.value)?.expiresAt).toBe(4_000_000_000);
    expect(stored.length).toBeLessThan(numeric.length);
  });
  it("jwtClaims decodes sub, session_id and exp without verification; garbage gives nulls, never a throw", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(jwtClaims(`h.${b64({ sub: "u1", session_id: "s1", exp: 9 })}.sig`)).toEqual({ sub: "u1", sessionId: "s1", exp: 9 });
    for (const garbage of ["", "a.b", "a.%%%.c", `a.${"x".repeat(20000)}.c`, `a.${b64("str")}.c`]) expect(jwtClaims(garbage)).toEqual({ sub: null, sessionId: null, exp: null });
  });
  it("sessionCookieKey uses the first host label, as supabase-js derives its default", () => {
    expect(sessionCookieKey(" http://127.0.0.1:54329 ")).toBe(KEY);
    expect(sessionCookieKey("https://abcdefghijklmnopqrst.supabase.co")).toBe("sb-abcdefghijklmnopqrst-auth-token");
  });
});

describe("safeResumeTarget: open-redirect negatives (AM-R5)", () => {
  for (const raw of ["//evil.example", "/.//evil.example", "/%2e//evil.example", "/.\\/evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "https://evil.example/x", "javascript:alert(1)", "dashboard", "", null, "/auth/resume", "/auth/resume?next=/x", "/" + "x".repeat(2100)]) {
    it(`refuses ${JSON.stringify(raw)?.slice(0, 40)} → /dashboard`, () => expect(safeResumeTarget(raw as string | null, ORIGIN)).toBe("/dashboard"));
  }
  for (const [raw, out] of [["/drills", "/drills"], ["/drills?x=1", "/drills?x=1"], ["/bag/../drills", "/drills"], ["/dashboard#frag", "/dashboard"]] as const) {
    it(`keeps ${raw} → ${out}`, () => expect(safeResumeTarget(raw, ORIGIN)).toBe(out));
  }
});
