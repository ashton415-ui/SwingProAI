import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  canonicalUploadFileName,
  classifyFailedAnalysisVideo,
  MAX_ANALYSIS_VIDEO_BYTES,
  loadOwnedSwingVideo,
  MIN_VIDEO_BYTES,
  parseOwnedSwingVideoPath,
  signOwnedSwingVideoPlayback,
  sniffVideoContainer,
  trustedSignedSwingVideoUrl,
  UNUSABLE_VIDEO_LOADS,
  type SwingVideoStorageClient,
} from "./swing-video-source";
import { KEY_VECTORS, OWNER } from "../supabase/tests/app-integration/ent1d-video-key-vectors";

/**
 * ENT-1D owner-bound swing video sources. Pure behavioural suite: no network
 * (fetch is always injected), no Supabase, no provider.
 */

const BASE = "https://proj.supabase.co";
const KEY = `${OWNER}/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/my_swing.mp4`;
const SIGNED = `${BASE}/storage/v1/object/sign/swing-videos/${KEY}?token=eyJhbGciOiJIUzI1NiJ9.e30.sig-_value`;

function client(signedUrl: string | null, error: unknown = null) {
  const createSignedUrl = vi.fn(async () => ({ data: signedUrl === null ? null : { signedUrl }, error }));
  const c: SwingVideoStorageClient = { storage: { from: vi.fn(() => ({ createSignedUrl })) } };
  return { c, createSignedUrl };
}

/** A container signature padded to `size` bytes: recognised, never decoded. */
function clip(signature: number[], size = 2048): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set(signature);
  return bytes;
}
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const MP4 = [0, 0, 0, 24, ...ascii("ftypisom")];
const MOV = [0, 0, 0, 20, ...ascii("ftypqt  ")];
const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")];
const MKV = [0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88, ...ascii("matroska")];

function okFetch(body: Uint8Array<ArrayBuffer> = clip(MP4), headers: Record<string, string> = { "content-type": "video/mp4" }) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status: 200, headers }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseOwnedSwingVideoPath: canonical owner-bound keys", () => {
  it.each(KEY_VECTORS)("$why", ({ key, ok }) => {
    expect(parseOwnedSwingVideoPath(key, OWNER)).toBe(ok ? key : null);
  });

  it("refuses non-strings and a malformed owner id", () => {
    for (const value of [null, undefined, 42, {}, ["a"]]) expect(parseOwnedSwingVideoPath(value, OWNER)).toBeNull();
    expect(parseOwnedSwingVideoPath(KEY, "not-a-uuid")).toBeNull();
    expect(parseOwnedSwingVideoPath(KEY, OWNER.toUpperCase())).toBeNull();
  });
});

describe("trustedSignedSwingVideoUrl: the exact configured Storage URL only", () => {
  it("accepts the URL Storage mints for this key on the configured project", () => {
    expect(trustedSignedSwingVideoUrl(SIGNED, KEY, BASE)).toBe(SIGNED);
    expect(trustedSignedSwingVideoUrl(SIGNED, KEY, `${BASE}/`)).toBe(SIGNED);
  });

  it.each([
    ["another host", SIGNED.replace("proj.supabase.co", "evil.example")],
    ["a host that merely starts the same", SIGNED.replace("proj.supabase.co", "proj.supabase.co.evil.example")],
    ["userinfo before the host", SIGNED.replace("https://", "https://proj.supabase.co@")],
    ["another scheme", SIGNED.replace("https://", "http://")],
    ["another port", SIGNED.replace("proj.supabase.co", "proj.supabase.co:8443")],
    ["another bucket", SIGNED.replace("/swing-videos/", "/drill_videos/")],
    ["another key", SIGNED.replace("my_swing.mp4", "other.mp4")],
    ["the public object path", SIGNED.replace("/object/sign/", "/object/public/")],
    ["an encoded traversal", SIGNED.replace(`swing-videos/${OWNER}`, `swing-videos/${OWNER}/%2e%2e/${OWNER}`)],
    ["an extra parameter", `${SIGNED}&download=1`],
    ["a redirect parameter", `${SIGNED}&redirect=https://evil.example`],
    ["a fragment", `${SIGNED}#x`],
    ["no token", SIGNED.slice(0, SIGNED.indexOf("?token=") + 7)],
    ["a token with other characters", SIGNED.replace("sig-_value", "sig/../value")],
  ])("refuses %s", (_label, url) => {
    expect(trustedSignedSwingVideoUrl(url, KEY, BASE)).toBeNull();
  });

  it("refuses when the configured URL is missing or unusable", () => {
    expect(trustedSignedSwingVideoUrl(SIGNED, KEY, undefined)).toBeNull();
    expect(trustedSignedSwingVideoUrl(SIGNED, KEY, "not a url")).toBeNull();
    expect(trustedSignedSwingVideoUrl(SIGNED, KEY, "ftp://proj.supabase.co")).toBeNull();
    expect(trustedSignedSwingVideoUrl(42, KEY, BASE)).toBeNull();
  });
});

describe("loadOwnedSwingVideo: sign, verify, download; never any other source", () => {
  it("downloads the signed object with redirects refused", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, createSignedUrl } = client(SIGNED);
    const fetchImpl = okFetch();
    const result = await loadOwnedSwingVideo(c, KEY, OWNER, 4096, fetchImpl);
    expect(result).toMatchObject({ status: "ok", mimeType: "video/mp4" });
    expect(createSignedUrl).toHaveBeenCalledWith(KEY, 300);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(SIGNED);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).redirect).toBe("error");
  });

  it.each([
    ["an MP4 (ftyp isom)", MP4, "video/mp4"],
    ["a QuickTime movie (ftyp qt)", MOV, "video/quicktime"],
    // Trimmed and camera uploads are re-encoded in the browser as WebM; local
    // browser acceptance found them declared to the provider as video/mp4.
    ["a WebM file (EBML, doc type webm)", WEBM, "video/webm"],
  ])("declares %s by its bytes as %j, whatever the stored label says", async (_label, signature, declared) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    for (const stored of ["video/mp4", "video/webm", "application/octet-stream", ""]) {
      const headers: Record<string, string> = stored ? { "content-type": stored } : {};
      const result = await loadOwnedSwingVideo(client(SIGNED).c, KEY, OWNER, 4096, okFetch(clip(signature), headers));
      expect(result, stored).toMatchObject({ status: "ok", mimeType: declared });
    }
  });

  it("a missing object is reported as missing, at signing or at download; a service failure is not", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    expect(await loadOwnedSwingVideo(client(null, { message: "Object not found", statusCode: "404" }).c, KEY, OWNER, 4096, okFetch())).toEqual({ status: "missing" });
    expect(await loadOwnedSwingVideo(client(null, { message: "internal", statusCode: "500" }).c, KEY, OWNER, 4096, okFetch())).toEqual({ status: "sign_failed" });
    expect(await loadOwnedSwingVideo(client(SIGNED).c, KEY, OWNER, 4096, vi.fn(async () => new Response("gone", { status: 404 })))).toEqual({ status: "missing" });
    expect(await loadOwnedSwingVideo(client(SIGNED).c, KEY, OWNER, 4096, vi.fn(async () => new Response("busy", { status: 503 })))).toEqual({ status: "download_failed" });
    expect(Array.from(UNUSABLE_VIDEO_LOADS).sort()).toEqual(["empty", "invalid_path", "missing", "too_large", "unrecognized_format"]);
  });

  it.each([
    ["no bytes at all", new Uint8Array(0), "empty"],
    ["fewer bytes than any recorded swing", clip(MP4, MIN_VIDEO_BYTES - 1), "empty"],
    ["text labelled as a video", new TextEncoder().encode("not a video ".repeat(200)), "unrecognized_format"],
    ["an image", clip([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "unrecognized_format"],
    ["a Matroska file that is not WebM", clip(MKV), "unrecognized_format"],
  ])("refuses %s", async (_label, body, status) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const result = await loadOwnedSwingVideo(client(SIGNED).c, KEY, OWNER, 1_000_000, okFetch(body, { "content-type": "video/mp4" }));
    expect(result).toEqual({ status });
  });

  it("an invalid key is refused before Storage is asked; nothing is fetched", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, createSignedUrl } = client(SIGNED);
    const fetchImpl = okFetch();
    for (const key of [`https://evil.example/${OWNER}/x.mp4`, `${OWNER}/../x.mp4`, `0a000000-0000-4000-8000-0000000000bb/x.mp4`]) {
      expect(await loadOwnedSwingVideo(c, key, OWNER, 1024, fetchImpl)).toEqual({ status: "invalid_path" });
    }
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a signing failure (missing or deleted object, or a Storage outage) fetches nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const fetchImpl = okFetch();
    expect(await loadOwnedSwingVideo(client(null, { message: "Object not found" }).c, KEY, OWNER, 1024, fetchImpl)).toEqual({ status: "missing" });
    expect(await loadOwnedSwingVideo(client(null, { message: "upstream unavailable" }).c, KEY, OWNER, 1024, fetchImpl)).toEqual({ status: "sign_failed" });
    const throwing: SwingVideoStorageClient = { storage: { from: () => ({ createSignedUrl: async () => { throw new Error("down"); } }) } };
    expect(await loadOwnedSwingVideo(throwing, KEY, OWNER, 1024, fetchImpl)).toEqual({ status: "sign_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a signed URL that is not the exact configured Storage URL is never fetched", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const fetchImpl = okFetch();
    const forged = SIGNED.replace("proj.supabase.co", "127.0.0.1:9");
    expect(await loadOwnedSwingVideo(client(forged).c, KEY, OWNER, 1024, fetchImpl)).toEqual({ status: "untrusted_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a redirect from Storage is not followed: the download fails, nothing else is fetched", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    // With redirect: "error", fetch rejects on any 3xx; model that contract.
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("redirect mode is set to error");
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/sentinel" } });
    });
    expect(await loadOwnedSwingVideo(client(SIGNED).c, KEY, OWNER, 1024, fetchImpl)).toEqual({ status: "download_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("non-2xx, declared-too-large and actually-too-large downloads fail closed", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c } = client(SIGNED);
    expect(await loadOwnedSwingVideo(c, KEY, OWNER, 1024, vi.fn(async () => new Response("no", { status: 403 })))).toEqual({ status: "download_failed" });
    expect(await loadOwnedSwingVideo(c, KEY, OWNER, 2047, okFetch(clip(MP4), { "content-length": "2048" }))).toEqual({ status: "too_large" });
    expect(await loadOwnedSwingVideo(c, KEY, OWNER, 2047, okFetch(clip(MP4), {}))).toEqual({ status: "too_large" });
  });

  it("an undeclared or understated length is capped while streaming, not after", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 10_000) controller.close();
      },
    });
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(endless, { status: 200, headers: { "content-length": "10" } }));
    expect(await loadOwnedSwingVideo(client(SIGNED).c, KEY, OWNER, 4096, fetchImpl)).toEqual({ status: "too_large" });
    expect(pulled, "reading stopped near the limit").toBeLessThan(16);
  });
});

describe("sniffVideoContainer: a container signature, not proof of a decodable stream", () => {
  const ftyp = (brand: string, size = 24) => [0, 0, 0, size, ...ascii(`ftyp${brand}`)];
  it.each([
    ["MP4 (isom)", clip(MP4), "video/mp4"],
    ["MP4 (mp42)", clip(ftyp("mp42", 28)), "video/mp4"],
    ["3GP video (3gp4)", clip(ftyp("3gp4")), "video/mp4"],
    ["QuickTime (qt)", clip(MOV), "video/quicktime"],
    ["WebM", clip(WEBM), "video/webm"],
    // The same ftyp box opens still images and audio: refused.
    ["HEIC image", clip(ftyp("heic")), null],
    ["HEIF image (mif1)", clip(ftyp("mif1")), null],
    ["AVIF image", clip(ftyp("avif")), null],
    ["M4A audio", clip(ftyp("M4A ")), null],
    ["ftyp box smaller than a header", clip(ftyp("isom", 8)), null],
    ["ftyp box larger than the file", new Uint8Array([...ftyp("isom", 64)]), null],
    ["ftyp box size not a multiple of 4", clip(ftyp("isom", 25)), null],
    ["ftyp at the wrong offset", clip([0, ...ftyp("isom")]), null],
    ["Matroska that is not WebM", clip(MKV), null],
    ["bare ftyp", new Uint8Array(ascii("ftyp")), null],
    ["truncated EBML magic", new Uint8Array([0x1a, 0x45, 0xdf]), null],
    ["nothing", new Uint8Array(0), null],
  ])("%s -> %j", (_label, bytes, expected) => {
    expect(sniffVideoContainer(bytes)).toBe(expected);
  });
});

describe("classifyFailedAnalysisVideo: why a failed analysis's video cannot be analysed, from the object itself", () => {
  const partial = (body: Uint8Array<ArrayBuffer>, total: number) =>
    vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      new Response(body, { status: 206, headers: { "content-range": `bytes 0-${body.byteLength - 1}/${total}` } }));

  it("a usable object is not blamed: null, read with a 4 KB range, redirects refused, never the provider", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, createSignedUrl } = client(SIGNED);
    const fetchImpl = partial(clip(MP4, 4096), 9000);
    expect(await classifyFailedAnalysisVideo(c, KEY, OWNER, fetchImpl)).toBeNull();
    expect(createSignedUrl).toHaveBeenCalledWith(KEY, 60);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(fetchImpl.mock.calls[0][0]).toBe(SIGNED);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Range).toBe("bytes=0-4095");
  });

  it.each([
    ["a non-canonical key (nothing is signed or fetched)", () => ({ c: client(SIGNED).c, key: `${OWNER}/../x.mp4`, f: okFetch() })],
    ["no object at signing", () => ({ c: client(null, { message: "Object not found", statusCode: "404" }).c, key: KEY, f: okFetch() })],
    ["no object at download", () => ({ c: client(SIGNED).c, key: KEY, f: vi.fn(async () => new Response("gone", { status: 404 })) })],
    ["an empty object (range not satisfiable)", () => ({ c: client(SIGNED).c, key: KEY, f: vi.fn(async () => new Response(null, { status: 416 })) })],
    ["an object under the minimum size", () => ({ c: client(SIGNED).c, key: KEY, f: partial(clip(MP4, 512), 512) })],
    ["an object over the analysis limit", () => ({ c: client(SIGNED).c, key: KEY, f: partial(clip(MP4, 4096), MAX_ANALYSIS_VIDEO_BYTES + 1) })],
    ["bytes that are not a recognised video", () => ({ c: client(SIGNED).c, key: KEY, f: partial(new Uint8Array(4096).fill(0x41), 9000) })],
    ["an image in an ftyp box", () => ({ c: client(SIGNED).c, key: KEY, f: partial(clip([0, 0, 0, 24, ...ascii("ftypheic")], 4096), 9000) })],
  ])("video_unusable: %s", async (_label, arrange) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, key, f } = arrange();
    expect(await classifyFailedAnalysisVideo(c, key, OWNER, f)).toBe("video_unusable");
  });

  it.each([
    ["a Storage signing outage", () => ({ c: client(null, { message: "internal", statusCode: "500" }).c, f: okFetch() })],
    ["signing throws", () => ({ c: { storage: { from: () => ({ createSignedUrl: async () => { throw new Error("down"); } }) } } as SwingVideoStorageClient, f: okFetch() })],
    ["an untrusted signed URL", () => ({ c: client(SIGNED.replace("proj.supabase.co", "127.0.0.1:9")).c, f: okFetch() })],
    ["a download outage", () => ({ c: client(SIGNED).c, f: vi.fn(async () => new Response("busy", { status: 503 })) })],
    ["a download that throws", () => ({ c: client(SIGNED).c, f: vi.fn(async () => { throw new TypeError("fetch failed"); }) })],
  ])("null (may be temporary, Retry stays): %s", async (_label, arrange) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, f } = arrange();
    expect(await classifyFailedAnalysisVideo(c, KEY, OWNER, f)).toBeNull();
  });

  it.each([
    ["a full (200) answer declaring more than the analysis limit", () => vi.fn(async () => new Response(clip(MP4, 4096), { status: 200, headers: { "content-length": String(MAX_ANALYSIS_VIDEO_BYTES + 1) } })), "video_unusable"],
    ["an ftyp box larger than the probe, inside a large object (the route accepts it)", () => partial(clip([0, 0, 0x14, 0, ...ascii("ftypisom")], 4096), 9000), null],
  ])("parity with the route: %s", async (_label, f, expected) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    expect(await classifyFailedAnalysisVideo(client(SIGNED).c, KEY, OWNER, f())).toBe(expected);
  });

  it.each([
    ["Bucket not found"],
    ["Not Found"],
  ])("a signing error %j that is not the object's absence stays retryable", async (message) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    expect(await classifyFailedAnalysisVideo(client(null, { message, statusCode: "404" }).c, KEY, OWNER, okFetch())).toBeNull();
  });

  it("a signing call that never answers cannot hold the page: null after 5 s", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    vi.useFakeTimers();
    try {
      const hanging: SwingVideoStorageClient = { storage: { from: () => ({ createSignedUrl: () => new Promise(() => undefined) }) } };
      const result = classifyFailedAnalysisVideo(hanging, KEY, OWNER, okFetch());
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a server that ignores the range is read only up to 4 KB, and the answer itself is the whole object", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(pulled === 0 ? clip(MP4, 1024) : new Uint8Array(1024));
        pulled += 1;
      },
    });
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(endless, { status: 200 }));
    expect(await classifyFailedAnalysisVideo(client(SIGNED).c, KEY, OWNER, f)).toBeNull();
    expect(pulled, "reading stopped at the probe size").toBeLessThanOrEqual(6);
  });
});

describe("canonicalUploadFileName: every upload flow's file segment is accepted by the key rule", () => {
  it.each([
    ["my swing.mp4", "my_swing.mp4"],
    ["clip.mov", "clip.mov"],
    ["", "video"],
    [".", "video"],
    ["..", "video"],
    ["vidéo/../x.mp4", "vid_o_.._x.mp4"],
    ["a".repeat(400), "a".repeat(200)],
  ])("%j -> %j", (input, expected) => {
    expect(canonicalUploadFileName(input)).toBe(expected);
  });

  it("produces keys the canonical rule accepts in every upload layout", () => {
    for (const name of ["", ".", "..", "x".repeat(1000), "../../etc/passwd", "a/b\c", " .mp4", "normal.mp4"]) {
      const file = canonicalUploadFileName(name);
      expect(parseOwnedSwingVideoPath(`${OWNER}/${file}`, OWNER), name).not.toBeNull();
      expect(parseOwnedSwingVideoPath(`${OWNER}/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/${file}`, OWNER), name).not.toBeNull();
      expect(parseOwnedSwingVideoPath(`${OWNER}/1793000000000_${file}`, OWNER), name).not.toBeNull();
    }
  });
});

describe("signOwnedSwingVideoPlayback: owner-bound playback, no fallback", () => {
  it("signs a canonical owned key and returns the verified URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, createSignedUrl } = client(SIGNED);
    expect(await signOwnedSwingVideoPlayback(c, KEY, OWNER)).toBe(SIGNED);
    expect(createSignedUrl).toHaveBeenCalledWith(KEY, 3600);
  });

  it("returns null for a non-canonical key, a signing failure or an unexpected URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", BASE);
    const { c, createSignedUrl } = client(SIGNED);
    expect(await signOwnedSwingVideoPlayback(c, "https://evil.example/x.mp4", OWNER)).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(await signOwnedSwingVideoPlayback(client(null, { message: "x" }).c, KEY, OWNER)).toBeNull();
    expect(await signOwnedSwingVideoPlayback(client("https://evil.example/x").c, KEY, OWNER)).toBeNull();
  });
});

describe("source contract: browser-written video_url is never a source", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
  it.each([
    "app/api/analyze-swing/route.ts",
    "app/(dashboard)/analyze/[id]/page.tsx",
    "app/(dashboard)/swings/[id]/page.tsx",
  ])("%s signs or loads only through lib/swing-video-source", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/\.createSignedUrl\(/);
    expect(src).not.toMatch(/=\s*videoRow\??\.video_url/);
    expect(src).not.toMatch(/\?\?\s*videoRow\??\.video_url/);
    expect(src).not.toMatch(/fetch\(\s*(url|fetchUrl|videoRow)/);
  });
});
