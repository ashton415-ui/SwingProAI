/**
 * SEC-DRILL1 — pure owner-path guard for drill_videos.
 *
 * The guard runs on the raw caller-supplied path and never repairs it. These
 * cases pin the three-way classification (ok / forbidden / invalid) against
 * the canonical `<userId>/<objectName>` shape produced by the /drills uploader.
 */

import { describe, it, expect } from "vitest";
import { checkDrillVideoPath } from "@/lib/drill-video-path";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";

/** Mirrors app/(dashboard)/drills/page.tsx: `${user_id}/${Date.now()}_${safeFilename}`. */
const CURRENT_FORMAT = `${USER_ID}/1727460000000_My_Swing-01.mov`;

function kind(path: string, userId: string = USER_ID): string {
  return checkDrillVideoPath(userId, path).kind;
}

describe("SEC-DRILL1 — owned canonical paths pass", () => {
  it("D1 accepts a current-format owned path", () => {
    expect(kind(CURRENT_FORMAT)).toBe("ok");
  });

  it("D12 accepts a 255-character allowed object name", () => {
    const name = "a".repeat(255);
    expect(kind(`${USER_ID}/${name}`)).toBe("ok");
  });

  it("accepts every character in the allowed set", () => {
    expect(kind(`${USER_ID}/AZaz09._-`)).toBe("ok");
  });
});

describe("SEC-DRILL1 — non-owner paths are forbidden", () => {
  it("D2 rejects a different UUID owner prefix", () => {
    expect(kind(`${OTHER_ID}/1727460000000_clip.mp4`)).toBe("forbidden");
  });

  it("D3 rejects a leading slash", () => {
    expect(kind(`/${USER_ID}/1727460000000_clip.mp4`)).toBe("forbidden");
  });

  it("rejects an empty owner segment", () => {
    expect(kind(`/1727460000000_clip.mp4`)).toBe("forbidden");
  });

  it("rejects an owner id without its separator", () => {
    expect(kind(USER_ID)).toBe("forbidden");
    expect(kind(`${USER_ID}1727460000000_clip.mp4`)).toBe("forbidden");
  });

  it("rejects an owner prefix that differs only in case", () => {
    const lower = "abcdef01-2222-4333-8444-555555555555";
    expect(kind(`${lower.toUpperCase()}/clip.mp4`, lower)).toBe("forbidden");
  });

  it("rejects a backslash-separated owner prefix", () => {
    expect(kind(`${USER_ID}\\clip.mp4`)).toBe("forbidden");
  });

  it("rejects a traversal that starts outside the owner folder", () => {
    expect(kind(`../${USER_ID}/clip.mp4`)).toBe("forbidden");
    expect(kind(`${OTHER_ID}/../${USER_ID}/clip.mp4`)).toBe("forbidden");
  });

  it("rejects everything when the authenticated id is empty", () => {
    expect(kind("/clip.mp4", "")).toBe("forbidden");
    expect(kind("clip.mp4", "")).toBe("forbidden");
  });
});

describe("SEC-DRILL1 — owned but non-canonical paths are invalid", () => {
  it("D4 rejects a backslash in the object name", () => {
    expect(kind(`${USER_ID}/foo\\bar`)).toBe("invalid");
  });

  it('D5 rejects "."', () => {
    expect(kind(`${USER_ID}/.`)).toBe("invalid");
  });

  it('D6 rejects ".."', () => {
    expect(kind(`${USER_ID}/..`)).toBe("invalid");
  });

  it("D7 rejects an extra slash or segment", () => {
    expect(kind(`${USER_ID}/foo/bar`)).toBe("invalid");
    expect(kind(`${USER_ID}//foo`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo/`)).toBe("invalid");
    expect(kind(`${USER_ID}/../${OTHER_ID}/clip.mp4`)).toBe("invalid");
  });

  it("D8 rejects an empty object segment", () => {
    expect(kind(`${USER_ID}/`)).toBe("invalid");
  });

  it("D9 rejects percent-encoded separators without decoding them", () => {
    expect(kind(`${USER_ID}/foo%2Fbar`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo%5Cbar`)).toBe("invalid");
    expect(kind(`${USER_ID}/%2E%2E`)).toBe("invalid");
  });

  it("D10 rejects control characters", () => {
    expect(kind(`${USER_ID}/foo\u0000bar`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo\nbar`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo\tbar`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo\u007fbar`)).toBe("invalid");
  });

  it("D11 rejects non-ASCII / Unicode characters", () => {
    expect(kind(`${USER_ID}/swingé.mp4`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo∕bar`)).toBe("invalid");
    expect(kind(`${USER_ID}/foo／bar`)).toBe("invalid");
    expect(kind(`${USER_ID}/clip\u{1F3CC}.mp4`)).toBe("invalid");
  });

  it("D13 rejects a 256-character object name", () => {
    expect(kind(`${USER_ID}/${"a".repeat(256)}`)).toBe("invalid");
  });

  it("rejects spaces and other characters outside the allowed set", () => {
    expect(kind(`${USER_ID}/my clip.mp4`)).toBe("invalid");
    expect(kind(`${USER_ID}/clip?.mp4`)).toBe("invalid");
    expect(kind(`${USER_ID}/clip#1.mp4`)).toBe("invalid");
  });
});
