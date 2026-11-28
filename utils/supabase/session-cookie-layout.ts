import { createChunks } from "@supabase/ssr";

// ============================================================================
// Session cookie layout (shared by every reader and the one writer)
// ============================================================================
//
// The browser session is one JSON value stored under the SDK storage key
// `sb-<project ref>-auth-token`, either whole (the bare key) or split by
// @supabase/ssr's createChunks into `<key>.0` … `<key>.<n-1>` (each encoded
// chunk at most 3180 characters). This module is the single definition of
// which cookie jars hold a session, used alike by the browser storage
// (utils/supabase/session-storage.ts), the server verifier
// (utils/supabase/server.ts), the middleware (utils/supabase/session-resume.ts)
// and End Session (app/api/auth/signout/route.ts), together with the binding
// cookie below.
//
// A jar holds a session only in exactly one complete layout: the bare key and
// nothing else, or `.0` … `.n-1` (n ≤ 16) with no gap, no extra index and no
// bare key. Anything else — a bare key beside chunks (an older bare session
// shadowing a newer chunked one, as @supabase/ssr 0.3.0's own writer leaves
// behind), a gap, a stray higher index, a duplicated or undecodable name, an
// empty value, or a malformed family member (`<key>.` followed by anything but
// canonical digits: `.00`, `.01`, `.x`, more than four digits) — is ambiguous,
// and an ambiguous jar holds no session for anyone: it is never joined,
// refreshed or verified, only removed. Every family member, malformed or not, is
// a family name: it makes a jar ambiguous, and every removal removes it.
//
// The writer (browser only) replaces a layout in an order in which a reader
// (in this tab or another) sees the old session, an ambiguous jar, or the new
// session — never no session (so an absent jar always means a real removal,
// never a replacement in progress) and never a complete layout joining two
// sessions: a new bare value is written first and the old names removed after
// it; a new chunked value removes the old head `.0`, writes the new tail,
// removes the old names it does not reuse, and writes the new head last. A
// value that would need more than 16 chunks is never written, so the writer
// never acknowledges a layout the readers cannot read.
//
// Values here are transport only. The access token is verified by Auth before
// it identifies anyone; the other fields steer local bookkeeping and never
// authorise anything.
//
// The BINDING cookie (`swingproai-session-binding`) is the server-visible half
// of the browser's ordering (utils/supabase/session-lease.ts keeps the other
// half in IndexedDB, which the server cannot see). The browser's own writer
// sets it in the same synchronous step as every session write or removal it
// makes: the SHA-256 of the access token it stored, or "none" after a removal.
// It is never removed. Writers outside the contract — a tab still running a
// previous bundle, which knows nothing of it — change the session cookies but
// not the binding, so once this browser has run the current writer once, a
// session written by anything else no longer matches it, and the server and
// the middleware treat such a jar as unsettled (it identifies no one until the
// browser's own writer stores a session again). A jar with no binding at all
// was last written before the current writer ever ran in this browser: it is
// read as before (the pre-migration state). The binding is a digest of a token
// the same jar already carries, so it reveals nothing new; it is never
// authority — the access token is still verified by Auth.

/** OP-1 (owner grant): the lifetime of the session cookies, 30 days. */
export const SESSION_COOKIE_MAX_AGE_S = 2_592_000;
/** More chunks than this is not a session this application wrote; the writer refuses to write more. */
export const MAX_SESSION_CHUNKS = 16;

/** The /auth/resume page, where an expiring session is refreshed by the browser (see session-resume.ts). */
export const RESUME_PATH = "/auth/resume";
/** Set by /auth/resume for one minute after it has resumed a session: the middleware does not send it back there. */
export const RESUME_MARKER_COOKIE = "swingproai-session-resumed";
export const RESUME_MARKER_MAX_AGE_S = 60;

/** The SDK storage key for a project URL, derived as supabase-js derives its default (trimmed URL, first host label). */
export function sessionCookieKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl.trim()).hostname.split(".")[0]}-auth-token`;
}

/** The auth storage roots the SDK may write under one key (the session, the PKCE verifier, the separate user). */
export function authStorageRoots(key: string): string[] {
  return [key, `${key}-code-verifier`, `${key}-user`];
}

/**
 * How `name` belongs to the family of `root`: "bare" for the root itself, the chunk index for `<root>.<canonical
 * digits>`, "malformed" for any other `<root>.<suffix>` (".00" is not chunk 0; ".x", "." and five or more digits are no
 * chunk at all), otherwise null (not a family member).
 */
export function familyMember(name: string, root: string): "bare" | number | "malformed" | null {
  if (name === root) return "bare";
  if (!name.startsWith(`${root}.`)) return null;
  const digits = name.slice(root.length + 1);
  return /^(0|[1-9]\d{0,3})$/.test(digits) ? Number(digits) : "malformed";
}

export interface CookiePair {
  readonly name: string;
  /** decodeURIComponent of the value; null when the pair has no "=" or does not decode */
  readonly value: string | null;
}

/** Splits a Cookie header (or document.cookie) exactly as Next's parser splits pairs, keeping duplicates. */
export function parseCookieHeader(header: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const raw of header.split(/; */)) {
    if (!raw) continue;
    const at = raw.indexOf("=");
    if (at === -1) {
      pairs.push({ name: raw.trim(), value: null });
      continue;
    }
    let value: string | null;
    try {
      value = decodeURIComponent(raw.slice(at + 1));
    } catch {
      value = null;
    }
    pairs.push({ name: raw.slice(0, at).trim(), value });
  }
  return pairs;
}

export type SessionLayout =
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous"; readonly names: readonly string[] }
  | {
      readonly kind: "present";
      /** the joined session value */
      readonly value: string;
      readonly names: readonly string[];
      readonly shape: "bare" | "chunked";
    };

/** The session layout of a jar under `key` (rules above). */
export function readSessionLayout(pairs: readonly CookiePair[], key: string): SessionLayout {
  const family = pairs.filter((pair) => familyMember(pair.name, key) !== null);
  if (family.length === 0) return { kind: "absent" };
  const names = family.map((pair) => pair.name);
  const ambiguous = { kind: "ambiguous", names } as const;
  if (new Set(names).size !== names.length) return ambiguous;
  if (family.some((pair) => pair.value === null || pair.value === "")) return ambiguous;
  if (family.some((pair) => familyMember(pair.name, key) === "malformed")) return ambiguous;
  const bare = family.find((pair) => pair.name === key);
  if (bare) return family.length === 1 ? { kind: "present", value: bare.value as string, names, shape: "bare" } : ambiguous;
  const chunks: string[] = [];
  for (const pair of family) {
    const index = familyMember(pair.name, key) as number;
    if (index >= MAX_SESSION_CHUNKS) return ambiguous;
    chunks[index] = pair.value as string;
  }
  for (let index = 0; index < family.length; index++) if (chunks[index] === undefined) return ambiguous;
  return { kind: "present", value: chunks.join(""), names, shape: "chunked" };
}

/** Every distinct cookie name present in the family of any of the roots (malformed members included), in jar order. */
export function familyNames(pairs: readonly CookiePair[], roots: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const pair of pairs) if (roots.some((root) => familyMember(pair.name, root) !== null)) seen.add(pair.name);
  return Array.from(seen);
}

export interface CookieOperation {
  readonly name: string;
  /** null: remove the name */
  readonly value: string | null;
}

const isHead = (name: string, key: string) => name === key || name === `${key}.0`;

/** Removing a family: heads first, so no reader can join what remains while the rest goes. */
export function planFamilyRemoval(presentNames: readonly string[], key: string): CookieOperation[] {
  const heads = presentNames.filter((name) => isHead(name, key));
  const rest = presentNames.filter((name) => !isHead(name, key));
  return [...heads, ...rest].map((name) => ({ name, value: null }));
}

/**
 * Replacing whatever the family holds (`presentNames`, malformed members included) with `value` in @supabase/ssr's own
 * chunk layout, or null when `value` would need more than MAX_SESSION_CHUNKS chunks (never written: no reader could
 * read it). Every intermediate jar is the old layout, an ambiguous jar, or the new layout (see the header):
 * - bare value: write the bare key (over any old chunks the jar is ambiguous), then remove every other old name;
 * - chunked value (always two or more chunks): remove the old head `.0`, write the new tail, remove every old name the
 *   new layout does not reuse (the jar stays headless, so ambiguous), then write the new head `.0`.
 */
export function planSessionWrite(presentNames: readonly string[], key: string, value: string): CookieOperation[] | null {
  const chunks = createChunks(key, value);
  if (chunks.length > MAX_SESSION_CHUNKS) return null;
  const kept = new Set(chunks.map((chunk) => chunk.name));
  if (chunks.length === 1 && chunks[0].name === key) {
    return [
      { name: key, value: chunks[0].value },
      ...presentNames.filter((name) => name !== key).map((name) => ({ name, value: null })),
    ];
  }
  const head = chunks.find((chunk) => chunk.name === `${key}.0`);
  const tail = chunks.filter((chunk) => chunk.name !== `${key}.0`);
  return [
    ...presentNames.filter((name) => name === `${key}.0`).map((name) => ({ name, value: null })),
    ...tail.map((chunk) => ({ name: chunk.name, value: chunk.value })),
    ...presentNames.filter((name) => name !== `${key}.0` && !kept.has(name)).map((name) => ({ name, value: null })),
    ...(head ? [{ name: head.name, value: head.value }] : []),
  ];
}

/** The binding cookie (see the header). */
export const SESSION_BINDING_COOKIE = "swingproai-session-binding";
/** The binding after a removal: the browser's own writer recorded that it holds no session. */
export const NO_SESSION_BINDING = "none";
const BINDING_FORMAT = /^(none|[0-9a-f]{64})$/;

/** The binding of a session: hex SHA-256 of "swingproai-binding:" + its access token; null without SubtleCrypto. */
export async function sessionBinding(accessToken: string): Promise<string | null> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (!subtle) return null;
  try {
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`swingproai-binding:${accessToken}`)));
    let text = "";
    for (let at = 0; at < bytes.length; at++) text += bytes[at].toString(16).padStart(2, "0");
    return text;
  } catch {
    return null;
  }
}

export type BindingRead =
  | { readonly kind: "absent" }
  /** duplicated, undecodable or not a binding value: it vouches for nothing */
  | { readonly kind: "ambiguous" }
  | { readonly kind: "present"; readonly value: string };

/** The binding cookie of a jar. */
export function readBinding(pairs: readonly CookiePair[]): BindingRead {
  const found = pairs.filter((pair) => pair.name === SESSION_BINDING_COOKIE);
  if (found.length === 0) return { kind: "absent" };
  if (found.length > 1) return { kind: "ambiguous" };
  const value = found[0].value;
  return value !== null && BINDING_FORMAT.test(value) ? { kind: "present", value } : { kind: "ambiguous" };
}

/**
 * Whether a jar's binding admits the session it carries (server and middleware): "bound" — the binding names this
 * access token; "legacy" — no binding (written before the current writer ran in this browser); "mismatch" — any other
 * binding (a session written outside the contract, or a removal recorded since); "unverifiable" — no SubtleCrypto here.
 */
export async function bindingAdmits(pairs: readonly CookiePair[], accessToken: string): Promise<"bound" | "legacy" | "mismatch" | "unverifiable"> {
  const binding = readBinding(pairs);
  if (binding.kind === "absent") return "legacy";
  if (binding.kind === "ambiguous" || binding.value === NO_SESSION_BINDING) return "mismatch";
  const expected = await sessionBinding(accessToken);
  if (expected === null) return "unverifiable";
  return expected === binding.value ? "bound" : "mismatch";
}

// ─── Session lineage and End Session completion (A2) ──────────────────────────────────────────────────────────────
//
// A session LINEAGE is one Auth session: the session_id its access tokens state. A refresh continues it (same id); a
// new sign-in — even of the same golfer — starts another. End Session names the lineage it ends by a digest of that id
// (never the id, a token or a user id): the page's End Session form carries the lineage the server rendered it for,
// and after the server has revoked exactly that lineage without being able to clear the browser's copy (no
// JavaScript, before hydration, or no lease), it sets the END INTENT cookie to the same digest. That cookie is only an
// instruction to this browser's own writer: on the sign-in page, under the session-publication lease, remove the jar's
// session IF it is still that lineage, then delete the cookie (single use). It removes nothing by itself, names no
// credential, and a jar holding any other lineage (another golfer, or a newer sign-in of the same one) is left alone.

/**
 * The End Session completion instruction (see above): the ended lineage's digest; never a credential. It lives as long
 * as the session cookies it may have to remove (so a golfer who turns JavaScript on later still gets the removal); it is
 * single-use and can only ever remove that one ended lineage.
 */
export const END_INTENT_COOKIE = "swingproai-session-ended";
export const END_INTENT_MAX_AGE_S = SESSION_COOKIE_MAX_AGE_S;
const LINEAGE_ID_FORMAT = /^[0-9a-f]{64}$/;

/** Whether a value is a lineage digest as sessionLineageId writes it (64 lowercase hex characters). */
export function isSessionLineageId(value: unknown): value is string {
  return typeof value === "string" && LINEAGE_ID_FORMAT.test(value);
}

/**
 * The lineage digest of the session an access token belongs to: hex SHA-256 of "swingproai-session-lineage:" + its
 * session_id claim (read without verification: it only names which local copy is meant). Null when the token states
 * no session id, or without SubtleCrypto — nothing can then be matched, so nothing is ended by lineage.
 */
export async function sessionLineageId(accessToken: string): Promise<string | null> {
  const sessionId = jwtClaims(accessToken).sessionId;
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (sessionId === null || !subtle) return null;
  try {
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`swingproai-session-lineage:${sessionId}`)));
    let text = "";
    for (let at = 0; at < bytes.length; at++) text += bytes[at].toString(16).padStart(2, "0");
    return text;
  } catch {
    return null;
  }
}

/** The END INTENT a jar carries: exactly one well-formed value, else null (duplicated or malformed: no instruction). */
export function readEndIntent(pairs: readonly CookiePair[]): string | null {
  const found = pairs.filter((pair) => pair.name === END_INTENT_COOKIE);
  if (found.length !== 1) return null;
  const value = found[0].value;
  return isSessionLineageId(value) ? value : null;
}

// ─── A4 (C4): the stored expiry is null ──────────────────────────────────────────────────────────────────────────
//
// The browser's own writer stores every session with its `expires_at` key PRESENT and set to null (withStoredExpiry).
// A tab still running a previous bundle reads the same cookie with the installed auth-js 2.107.0, which keeps a stored
// session only when the key exists (`_isValidSession`: `'expires_at' in session` — deleting the key would make that SDK
// REMOVE the session as invalid) and decides every automatic refresh from its value: start-up recovery
// (`_recoverAndRefresh`: a null expiry is "not expiring"), session reads (`__loadSession`: null is "not expired") and
// the ticker (`_autoRefreshTokenTick`: no expiry, no refresh). So a previous bundle's page never refreshes — and so never
// writes — a session this writer stored; its own explicit actions (a sign-in, a sign-out, a refresh already running
// when this writer stored the session) still can, and still meet the binding fence.
//
// Every current reader reconstructs the expiry from the access token's own `exp` claim (decoded without verification,
// like every other claim here; never authority): readEnvelope below — so the middleware's resume routing, SessionKeeper's
// upkeep and action gate, and the refresh transport's local answers — and the browser storage, which hands the SDK the
// session with `expires_at` set to that claim (withUsableExpiry). Supabase Auth's token answers state an `expires_at` that
// the installed auth-js keeps as given, and Auth derives it from the same expiry it signs into the access token's `exp`;
// that equality is the open-source Auth server's behaviour and the loopback stand-in's, NOT an observation of the hosted
// project (no hosted probe was made). A value with a numeric `expires_at` (written before
// this writer ran, or by a previous bundle) is read as stored. Expiry decides only WHEN the browser refreshes; it never
// admits a session: the lineage record, the binding cookie and the server's Auth verification are unchanged.

/** The stored form of a session value this writer stores: `expires_at` kept as a key, set to null (see above). */
export function withStoredExpiry(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), expires_at: null });
  } catch {
    return value;
  }
}

/** The session value as the SDK is handed it: a null stored expiry replaced by the access token's `exp` claim. */
export function withUsableExpiry(value: string): string {
  const envelope = readEnvelope(value);
  if (envelope === null || envelope.stored["expires_at"] !== null || envelope.expiresAt === null) return value;
  return JSON.stringify({ ...envelope.stored, expires_at: envelope.expiresAt });
}

export interface SessionEnvelope {
  readonly accessToken: string;
  readonly refreshToken: string;
  /**
   * seconds since the epoch: as stored when it is a finite positive number; A4 (C4) — when it is stored as null, the
   * access token's `exp` claim (see above); otherwise null
   */
  readonly expiresAt: number | null;
  /** the parsed stored object, for a local answer that repeats the stored session */
  readonly stored: Record<string, unknown>;
}

const usableSeconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** Transport parse of a stored session value: the two tokens must be non-empty strings. Never authority. */
export function readEnvelope(value: string): SessionEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stored = parsed as Record<string, unknown>;
  const accessToken = stored["access_token"];
  const refreshToken = stored["refresh_token"];
  const expiresAt = stored["expires_at"];
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAt === null ? usableSeconds(jwtClaims(accessToken).exp) : usableSeconds(expiresAt),
    stored,
  };
}

export interface TokenClaims {
  readonly sub: string | null;
  readonly sessionId: string | null;
  readonly exp: number | null;
}

/**
 * The `sub`, `session_id` and `exp` claims of a JWT, decoded WITHOUT verification. Used only to decide which local
 * copy belongs to which sign-in (End Session's account check, the lineage of a session) — never as identity: a
 * forged token only changes what its own holder's browser does with its own cookies.
 */
export function jwtClaims(token: string): TokenClaims {
  const none = { sub: null, sessionId: null, exp: null };
  try {
    const part = token.split(".")[1];
    if (!part || part.length > 16_384) return none;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object") return none;
    const { sub, session_id: sessionId, exp } = payload as Record<string, unknown>;
    return {
      sub: typeof sub === "string" && sub.length > 0 ? sub : null,
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
      exp: typeof exp === "number" && Number.isFinite(exp) ? exp : null,
    };
  } catch {
    return none;
  }
}

/**
 * A same-origin path to continue to after /auth/resume, or /dashboard. Never another origin, never /auth/resume. The
 * check is made on the NORMALISED result: the URL parser removes dot segments and turns backslashes into slashes, so
 * "/.//x", "/%2e//x" or "/.\/x" all become "//x" — a scheme-relative URL to another host — and are refused; the
 * result is parsed once more and must still resolve to this origin.
 */
export function safeResumeTarget(raw: string | null, origin: string): string {
  if (!raw || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/dashboard";
  try {
    const url = new URL(raw, origin);
    const target = `${url.pathname}${url.search}`;
    if (url.origin !== origin || url.pathname === RESUME_PATH) return "/dashboard";
    if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return "/dashboard";
    return new URL(target, origin).origin === origin ? target : "/dashboard";
  } catch {
    return "/dashboard";
  }
}
