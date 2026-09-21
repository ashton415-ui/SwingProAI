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
 * The direct Storage host's resumable endpoint for the configured project.
 *
 * Large uploads are told to go to `<ref>.storage.supabase.co` rather than the
 * API host, which is what Supabase recommends for throughput. The project ref
 * is derived from the configured URL rather than hard-coded so that staging and
 * local environments address themselves; returning `null` on anything
 * unexpected lets the route fail closed instead of handing a client a
 * half-formed URL or echoing configuration back.
 */
export function buildResumableEndpoint(supabaseUrl: string | undefined): string | null {
  if (typeof supabaseUrl !== "string" || supabaseUrl.length === 0) return null;

  let host: string;
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    return null;
  }

  const ref = host.split(".")[0];
  if (!/^[a-z0-9]{8,}$/i.test(ref)) return null;
  if (!host.endsWith(".supabase.co")) return null;

  return `https://${ref}.storage.supabase.co/storage/v1/upload/resumable`;
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
