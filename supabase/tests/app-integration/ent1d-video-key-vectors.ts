// ENT-1D canonical swing-video key vectors, shared by the TypeScript unit
// tests (lib/swing-video-source.test.ts) and the SQL parity check against
// public.ent1d_is_canonical_swing_video_key in the local integration run.
// Every vector is evaluated for OWNER; `ok` is the expected verdict of both.

export const OWNER = "0a000000-0000-4000-8000-0000000000aa";
export const OTHER = "0a000000-0000-4000-8000-0000000000bb";

export const KEY_VECTORS: readonly { readonly key: string; readonly ok: boolean; readonly why: string }[] = [
  // Accepted: every real upload format.
  { key: `${OWNER}/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/my_swing.mp4`, ok: true, why: "analyze page / v1 upload" },
  { key: `${OWNER}/3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B/source.mov`, ok: true, why: "v1 finalize, upper-case upload id" },
  { key: `${OWNER}/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/source.webm`, ok: true, why: "v1 finalize webm" },
  { key: `${OWNER}/1793000000000_clip.mov`, ok: true, why: "legacy server action, two segments" },
  { key: `${OWNER}/.hidden.mp4`, ok: true, why: "file may start with a dot" },
  { key: `${OWNER}/a..b.mp4`, ok: true, why: "dots inside a file name are not traversal" },
  { key: `${OWNER}/${"a".repeat(255)}`, ok: true, why: "255-character file" },
  // Refused: ownership.
  { key: `${OTHER}/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/x.mp4`, ok: false, why: "another user's folder" },
  { key: `${OWNER.toUpperCase()}/x.mp4`, ok: false, why: "owner segment not exactly the stored id" },
  { key: `x${OWNER}/x.mp4`, ok: false, why: "owner prefix not a whole segment" },
  // Refused: shape.
  { key: `${OWNER}`, ok: false, why: "owner only" },
  { key: `${OWNER}/`, ok: false, why: "empty file" },
  { key: `${OWNER}//x.mp4`, ok: false, why: "empty segment" },
  { key: `/${OWNER}/x.mp4`, ok: false, why: "leading slash" },
  { key: `${OWNER}/x.mp4/`, ok: false, why: "trailing slash" },
  { key: `${OWNER}/not-a-uuid/x.mp4`, ok: false, why: "middle segment not a uuid" },
  { key: `${OWNER}/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/a/x.mp4`, ok: false, why: "too many segments" },
  { key: `${OWNER}/${"a".repeat(256)}`, ok: false, why: "file longer than 255" },
  { key: "", ok: false, why: "empty" },
  // Refused: traversal, encoding, URL shapes, special characters.
  { key: `${OWNER}/..`, ok: false, why: "dot-dot file" },
  { key: `${OWNER}/.`, ok: false, why: "dot file" },
  { key: `${OWNER}/../${OTHER}/x.mp4`, ok: false, why: "traversal" },
  { key: `${OWNER}/%2e%2e/x.mp4`, ok: false, why: "percent-encoded traversal" },
  { key: `${OWNER}/x%2Fy.mp4`, ok: false, why: "percent-encoded slash" },
  { key: `${OWNER}\\x.mp4`, ok: false, why: "backslash" },
  { key: `${OWNER}/x\\..\\y.mp4`, ok: false, why: "backslash traversal" },
  { key: `https://example.invalid/${OWNER}/x.mp4`, ok: false, why: "URL" },
  { key: `http://127.0.0.1:9/${OWNER}/x.mp4`, ok: false, why: "loopback URL" },
  { key: `//example.invalid/${OWNER}/x.mp4`, ok: false, why: "protocol-relative URL" },
  { key: `${OWNER}/x.mp4?download=1`, ok: false, why: "query string" },
  { key: `${OWNER}/x.mp4#f`, ok: false, why: "fragment" },
  { key: `${OWNER}/x y.mp4`, ok: false, why: "space" },
  { key: ` ${OWNER}/x.mp4`, ok: false, why: "leading space (no trimming)" },
  { key: `${OWNER}/x.mp4\n`, ok: false, why: "trailing newline" },
  { key: `${OWNER}/x\u0000.mp4`, ok: false, why: "NUL" },
  { key: `${OWNER}/x\u0007.mp4`, ok: false, why: "control character" },
  { key: `${OWNER}/vidéo.mp4`, ok: false, why: "non-ASCII" },
  { key: `${OWNER}/x∕y.mp4`, ok: false, why: "Unicode division slash" },
];
