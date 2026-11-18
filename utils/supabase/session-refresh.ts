import { NextResponse, type NextRequest } from "next/server";
import { createChunks, createServerClient } from "@supabase/ssr";

// ============================================================================
// Session refresh boundary (middleware only)
// ============================================================================
//
// When a protected page request carries a well-formed session cookie whose
// access token is due to expire, this boundary asks Supabase Auth for a new
// session with the stored refresh token, forwards the new cookie to the same
// request's server code (Next's request-header override) and sends it to the
// browser with Set-Cookie.
//
// It is NOT an authentication gate and never decides who the caller is. The
// shared verifier in utils/supabase/server.ts still checks the access token
// with Auth on every request; the cookie stays a caller-controlled transport
// envelope. This module never reads the session's identity fields, never
// redirects or rewrites, never returns a body, and adds no response header
// other than Set-Cookie for the session cookie family. Any failure means "no
// refresh": a plain NextResponse.next().
//
// Clearing happens only on a definitive, coded Auth rejection of the refresh
// token (a real 400/401/403 carrying one of four codes). Every other failure
// leaves the cookie exactly as it was.
//
// Every Auth answer is rewritten before the SDK sees it (the response
// normalization boundary): the SDK only ever receives a valid session to save,
// or a short fixed body built from bytes with no headers. So no SDK error, and
// nothing the SDK prints, can carry response content.
//
// The SDK's retry sleep cannot be cancelled. The bounded fetch is therefore
// sealed before this function returns; after that it never dispatches again
// and answers any late SDK call locally.
//
// Imported only by middleware.ts. It must not import the verifier module.

// ── settings (engineer choices; design inputs, not hosted limits) ───────────
/** T_a: the longest a single refresh dispatch may run. */
const PER_DISPATCH_MS = 3_000;
/** K: the most real refresh dispatches per request. */
const MAX_DISPATCHES = 2;
/** T_b: the overall deadline for the refresh, from the start of the request. */
const DEADLINE_MS = 5_000;
/** Body-read caps for normalization. */
const NON_OK_BODY_CAP = 16 * 1024;
const SESSION_BODY_CAP = 64 * 1024;
/** OP-1 (owner grant): the lifetime of cookies this boundary writes, 30 days. */
const COOKIE_MAX_AGE_S = 2_592_000;
/** The SDK's own expiry margin (auth-js EXPIRY_MARGIN_MS). */
const REFRESH_MARGIN_MS = 90_000;

// ── fixed texts handed to the SDK; never request, response or token data ────
const FIXED_REJECT_TEXT = "Auth refresh rejected";
const FIXED_FAIL_TEXT = "Auth refresh failed";
const FIXED_LOCAL_TEXT = "Auth refresh not completed";

/** OP-8: the only Auth answers that may clear a session cookie (with 400/401/403). */
const ALLOWED_CODES: readonly string[] = Object.freeze([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
]);
const REJECTION_STATUSES: readonly number[] = Object.freeze([400, 401, 403]);
/** The statuses auth-js treats as retryable network failures (fetch.js NETWORK_ERROR_CODES). */
const NETWORK_STATUSES: readonly number[] = Object.freeze([502, 503, 504, 520, 521, 522, 523, 524, 530]);
/** auth-js API_VERSION_REGEX and the 2024-01-01 version timestamp. */
const API_VERSION_REGEX = /^2[0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|1[0-9]|2[0-9]|3[0-1])$/i;
const API_VERSION_2024_01_01 = Date.parse("2024-01-01T00:00:00.0Z");

type Outcome =
  | "skip_bearer"
  | "skip_absent"
  | "unusable"
  | "fresh"
  | "refreshed"
  | "rejected"
  | "unavailable"
  | "error";
type LocalReason =
  | "timeout_retryable"
  | "unparseable_2xx"
  | "exhausted"
  | "deadline"
  | "sealed"
  | "malformed_2xx"
  | "unexpected_status"
  | "internal";
type CodeClass = "none" | "other" | "refresh_token_not_found" | "refresh_token_already_used" | "session_not_found" | "session_expired";
type Committed = "none" | "refreshed" | "rejected";

/** The per-request record. Request fields are frozen at seal. */
interface RefreshRecord {
  dispatches: number;
  invocations_before_seal: number;
  local_by_reason: Partial<Record<LocalReason, number>>;
  /** whether every dispatch ended with a fully seen Auth answer */
  remote: "none" | "known" | "unknown";
  /** the last real HTTP status (never a local answer's) */
  status: number | null;
  /** the code class of the last real answer, computed with the SDK's own rule */
  code_class: CodeClass;
  /** what the SDK received last: a real answer, a local one, or nothing */
  last: "none" | "real" | "local";
  /** the last answer was a real 2xx session passed through to the SDK */
  last_session: boolean;
  ms_to_seal: number | null;
}

// ── cookie header parsing (exactly as Next's parseCookie splits pairs) ──────
interface RawPair {
  /** the pair exactly as it appeared in the header */
  readonly raw: string;
  readonly name: string;
  /** the undecoded value, or null for a pair without "=" */
  readonly value: string | null;
}

function splitCookieHeader(header: string): RawPair[] {
  const pairs: RawPair[] = [];
  for (const raw of header.split(/; */)) {
    if (!raw) continue;
    const at = raw.indexOf("=");
    pairs.push(at === -1 ? { raw, name: raw, value: null } : { raw, name: raw.slice(0, at), value: raw.slice(at + 1) });
  }
  return pairs;
}

/** The session cookie name, derived exactly as supabase-js derives its default storage key. */
export function sessionCookieKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

function isFamilyName(name: string, key: string): boolean {
  if (name === key) return true;
  if (!name.startsWith(`${key}.`)) return false;
  return /^\d+$/.test(name.slice(key.length + 1));
}

type FamilyRead =
  | { readonly kind: "skip_absent" | "unusable" }
  | {
      readonly kind: "present";
      readonly pairs: RawPair[];
      /** decoded family values by name */
      readonly family: Map<string, string>;
      /** decoded non-family values by name, as Next's parser keeps them */
      readonly others: Map<string, string>;
    };

function readFamily(header: string, key: string): FamilyRead {
  const pairs = splitCookieHeader(header);
  const family = new Map<string, string>();
  const others = new Map<string, string>();
  for (const pair of pairs) {
    const decoded = (() => {
      if (pair.value === null) return "true";
      try {
        return decodeURIComponent(pair.value);
      } catch {
        return null;
      }
    })();
    if (isFamilyName(pair.name, key)) {
      // a duplicated or undecodable family name is refused outright (cookie tossing)
      if (family.has(pair.name) || decoded === null) return { kind: "unusable" };
      family.set(pair.name, decoded);
    } else if (decoded !== null) {
      others.set(pair.name, decoded);
    }
  }
  if (family.size === 0) return { kind: "skip_absent" };
  return { kind: "present", pairs, family, others };
}

/** Joins family values exactly as @supabase/ssr 0.3.0 combineChunks does. */
function joinFamily(values: Map<string, string>, key: string): string | undefined {
  const bare = values.get(key);
  if (bare) return bare;
  const parts: string[] = [];
  for (let index = 0; ; index++) {
    const chunk = values.get(`${key}.${index}`);
    if (!chunk) break;
    parts.push(chunk);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** Envelope pre-check: transport validation only, never authority. */
function checkEnvelope(joined: string | undefined): "due" | "fresh" | "unusable" {
  if (!joined) return "unusable";
  let parsed: unknown;
  try {
    parsed = JSON.parse(joined);
  } catch {
    return "unusable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unusable";
  const envelope = parsed as Record<string, unknown>;
  const accessToken = envelope["access_token"];
  const refreshToken = envelope["refresh_token"];
  const expiresAt = envelope["expires_at"];
  if (typeof accessToken !== "string" || accessToken.length === 0) return "unusable";
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return "unusable";
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return "unusable";
  return expiresAt * 1000 - Date.now() >= REFRESH_MARGIN_MS ? "fresh" : "due";
}

function requestKind(headers: Headers): "action" | "prefetch" | "rsc" | "document" {
  if (headers.has("next-action")) return "action";
  if (headers.has("next-router-prefetch")) return "prefetch";
  if (headers.has("rsc")) return "rsc";
  return "document";
}

// ── the virtual family image (exact 0.3.0 get/set/remove shape) ─────────────
function familyImage(key: string, initial: Map<string, string>, others: Map<string, string>) {
  let image = new Map(initial);
  const ignored = { set: 0, remove: 0 };
  const get = (name: string): string | undefined => (isFamilyName(name, key) ? image.get(name) : others.get(name));
  const set = (name: string, value: string): void => {
    if (!isFamilyName(name, key)) {
      ignored.set += 1;
      return;
    }
    // 0.3.0 writes chunks in order, so the bare key or chunk 0 starts a new image
    if (name === key || name === `${key}.0`) image = new Map([[name, value]]);
    else image.set(name, value);
  };
  const remove = (name: string): void => {
    if (!isFamilyName(name, key)) {
      ignored.remove += 1;
      return;
    }
    // any family removal empties the image, so a later read cannot re-find the old session
    image = new Map();
  };
  return { cookies: { get, set, remove }, snapshot: () => new Map(image), ignored };
}

// ── the bounded fetch ───────────────────────────────────────────────────────
const bytesOf = (text: string) => new TextEncoder().encode(text);

/** L-R: retryable local answer (503, empty body, no headers). */
const localRetryable = (): Response => new Response(null, { status: 503 });
/** L-N: non-retryable local answer (500, fixed body, no headers). */
const localFinal = (): Response => new Response(bytesOf(JSON.stringify({ msg: FIXED_LOCAL_TEXT })), { status: 500 });

type BodyRead = { readonly kind: "bytes"; readonly bytes: Uint8Array<ArrayBuffer> } | { readonly kind: "over_cap" | "unreadable" };

/** Reads at most `cap` bytes of a body, then cancels the stream; never an unbounded text() or json(). */
async function readCapped(response: Response, cap: number): Promise<BodyRead> {
  if (!response.body) return { kind: "bytes", bytes: new Uint8Array(0) };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel().catch(() => undefined);
        return { kind: "over_cap" };
      }
      parts.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return { kind: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { kind: "bytes", bytes };
}

/** Cancels a body the SDK will never see, without waiting for the cancel to settle. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Decodes as Response.json() would (UTF-8, a leading BOM removed). A body that is not JSON gives
 * `parsed: false`; any other exception is unexpected and reaches the wrapper's `internal` answer.
 */
function parseJsonBytes(bytes: Uint8Array): { readonly parsed: true; readonly value: unknown } | { readonly parsed: false } {
  const decoded = new TextDecoder("utf-8").decode(bytes);
  try {
    return { parsed: true, value: JSON.parse(decoded) };
  } catch (failure) {
    if (failure instanceof SyntaxError) return { parsed: false };
    throw failure;
  }
}

/** auth-js hasSession (fetch.js): a truthy access_token, refresh_token and expires_in. */
function satisfiesHasSession(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return !!data["access_token"] && !!data["refresh_token"] && !!data["expires_in"];
}

/** The code class: an exact mirror of auth-js handleError's code rule, reduced to the allow-list. */
function codeClassOf(versionHeader: string | null, data: unknown): CodeClass {
  let date: Date | null = null;
  if (versionHeader && versionHeader.match(API_VERSION_REGEX)) {
    try {
      date = new Date(`${versionHeader}T00:00:00.0Z`);
    } catch {
      date = null;
    }
  }
  const body = typeof data === "object" && data ? (data as Record<string, unknown>) : null;
  let raw: unknown = undefined;
  if (date && date.getTime() >= API_VERSION_2024_01_01 && body && typeof body["code"] === "string") raw = body["code"];
  else if (body && typeof body["error_code"] === "string") raw = body["error_code"];
  if (typeof raw !== "string" || raw.length === 0) return "none";
  return ALLOWED_CODES.includes(raw) ? (raw as CodeClass) : "other";
}

function boundedRefresh(startedAt: number) {
  const record: RefreshRecord = {
    dispatches: 0,
    invocations_before_seal: 0,
    local_by_reason: {},
    remote: "none",
    status: null,
    code_class: "none",
    last: "none",
    last_session: false,
    ms_to_seal: null,
  };
  const inflight = new Set<AbortController>();
  let sealed = false;
  let frozen: Readonly<RefreshRecord> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const elapsed = () => Date.now() - startedAt;
  const timeLeft = () => elapsed() < DEADLINE_MS;
  const markUnknown = () => {
    record.remote = "unknown";
  };
  const markKnown = () => {
    if (record.remote === "none") record.remote = "known";
  };
  const local = (reason: LocalReason, retryable: boolean): Response => {
    if (!sealed) {
      record.local_by_reason[reason] = (record.local_by_reason[reason] ?? 0) + 1;
      record.last = "local";
      record.last_session = false;
    }
    return retryable ? localRetryable() : localFinal();
  };
  const real = (status: number, codeClass: CodeClass, session: boolean) => {
    if (sealed) return;
    record.status = status;
    record.code_class = codeClass;
    record.last = "real";
    record.last_session = session;
  };

  function seal(reason: "classified" | "deadline" | "finally"): Readonly<RefreshRecord> {
    if (!sealed) {
      if (reason === "deadline" && inflight.size > 0) {
        record.local_by_reason.deadline = (record.local_by_reason.deadline ?? 0) + inflight.size;
        record.last = "local";
        record.last_session = false;
        markUnknown();
      }
      record.ms_to_seal = elapsed();
      frozen = Object.freeze({ ...record, local_by_reason: Object.freeze({ ...record.local_by_reason }) });
      sealed = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      inflight.forEach((controller) => controller.abort());
    }
    return frozen as Readonly<RefreshRecord>;
  }

  /** Answers the 2xx, network-status and other real answers; runs before the wrapper's promise resolves. */
  async function normalize(response: Response): Promise<Response> {
    const status = response.status;
    if (response.type === "opaqueredirect" || status < 200 || (status >= 300 && status <= 399)) {
      discardBody(response);
      real(status, "none", false);
      markKnown();
      return local("unexpected_status", false);
    }
    if (status >= 200 && status <= 299) {
      const body = await readCapped(response, SESSION_BODY_CAP);
      if (sealed) return localFinal();
      real(status, "none", false);
      if (body.kind === "unreadable") markUnknown();
      else markKnown();
      const parsed = body.kind === "bytes" ? parseJsonBytes(body.bytes) : ({ parsed: false } as const);
      if (body.kind === "bytes" && parsed.parsed && satisfiesHasSession(parsed.value)) {
        real(status, "none", true);
        return new Response(body.bytes, { status });
      }
      if (parsed.parsed) return local("malformed_2xx", false);
      const retry = record.dispatches < MAX_DISPATCHES && timeLeft();
      return local("unparseable_2xx", retry);
    }
    if (NETWORK_STATUSES.includes(status)) {
      discardBody(response);
      real(status, "none", false);
      markKnown();
      return new Response(null, { status });
    }
    const body = await readCapped(response, NON_OK_BODY_CAP);
    if (sealed) return localFinal();
    if (body.kind === "unreadable") markUnknown();
    else markKnown();
    const parsed = body.kind === "bytes" ? parseJsonBytes(body.bytes) : ({ parsed: false } as const);
    const codeClass = parsed.parsed ? codeClassOf(response.headers.get("X-Supabase-Api-Version"), parsed.value) : "none";
    real(status, codeClass, false);
    const fixed = ALLOWED_CODES.includes(codeClass) ? { msg: FIXED_REJECT_TEXT, error_code: codeClass } : { msg: FIXED_FAIL_TEXT };
    return new Response(bytesOf(JSON.stringify(fixed)), { status });
  }

  /** The fetch handed to the SDK. It never throws, and nothing raw reaches the SDK. */
  async function fetchForSdk(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      if (sealed) return localFinal();
      record.invocations_before_seal += 1;
      if (record.dispatches >= MAX_DISPATCHES) return local("exhausted", false);
      record.dispatches += 1;
      const controller = new AbortController();
      inflight.add(controller);
      const remaining = DEADLINE_MS - elapsed();
      // with too little time left for a full per-dispatch budget, only the deadline aborts
      const timer = remaining > PER_DISPATCH_MS ? setTimeout(() => controller.abort(), PER_DISPATCH_MS) : null;
      try {
        const platformFetch = globalThis.fetch;
        let response: Response;
        try {
          response = await platformFetch(input, { ...init, redirect: "manual", signal: controller.signal });
        } catch {
          if (sealed) return localFinal();
          markUnknown();
          const retry = record.dispatches < MAX_DISPATCHES && timeLeft();
          return retry ? local("timeout_retryable", true) : local("exhausted", false);
        }
        if (sealed) {
          discardBody(response);
          return localFinal();
        }
        return await normalize(response);
      } finally {
        if (timer !== null) clearTimeout(timer);
        inflight.delete(controller);
      }
    } catch {
      return local("internal", false);
    }
  }

  type Settled = { readonly kind: "resolved"; readonly session: boolean } | { readonly kind: "failed" | "deadline" };

  /** Races the SDK's session load against the overall deadline; the deadline seals in the same callback. */
  function race(load: Promise<{ data: { session: unknown | null } }>): Promise<Settled> {
    const deadline = new Promise<Settled>((resolve) => {
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        seal("deadline");
        resolve({ kind: "deadline" });
      }, Math.max(0, DEADLINE_MS - elapsed()));
    });
    const loaded = load.then(
      (result): Settled => ({ kind: "resolved", session: !!result?.data?.session }),
      (): Settled => ({ kind: "failed" }),
    );
    return Promise.race([loaded, deadline]);
  }

  return { fetch: fetchForSdk, seal, race, isSealed: () => sealed };
}

function classify(record: Readonly<RefreshRecord>, settled: { kind: string; session?: boolean }): Outcome {
  if (settled.kind === "resolved" && settled.session && record.last === "real" && record.last_session) return "refreshed";
  if (
    record.last === "real" &&
    record.status !== null &&
    REJECTION_STATUSES.includes(record.status) &&
    ALLOWED_CODES.includes(record.code_class)
  ) {
    return "rejected";
  }
  return "unavailable";
}

/** The forwarded cookie header: the family pairs replaced, every other pair byte-for-byte as received. */
function forwardedCookieHeader(pairs: RawPair[], key: string, image: { name: string; value: string }[]): string {
  const kept = pairs.filter((pair) => !isFamilyName(pair.name, key)).map((pair) => pair.raw);
  const added = image.map((chunk) => `${chunk.name}=${encodeURIComponent(chunk.value)}`);
  return [...kept, ...added].join("; ");
}

function forwardWithCookie(request: NextRequest, cookieHeader: string): NextResponse {
  const headers = new Headers(request.headers);
  if (cookieHeader) headers.set("cookie", cookieHeader);
  else headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
}

/**
 * The middleware entry point. Returns only NextResponse.next() or
 * NextResponse.next({ request: { headers } }) carrying session-family Set-Cookie lines.
 */
export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  let outcome: Outcome = "error";
  let committed: Committed = "none";
  let refresh: ReturnType<typeof boundedRefresh> | null = null;
  let frozen: Readonly<RefreshRecord> | null = null;
  try {
    if (request.headers.has("authorization")) {
      outcome = "skip_bearer";
      return NextResponse.next();
    }
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
    const key = sessionCookieKey(supabaseUrl);
    const read = readFamily(request.headers.get("cookie") ?? "", key);
    if (read.kind !== "present") {
      outcome = read.kind;
      return NextResponse.next();
    }
    const envelope = checkEnvelope(joinFamily(read.family, key));
    if (envelope !== "due") {
      outcome = envelope;
      return NextResponse.next();
    }

    refresh = boundedRefresh(startedAt);
    const image = familyImage(key, read.family, read.others);
    const client = createServerClient(supabaseUrl, anonKey, {
      cookies: image.cookies,
      global: { fetch: refresh.fetch },
      auth: { skipAutoInitialize: true },
    });
    const settled = await refresh.race(client.auth.getSession());
    frozen = refresh.seal("classified");
    outcome = classify(frozen, settled);

    const secure = request.nextUrl.protocol === "https:";
    const presentNames = Array.from(read.family.keys());
    if (outcome === "refreshed") {
      const finalImage = image.snapshot();
      const joined = joinFamily(finalImage, key);
      const expected = joined ? createChunks(key, joined) : [];
      const matches =
        expected.length > 0 &&
        expected.length === finalImage.size &&
        expected.every((chunk) => finalImage.get(chunk.name) === chunk.value);
      if (!matches) {
        outcome = "error";
        return NextResponse.next();
      }
      const written = new Set(expected.map((chunk) => chunk.name));
      const response = forwardWithCookie(request, forwardedCookieHeader(read.pairs, key, expected));
      for (const chunk of expected) {
        response.cookies.set(chunk.name, chunk.value, { path: "/", sameSite: "lax", secure, maxAge: COOKIE_MAX_AGE_S });
      }
      for (const name of presentNames) {
        if (!written.has(name)) response.cookies.set(name, "", { path: "/", sameSite: "lax", secure, maxAge: 0 });
      }
      committed = "refreshed";
      return response;
    }
    if (outcome === "rejected") {
      const response = forwardWithCookie(request, forwardedCookieHeader(read.pairs, key, []));
      for (const name of presentNames) {
        response.cookies.set(name, "", { path: "/", sameSite: "lax", secure, maxAge: 0 });
      }
      committed = "rejected";
      return response;
    }
    return NextResponse.next();
  } catch {
    outcome = "error";
    committed = "none";
    return NextResponse.next();
  } finally {
    if (refresh) frozen = refresh.seal("finally");
    if (outcome === "refreshed" || outcome === "rejected" || outcome === "unavailable" || outcome === "error") {
      const fields = {
        outcome,
        kind: requestKind(request.headers),
        dispatches: frozen?.dispatches ?? 0,
        invocations_before_seal: frozen?.invocations_before_seal ?? 0,
        local_by_reason: frozen?.local_by_reason ?? {},
        remote: frozen?.remote ?? "none",
        status: frozen?.status ?? null,
        code_class: frozen?.code_class ?? "none",
        ms_to_seal: frozen?.ms_to_seal ?? null,
        ms_total: Date.now() - startedAt,
        committed,
      };
      console.info(`session-refresh ${JSON.stringify(fields)}`);
    }
  }
}
