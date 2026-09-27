/**
 * SEC-DRILL1 — drill_videos owner-path guard.
 *
 * /api/verify-drill accepts a caller-supplied storage path. This guard decides,
 * from the RAW string alone, whether that path names an object in the
 * authenticated caller's own drill_videos folder. It never decodes, normalises
 * or otherwise repairs the input: anything that is not already canonical is
 * rejected.
 *
 * Canonical form (matches the /drills uploader
 * `${session.user_id}/${Date.now()}_${safeFilename}`):
 *
 *   <userId>/<objectName>
 *
 * - exactly two segments;
 * - the owner segment equals the authenticated user id exactly;
 * - objectName is 1..255 characters of [A-Za-z0-9._-] and is not "." or "..".
 *
 * Classification:
 * - "forbidden": the path does not start with `${userId}/` (different owner,
 *   leading slash, empty or wrong owner). Decided locally, so a different
 *   owner's object existence is never probed or disclosed.
 * - "invalid":   the owner prefix is correct but the remainder is not a single
 *   canonical object name.
 * - "ok":        the path is an owned, canonical object path.
 */

export type DrillVideoPathCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid" };

const OBJECT_NAME = /^[A-Za-z0-9._-]{1,255}$/;

export function checkDrillVideoPath(userId: string, rawPath: string): DrillVideoPathCheck {
  const prefix = `${userId}/`;
  if (userId.length === 0 || !rawPath.startsWith(prefix)) {
    return { kind: "forbidden" };
  }

  const objectName = rawPath.slice(prefix.length);
  if (!OBJECT_NAME.test(objectName) || objectName === "." || objectName === "..") {
    return { kind: "invalid" };
  }

  return { kind: "ok" };
}
