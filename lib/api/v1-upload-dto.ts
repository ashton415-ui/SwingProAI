/**
 * SwingProAI — V1 upload authorization data transfer objects.
 *
 * Pure validation, path construction and response shaping for the Native
 * upload authorization endpoint. Nothing here builds a Supabase client, reads
 * a request, touches the database, or knows about Next.js — the route owns all
 * of that, and keeping this module inert is what lets every rule below be
 * tested directly rather than through a route harness.
 *
 * The single idea this module enforces: **the caller never influences where
 * bytes land**. The object path is derived from the verified user id, a
 * validated UUID, and a MIME type drawn from a closed set. No filename, no
 * caller-supplied path, no extension inherited from untrusted text.
 */

/** The bucket Native uploads target. Private, owner-folder RLS, no upsert. */
export const UPLOAD_BUCKET = "swing-videos";

/**
 * Declared-size ceiling, matching the D0 bucket restriction exactly
 * (250 MiB = 250 * 1024 * 1024). This is a pre-flight courtesy check: the
 * bucket itself is the byte authority, and finalization later reads the
 * stored object's true size. Rejecting here simply spares a caller a doomed
 * upload.
 */
export const MAX_UPLOAD_BYTES = 262144000;

/** Signed upload capability lifetime, per the installed Storage SDK contract. */
export const UPLOAD_EXPIRES_IN_SECONDS = 7200;

/** TUS chunk size. Supabase requires exactly 6 MiB; this is not tunable. */
export const UPLOAD_CHUNK_SIZE = 6291456;

/** The closed set of content types Native may declare. */
export const SUPPORTED_UPLOAD_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export type UploadMimeType = (typeof SUPPORTED_UPLOAD_MIME_TYPES)[number];

/**
 * Canonical extension per content type.
 *
 * The extension is a function of the declared MIME type and nothing else. An
 * original filename could carry `.mov` on an MP4, a double extension, or a
 * path separator; none of that can reach the object key because no filename is
 * accepted by this endpoint at all.
 */
const MIME_EXTENSION: Readonly<Record<UploadMimeType, string>> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/**
 * RFC 4122 version 4, including the variant nibble.
 *
 * The version and variant bits are checked rather than accepting any
 * hex-and-dashes shape: the upload id becomes the durable resource identity,
 * and a guessable or structured identifier would weaken the retry contract
 * that rests on it.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUploadMimeType(value: unknown): value is UploadMimeType {
  return (
    typeof value === "string" &&
    (SUPPORTED_UPLOAD_MIME_TYPES as readonly string[]).includes(value)
  );
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * A declared byte count.
 *
 * Strings are refused rather than coerced. `Number("12")` would happily accept
 * `" 12 "`, `"0x0c"` and `"1e3"`, so accepting strings would mean accepting a
 * parser, not a number.
 */
export function isValidDeclaredSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_UPLOAD_BYTES
  );
}

export interface UploadAuthorizeRequest {
  readonly uploadId: string;
  readonly mimeType: UploadMimeType;
  readonly fileSize: number;
}

/** Exactly the keys this endpoint accepts. Anything else fails the request. */
const ALLOWED_REQUEST_KEYS = ["uploadId", "mimeType", "fileSize"] as const;

/**
 * Parses an untrusted request body, or returns `null`.
 *
 * Unknown keys are rejected rather than ignored. Silently dropping an
 * unexpected `userId`, `storagePath` or `analysisMode` would let a caller
 * believe it had influenced the request when it had not — and would make a
 * future version that *did* read such a field a silent behaviour change. A
 * refused request is unambiguous.
 *
 * No value is repaired: a malformed UUID is not trimmed, an unsupported MIME
 * type is not mapped onto a supported one, and a numeric string is not parsed.
 */
export function parseUploadAuthorizeRequest(body: unknown): UploadAuthorizeRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(ALLOWED_REQUEST_KEYS as readonly string[]).includes(key)) return null;
  }
  for (const key of ALLOWED_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  }

  const { uploadId, mimeType, fileSize } = record;
  if (!isUuidV4(uploadId)) return null;
  if (!isUploadMimeType(mimeType)) return null;
  if (!isValidDeclaredSize(fileSize)) return null;

  return { uploadId, mimeType, fileSize };
}

/**
 * The object key for one authorized upload.
 *
 * `<verified user id>/<upload id>/source.<ext>` — the first segment is what the
 * Storage owner-folder policy matches against `auth.uid()`, so the database
 * independently refuses any object this function could not have produced. The
 * basename is fixed: it carries no caller data and makes the object trivially
 * locatable at finalization from the id alone.
 */
export function buildUploadObjectPath(userId: string, uploadId: string, mimeType: UploadMimeType): string {
  return `${userId}/${uploadId}/source.${MIME_EXTENSION[mimeType]}`;
}

/**
 * The direct Storage host's signed resumable (TUS) endpoint for the configured
 * project.
 *
 * The authorize route mints a path-bound token with `createSignedUploadUrl`,
 * and the client presents it as `x-signature` (with the project `apikey`)
 * against `/upload/resumable/sign`; the plain `/upload/resumable` endpoint
 * expects a user Bearer JWT instead and would not accept the signed token.
 *
 * Large uploads are told to go to `<ref>.storage.supabase.co` rather than the
 * API host, which is what Supabase recommends for throughput. The project ref
 * is derived from the configured URL rather than hard-coded so that staging and
 * local environments address themselves; returning `null` on anything
 * unexpected lets the route fail closed instead of handing a client a
 * half-formed URL or echoing configuration back.
 */
export function buildResumableEndpoint(
  supabaseUrl: string | undefined,
  options: { readonly allowLoopback?: boolean } = {},
): string | null {
  if (typeof supabaseUrl !== "string" || supabaseUrl.length === 0) return null;

  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return null;
  }
  const host = url.hostname;

  // AG-WEB-READY-10-P2-A1 local test seam (see LOCAL_LOOPBACK_UPLOAD_ENDPOINT_ENV): a disposable local stack serves
  // the same signed resumable endpoint on its own loopback API origin. Honoured only when the server opted in AND the
  // configured project URL is itself exactly a loopback http origin, so a hosted project URL can never be mapped to a
  // local endpoint (and the hosted rule below is unchanged for every other value).
  if (options.allowLoopback === true && isLoopbackApiOrigin(url, supabaseUrl)) {
    return `http://127.0.0.1:${url.port}/storage/v1/upload/resumable/sign`;
  }

  const ref = host.split(".")[0];
  if (!/^[a-z0-9]{8,}$/i.test(ref)) return null;
  if (!host.endsWith(".supabase.co")) return null;

  return `https://${ref}.storage.supabase.co/storage/v1/upload/resumable/sign`;
}

/**
 * AG-WEB-READY-10-P2-A1. The server-only variable that lets the authorize route hand a LOCAL disposable stack's own
 * signed resumable endpoint to the web upload page (local verification of the signed transport). It is never needed
 * for a hosted project and changes nothing for one: buildResumableEndpoint honours it only for an exact loopback
 * project URL. Authentication, the owner-bound object key and the path-scoped signature are the same either way.
 */
export const LOCAL_LOOPBACK_UPLOAD_ENDPOINT_ENV = "SWINGPROAI_LOCAL_LOOPBACK_UPLOAD_ENDPOINT";

/** Whether the server opted in to the local loopback endpoint (exactly "1"; anything else is off). */
export function localLoopbackUploadEndpointAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[LOCAL_LOOPBACK_UPLOAD_ENDPOINT_ENV] === "1";
}

/** `http://127.0.0.1:<port>` exactly: no credentials, path, query or fragment, and a numeric port. */
function isLoopbackApiOrigin(url: URL, raw: string): boolean {
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    /^[1-9][0-9]{0,4}$/.test(url.port) &&
    url.username === "" &&
    url.password === "" &&
    raw.replace(/\/$/, "") === `http://127.0.0.1:${url.port}`
  );
}

/* ─── A1: the signed resumable (TUS) transport, as the authorize answer describes it ──────────────────────────────── */

/** The TUS protocol version the signed resumable endpoint speaks. */
export const TUS_RESUMABLE_VERSION = "1.0.0";

/** Cache-Control recorded with the uploaded object (the Storage default). */
export const UPLOAD_CACHE_CONTROL = "3600";

/**
 * The authorize answer, read strictly by the uploading client: every field must be exactly what the request asked
 * for and what the contract promises (same upload id, the caller's own object key, the closed content type, the fixed
 * chunk size, no upsert, a usable endpoint). Anything else is refused (null) and nothing is sent.
 */
export function parseSignedUploadGrant(
  body: unknown,
  expected: {
    readonly uploadId: string;
    readonly objectPath: string;
    readonly contentType: UploadMimeType;
    /** A1 review: the exact endpoint the caller's own configuration implies (required); null refuses every answer. */
    readonly endpoint: string | null;
  },
): UploadAuthorizationDto | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  if (r.uploadId !== expected.uploadId || r.bucket !== UPLOAD_BUCKET || r.objectPath !== expected.objectPath) return null;
  if (r.contentType !== expected.contentType || r.upsert !== false || r.chunkSize !== UPLOAD_CHUNK_SIZE) return null;
  if (typeof r.signature !== "string" || r.signature.length === 0 || r.signature.length > 4096) return null;
  if (typeof r.expiresInSeconds !== "number" || !Number.isSafeInteger(r.expiresInSeconds) || r.expiresInSeconds <= 0) return null;
  if (typeof r.endpoint !== "string") return null;
  let endpoint: URL;
  try {
    endpoint = new URL(r.endpoint);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) return null;
  if (!endpoint.pathname.endsWith("/upload/resumable/sign") || endpoint.search !== "" || endpoint.hash !== "") return null;
  if (endpoint.href !== expected.endpoint) return null;
  return {
    uploadId: expected.uploadId,
    bucket: UPLOAD_BUCKET,
    objectPath: expected.objectPath,
    endpoint: endpoint.href,
    signature: r.signature,
    expiresInSeconds: r.expiresInSeconds,
    chunkSize: UPLOAD_CHUNK_SIZE,
    contentType: expected.contentType,
    upsert: false,
  };
}

/** ASCII-only base64 (every metadata value here is ASCII by construction). */
function asciiBase64(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error("non-ASCII upload metadata");
  return btoa(value);
}

/** The TUS Upload-Metadata header for one authorized object (bucket, object key, content type, cache control). */
export function buildTusUploadMetadata(authorization: Pick<UploadAuthorizationDto, "bucket" | "objectPath" | "contentType">): string {
  return [
    `bucketName ${asciiBase64(authorization.bucket)}`,
    `objectName ${asciiBase64(authorization.objectPath)}`,
    `contentType ${asciiBase64(authorization.contentType)}`,
    `cacheControl ${asciiBase64(UPLOAD_CACHE_CONTROL)}`,
  ].join(",");
}

/**
 * The upload URL a TUS creation answered (its Location), resolved against the authorized endpoint: only a URL on the
 * endpoint's own origin and under the endpoint's own path is accepted, so the path-scoped signature is never sent to
 * any other address. Null for anything else.
 */
export function resolveTusUploadUrl(location: string | null, endpoint: string): string | null {
  if (typeof location !== "string" || location.length === 0 || location.length > 2048) return null;
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(endpoint);
    resolved = new URL(location, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  if (!resolved.pathname.startsWith(`${base.pathname}/`) || resolved.pathname.length <= base.pathname.length + 1) return null;
  if (resolved.search !== "" || resolved.hash !== "" || resolved.username !== "" || resolved.password !== "") return null;
  return resolved.href;
}

export interface UploadAuthorizationDto {
  readonly uploadId: string;
  readonly bucket: string;
  readonly objectPath: string;
  readonly endpoint: string;
  readonly signature: string;
  readonly expiresInSeconds: number;
  readonly chunkSize: number;
  readonly contentType: UploadMimeType;
  readonly upsert: boolean;
}

/* ─── D2: finalization ─────────────────────────────────────────────────────── */

/**
 * The finalization request.
 *
 * `fileSize` is deliberately absent. At authorization time a declared size is
 * the only size that exists, so D1 accepts one as a courtesy pre-flight. At
 * finalization the bytes are already stored, which makes Storage the only
 * honest authority — accepting a caller's number here would invite a client to
 * register a size its object does not have.
 */
export interface UploadFinalizeRequest {
  readonly uploadId: string;
  readonly mimeType: UploadMimeType;
  /**
   * AG-WEB-READY-10-P2 (optional, backwards compatible). What the web upload page records about the chosen clip
   * today: its display file name and trim bounds. Absent for native clients and any caller that does not send them.
   */
  readonly metadata?: UploadClipMetadata;
}

export interface UploadClipMetadata {
  readonly originalFilename: string | null;
  readonly trimStart: number | null;
  readonly trimEnd: number | null;
}

/** Exactly the keys finalization requires. Anything else fails the request. */
const ALLOWED_FINALIZE_KEYS = ["uploadId", "mimeType"] as const;
/** P2: the optional web clip metadata keys. */
const OPTIONAL_FINALIZE_KEYS = ["originalFilename", "trimStart", "trimEnd"] as const;
/** P2: the display file name uses the canonical object-key charset (lib/swing-video-source.ts canonicalUploadFileName). */
const CLIP_FILE_NAME = /^[A-Za-z0-9._-]{1,255}$/;
/** P2: an upper bound on a trim bound, in seconds (24 h: a clip far into a long recording still finalizes). */
export const MAX_TRIM_SECONDS = 86400;

/**
 * Parses an untrusted finalization body, or returns `null`.
 *
 * Unknown keys are refused rather than ignored, which is what makes the
 * forbidden-field list unnecessary: `storagePath`, `userId`, `bucket`,
 * `fileSize`, `analysisMode` and every other field a caller might hope to
 * influence are rejected by the closed key set, including ones nobody has
 * thought of yet. Enumerating known-bad names instead would accept the
 * twenty-first.
 */
export function parseUploadFinalizeRequest(body: unknown): UploadFinalizeRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(ALLOWED_FINALIZE_KEYS as readonly string[]).includes(key) && !(OPTIONAL_FINALIZE_KEYS as readonly string[]).includes(key)) return null;
  }
  for (const key of ALLOWED_FINALIZE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  }

  const { uploadId, mimeType } = record;
  if (!isUuidV4(uploadId)) return null;
  if (!isUploadMimeType(mimeType)) return null;

  const has = (k: string) => Object.prototype.hasOwnProperty.call(record, k);
  if (!OPTIONAL_FINALIZE_KEYS.some(has)) return { uploadId, mimeType };
  const { originalFilename, trimStart, trimEnd } = record;
  if (originalFilename !== undefined && originalFilename !== null
      && (typeof originalFilename !== "string" || !CLIP_FILE_NAME.test(originalFilename) || originalFilename === "." || originalFilename === "..")) {
    return null;
  }
  if (has("trimStart") !== has("trimEnd")) return null;
  const bound = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TRIM_SECONDS;
  if (has("trimStart") && !(bound(trimStart) && bound(trimEnd) && (trimStart as number) < (trimEnd as number))) return null;
  return {
    uploadId,
    mimeType,
    metadata: {
      originalFilename: typeof originalFilename === "string" ? originalFilename : null,
      trimStart: has("trimStart") ? (trimStart as number) : null,
      trimEnd: has("trimEnd") ? (trimEnd as number) : null,
    },
  };
}

/**
 * The authoritative facts a stored object must supply.
 *
 * Both fields are optional because the installed Storage client types them
 * that way: `Camelize<FileObjectV2>` declares `size?` and `contentType?`, so a
 * response with neither is type-legal. Modelling them honestly here forces the
 * validator below to decide what an absent value means instead of letting
 * `undefined` flow into a row.
 */
export interface StoredUploadMetadata {
  readonly size?: unknown;
  readonly contentType?: unknown;
}

/** A validated stored object: exactly the two values a row may be built from. */
export interface ValidatedUploadMetadata {
  readonly size: number;
  readonly contentType: UploadMimeType;
}

/**
 * Validates authoritative Storage metadata against the requested content type.
 *
 * Returns `null` rather than throwing, and never repairs: a missing size is not
 * zero, a `video/mp4;charset=utf-8` is not `video/mp4`, and `VIDEO/MP4` is not
 * a case variant to be folded. Each of those would mean writing a row that
 * misdescribes the object it points at.
 *
 * The declared type must equal the requested type exactly, because the object
 * path's extension was derived from the request. If they disagree, either the
 * upload went somewhere unexpected or the client is describing a file it did
 * not store; both are refusals, not reconciliations.
 */
export function validateStoredUploadMetadata(
  metadata: StoredUploadMetadata,
  requestedMimeType: UploadMimeType,
): ValidatedUploadMetadata | null {
  const { size, contentType } = metadata;

  if (typeof size !== "number") return null;
  if (!Number.isSafeInteger(size)) return null;
  if (size <= 0) return null;
  if (size > MAX_UPLOAD_BYTES) return null;

  if (typeof contentType !== "string") return null;
  if (!isUploadMimeType(contentType)) return null;
  if (contentType !== requestedMimeType) return null;

  return { size, contentType };
}

export interface UploadFinalizeDto {
  readonly swingVideoId: string;
  readonly uploadId: string;
  readonly status: "uploaded";
  readonly objectPath: string;
  readonly fileSize: number;
  readonly contentType: UploadMimeType;
  readonly created: boolean;
}

/**
 * The canonical finalized-upload answer.
 *
 * `swingVideoId` and `uploadId` are the same value, reported twice on purpose:
 * the caller minted the identifier before the resource existed, and echoing it
 * under both names lets a client confirm the row it now owns is the upload it
 * started without having to assume the two are equal.
 *
 * `created` distinguishes a first finalization from an idempotent repeat. It
 * carries that distinction instead of the HTTP status, so a client retrying
 * after a lost response reads one consistent 200 either way.
 */
export function buildUploadFinalizeDto(input: {
  uploadId: string;
  objectPath: string;
  fileSize: number;
  contentType: UploadMimeType;
  created: boolean;
}): UploadFinalizeDto {
  return {
    swingVideoId: input.uploadId,
    uploadId: input.uploadId,
    status: "uploaded",
    objectPath: input.objectPath,
    fileSize: input.fileSize,
    contentType: input.contentType,
    created: input.created,
  };
}

/** The canonical status a finalized upload row carries. */
export const UPLOAD_FINALIZED_STATUS = "uploaded";

/** The exact `swing_videos` columns finalization reads to decide idempotency. */
export const FINALIZE_ROW_COLUMNS =
  "id, user_id, storage_path, video_url, file_size, mime_type, status, created_at, original_filename, trim_start, trim_end";

/** Postgres unique-violation code. The only error that means "someone won a race". */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Whether an existing owned row is the canonical record for this finalization.
 *
 * Every field is compared, not a subset. A row that matches on id and owner but
 * disagrees about size, path or content type describes a different upload
 * wearing the same identifier, and answering success for it would hand the
 * caller a resource that is not the one they finalized.
 */
export function isCanonicalFinalizedRow(
  row: {
    id?: unknown;
    user_id?: unknown;
    storage_path?: unknown;
    video_url?: unknown;
    file_size?: unknown;
    mime_type?: unknown;
    status?: unknown;
    original_filename?: unknown;
    trim_start?: unknown;
    trim_end?: unknown;
  },
  expected: {
    uploadId: string;
    userId: string;
    objectPath: string;
    fileSize: number;
    contentType: UploadMimeType;
    /** P2: compared only when the request carried clip metadata. */
    metadata?: UploadClipMetadata;
  },
): boolean {
  const sameNumber = (stored: unknown, wanted: number) => stored !== null && stored !== undefined && Number(stored) === wanted;
  return (
    row.id === expected.uploadId &&
    row.user_id === expected.userId &&
    row.storage_path === expected.objectPath &&
    row.video_url === expected.objectPath &&
    Number(row.file_size) === expected.fileSize &&
    row.mime_type === expected.contentType &&
    row.status === UPLOAD_FINALIZED_STATUS &&
    (expected.metadata === undefined ||
      ((row.original_filename ?? null) === expected.metadata.originalFilename &&
        (expected.metadata.trimStart === null || sameNumber(row.trim_start, expected.metadata.trimStart)) &&
        (expected.metadata.trimEnd === null || sameNumber(row.trim_end, expected.metadata.trimEnd))))
  );
}

/**
 * The authorization handed to a Native client.
 *
 * `signature` is the short-lived, path-scoped upload token — it authorizes one
 * object key and nothing else, so it is not a credential for the account. The
 * caller's access token, refresh token and any service key are absent by
 * construction: none is ever read by this module.
 */
export function buildUploadAuthorizationDto(input: {
  uploadId: string;
  objectPath: string;
  endpoint: string;
  signature: string;
  contentType: UploadMimeType;
}): UploadAuthorizationDto {
  return {
    uploadId: input.uploadId,
    bucket: UPLOAD_BUCKET,
    objectPath: input.objectPath,
    endpoint: input.endpoint,
    signature: input.signature,
    expiresInSeconds: UPLOAD_EXPIRES_IN_SECONDS,
    chunkSize: UPLOAD_CHUNK_SIZE,
    contentType: input.contentType,
    upsert: false,
  };
}
