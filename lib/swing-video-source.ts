/**
 * SwingProAI — owner-bound swing video sources (ENT-1D).
 *
 * The only thing the server ever reads a golfer's swing from is that golfer's
 * own object in the private `swing-videos` bucket, named by a canonical key.
 * `swing_videos.video_url` is browser-written metadata and is never fetched,
 * signed or played back; an owned database row alone does not prove that the
 * key it names lies in its owner's folder, so the key is re-validated here at
 * every signing or download.
 *
 * Canonical key (also enforced on insert/update by migration
 * 20261027120100_ent1d_swing_video_source_guard, which must stay in step):
 *
 *   <owner uuid>/<file>                 legacy two-segment form
 *   <owner uuid>/<uuid>/<file>          browser and V1 upload forms
 *
 *   owner uuid  exactly the owner's id as stored (lower-case)
 *   uuid        8-4-4-4-12 hex, either case (V1 upload ids are accepted
 *               case-insensitively)
 *   file        1-255 of [A-Za-z0-9._-], not "." or ".."
 *
 * Nothing is decoded, trimmed or otherwise normalised: a key that is not
 * already canonical is refused, never rewritten into some other valid key.
 */

export const SWING_VIDEO_BUCKET = "swing-videos";

const OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FILE = /^[A-Za-z0-9._-]{1,255}$/;

/** The key itself when it is a canonical key in `ownerId`'s folder; otherwise null. */
export function parseOwnedSwingVideoPath(path: unknown, ownerId: string): string | null {
  if (typeof path !== "string" || !OWNER.test(ownerId)) return null;
  const parts = path.split("/");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts[0] !== ownerId) return null;
  if (parts.length === 3 && !SEGMENT_UUID.test(parts[1])) return null;
  const file = parts[parts.length - 1];
  if (!FILE.test(file) || file === "." || file === "..") return null;
  return path;
}

/**
 * A file-name segment every upload flow can use: the characters of `name`
 * outside [A-Za-z0-9._-] become "_", it is cut to 200 characters, and a
 * result that is empty, "." or ".." becomes "video". Applied BEFORE the
 * Storage upload, so the database's canonical-key rule can never refuse a row
 * whose object was already uploaded.
 */
export function canonicalUploadFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return safe === "" || safe === "." || safe === ".." ? "video" : safe;
}

const SIGNED_TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * The exact signed-download URL Storage mints for `key` on the configured
 * project, or null. The whole string is compared, not a hostname or a path
 * prefix: same scheme, host, port and base path as NEXT_PUBLIC_SUPABASE_URL,
 * the `/storage/v1/object/sign/swing-videos/<key>` path for this key, and a
 * single `token` parameter. No credentials, fragment or other parameter.
 */
export function trustedSignedSwingVideoUrl(signedUrl: unknown, key: string, supabaseUrl: string | undefined): string | null {
  if (typeof signedUrl !== "string" || typeof supabaseUrl !== "string") return null;
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password || base.search || base.hash) return null;
  const prefix = `${base.origin}${base.pathname.replace(/\/$/, "")}/storage/v1/object/sign/${SWING_VIDEO_BUCKET}/${key}?token=`;
  if (!signedUrl.startsWith(prefix)) return null;
  const token = signedUrl.slice(prefix.length);
  return SIGNED_TOKEN.test(token) ? signedUrl : null;
}

/** The part of a Supabase client this module uses: Storage signing only. */
export interface SwingVideoStorageClient {
  storage: {
    from(bucket: string): {
      createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
    };
  };
}

export type SwingVideoLoad =
  | { readonly status: "ok"; readonly buffer: ArrayBuffer; readonly mimeType: SwingVideoContainer }
  | {
      readonly status:
        | "invalid_path"
        | "missing"
        | "sign_failed"
        | "untrusted_url"
        | "download_failed"
        | "too_large"
        | "empty"
        | "unrecognized_format";
    };

export type SwingVideoContainer = "video/mp4" | "video/quicktime" | "video/webm";

/**
 * Load outcomes that say the golfer's stored video itself cannot be analysed:
 * no canonical key, no object, or bytes that are empty, oversized or not a
 * recognised video. Retrying cannot help; a new upload can. Every other
 * failure (signing, an untrusted URL, a failed or timed-out download) is the
 * service's, and the same video may well succeed on a retry.
 */
export const UNUSABLE_VIDEO_LOADS: ReadonlySet<string> = new Set(["invalid_path", "missing", "empty", "unrecognized_format", "too_large"]);

/**
 * Storage's answer for an object that does not exist: exactly "Object not
 * found". Any other "not found" (a missing bucket, a gateway 404) is a service
 * problem, not the golfer's video, and stays retryable.
 */
function isObjectNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { message?: unknown };
  return typeof e.message === "string" && /^object not found$/i.test(e.message.trim());
}

/** Settles with `fallback` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** Below this, an object cannot hold a recorded swing; it is refused as empty. */
export const MIN_VIDEO_BYTES = 1024;

/**
 * The most video bytes one analysis reads and sends inline to the provider.
 * The provider limits a whole inline request to about 20 MB and the video
 * travels base64-encoded (4/3 larger), so 14 MB of video (about 18.7 MB
 * encoded) leaves room for the prompt.
 */
export const MAX_ANALYSIS_VIDEO_BYTES = 14 * 1_048_576; // 14 MB

/** What the golfer is told when the stored video cannot be used (ENT-1D D1); one copy for the route and both report pages. */
export const VIDEO_UNUSABLE_COPY =
  "We couldn't read a swing from this video, so it wasn't analysed and no score was saved. Please upload the swing again as an MP4, MOV or WebM video.";

/** The analyze route's `status` when the stored video could not be used (ENT-1D D1). */
export const VIDEO_UNUSABLE_STATUS = "video_unusable";

/** ISO base-media major brands written by phone, camera and browser video recorders. */
const ISO_VIDEO_BRANDS = new Set([
  "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP",
  "3gp4", "3gp5", "3gp6", "3g2a", "dash", "mmp4", "msnv",
]);

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...Array.from(bytes.subarray(from, to)));

/**
 * The container the bytes start with, or null. An ISO base-media file (MP4,
 * QuickTime) opens with an `ftyp` box, whose major brand `qt  ` marks
 * QuickTime; a WebM file opens with the EBML magic and declares the `webm`
 * doc type in its header. This recognises a container signature only: it does
 * not prove the stream decodes, which only the provider (or a decoder) can.
 */
export function sniffVideoContainer(bytes: Uint8Array, objectLength: number = bytes.byteLength): SwingVideoContainer | null {
  if (bytes.byteLength >= 16 && ascii(bytes, 4, 8) === "ftyp") {
    // The box must be well formed, and its major brand a video brand: the
    // same `ftyp` box opens HEIC/AVIF images and M4A audio.
    const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    if (size < 16 || size > objectLength || size % 4 !== 0) return null;
    const brand = ascii(bytes, 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    return ISO_VIDEO_BRANDS.has(brand) ? "video/mp4" : null;
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 4, Math.min(bytes.byteLength, 64)).includes("webm") ? "video/webm" : null;
  }
  return null;
}

/**
 * A short-lived signed URL for the golfer's own playback, or null. Signed on
 * the caller's session, so the Storage owner-folder policy applies as well.
 * There is no fallback: a key that is not canonical, or a signing failure,
 * means no playback.
 */
export async function signOwnedSwingVideoPlayback(
  client: SwingVideoStorageClient,
  path: unknown,
  ownerId: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const key = parseOwnedSwingVideoPath(path, ownerId);
  if (key === null) return null;
  try {
    const { data } = await client.storage.from(SWING_VIDEO_BUCKET).createSignedUrl(key, expiresInSeconds);
    return trustedSignedSwingVideoUrl(data?.signedUrl, key, process.env.NEXT_PUBLIC_SUPABASE_URL);
  } catch {
    return null;
  }
}

/**
 * The golfer's own video bytes for analysis. Validates the key, signs it on
 * the caller's session, accepts only the exact configured Storage URL, and
 * downloads with redirects refused and a byte limit. Refuses an object under
 * MIN_VIDEO_BYTES or without a recognised container signature. Never reads,
 * signs or fetches `video_url`, and never falls back to anything after a
 * failure.
 */
export async function loadOwnedSwingVideo(
  client: SwingVideoStorageClient,
  path: unknown,
  ownerId: string,
  limitBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SwingVideoLoad> {
  const key = parseOwnedSwingVideoPath(path, ownerId);
  if (key === null) return { status: "invalid_path" };

  let signedUrl: unknown;
  try {
    const { data, error } = await client.storage.from(SWING_VIDEO_BUCKET).createSignedUrl(key, 300);
    if (error || !data) return { status: isObjectNotFound(error) ? "missing" : "sign_failed" };
    signedUrl = data.signedUrl;
  } catch {
    return { status: "sign_failed" };
  }
  const url = trustedSignedSwingVideoUrl(signedUrl, key, process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (url === null) return { status: "untrusted_url" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(url, { redirect: "error", signal: controller.signal });
    if (!res.ok) return { status: res.status === 404 ? "missing" : "download_failed" };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > limitBytes) return { status: "too_large" };
    // Read with a running cap: a missing or understated content-length never
    // lets more than limitBytes into memory.
    if (!res.body) return { status: "download_failed" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        return { status: "too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (total < MIN_VIDEO_BYTES) return { status: "empty" };
    // The container is read from the bytes, never from a stored or declared
    // label: trimmed and camera uploads are re-encoded in the browser as WebM,
    // and a label proves nothing about the content.
    const mimeType = sniffVideoContainer(bytes);
    if (mimeType === null) return { status: "unrecognized_format" };
    return { status: "ok", buffer: bytes.buffer, mimeType };
  } catch {
    return { status: "download_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/** How much of the object the classifier reads: enough for any container header. */
const PROBE_BYTES = 4096;

/**
 * Why a failed analysis's video cannot be analysed, decided again from the
 * stored object itself, with the same rules as loadOwnedSwingVideo
 * (UNUSABLE_VIDEO_LOADS):
 *
 *   "video_unusable"  no canonical key, no object, or an object that is
 *                     empty, over the analysis limit or not a recognised
 *                     video — a new upload is the only way forward;
 *   null              the video looks usable, or Storage could not be asked
 *                     right now — the failure may be temporary, so a retry
 *                     stays on offer.
 *
 * ENT-1D: this is how a revisited failed analysis shows the right guidance
 * without storing a failure reason (no column or migration) and without
 * requesting another analysis. It reads at most PROBE_BYTES through the same
 * owner-bound, signed, redirect-refusing path and never calls the provider.
 * A failure for any other reason (a definite provider error) keeps its usable
 * video, so it is never misreported as an upload problem.
 */
export async function classifyFailedAnalysisVideo(
  client: SwingVideoStorageClient,
  path: unknown,
  ownerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<typeof VIDEO_UNUSABLE_STATUS | null> {
  const key = parseOwnedSwingVideoPath(path, ownerId);
  if (key === null) return VIDEO_UNUSABLE_STATUS;
  let signedUrl: unknown;
  try {
    // Bounded: a stalled Storage API must not hold the page render.
    const signed = await within(client.storage.from(SWING_VIDEO_BUCKET).createSignedUrl(key, 60), 5_000, null);
    if (signed === null) return null;
    const { data, error } = signed;
    if (error || !data) return isObjectNotFound(error) ? VIDEO_UNUSABLE_STATUS : null;
    signedUrl = data.signedUrl;
  } catch {
    return null;
  }
  const url = trustedSignedSwingVideoUrl(signedUrl, key, process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (url === null) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    // 416: not even the first byte exists — an empty object.
    if (res.status === 404 || res.status === 416) return VIDEO_UNUSABLE_STATUS;
    if (!res.ok || !res.body) return null;
    // The whole object's size: from Content-Range on a partial answer, else
    // the declared length of a full answer (a server that ignored the range),
    // else what was read.
    const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    const declared = Number(res.headers.get("content-length") ?? "");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let read = 0;
    while (read < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      read += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    const prefix = new Uint8Array(Math.min(read, PROBE_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const take = chunk.subarray(0, prefix.byteLength - offset);
      prefix.set(take, offset);
      offset += take.byteLength;
      if (offset >= prefix.byteLength) break;
    }
    const total =
      res.status === 206 && range ? Number(range[1]) : Number.isFinite(declared) && declared > 0 ? declared : read;
    if (total < MIN_VIDEO_BYTES || total > MAX_ANALYSIS_VIDEO_BYTES) return VIDEO_UNUSABLE_STATUS;
    // Judged against the whole object's length, as the route judges the whole object.
    return sniffVideoContainer(prefix, total) === null ? VIDEO_UNUSABLE_STATUS : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
