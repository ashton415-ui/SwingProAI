import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ENT-1D local browser acceptance findings on the analyze page (source checks;
 * the browser run is the behavioural evidence).
 *
 *   - Every file input must stay keyboard-reachable. `display: none` (the
 *     Tailwind `hidden` class) removes an input from the tab order, so the video
 *     could only be chosen with a pointer; `sr-only` keeps it focusable and its
 *     label shows the focus ring.
 *   - The launch-monitor upsell link sits in the mobile flow and must meet the
 *     44px touch target.
 *   - Plan names and upgrade controls must be honest: no analysis depth the
 *     server does not run, and no upgrade offered while checkout is paused.
 *   - A file the analysis cannot read is refused with copy that says what to
 *     do, and raw Storage or network text never reaches the golfer.
 */
const page = readFileSync(path.join(__dirname, "..", "app/(dashboard)/analyze/page.tsx"), "utf8");
const report = readFileSync(path.join(__dirname, "..", "app/(dashboard)/analyze/[id]/AnalysisReport.tsx"), "utf8");

describe("analyze page upload controls are keyboard reachable", () => {
  const inputs = Array.from(page.matchAll(/<input type="file"[^>]*>/g), (m) => m[0]);

  it("finds the page's file inputs", () => {
    expect(inputs.length).toBe(3);
  });

  it.each(inputs.map((tag, i) => [i, tag]))("file input %i is visually hidden, not removed", (_i, tag) => {
    expect(tag).toContain('className="sr-only"');
    expect(tag).not.toMatch(/className="[^"]*\bhidden\b/);
  });

  it.each(inputs.map((tag, i) => [i, tag]))("file input %i opens on Enter as well as Space", (_i, tag) => {
    // Found by browser acceptance: Chrome opened the chooser on Space only.
    expect(tag).toContain("onKeyDown={openFileChooserOnEnter}");
  });

  it("Enter opens the chooser through the input's own click, nothing else", () => {
    expect(page).toMatch(/function openFileChooserOnEnter\(e: KeyboardEvent<HTMLInputElement>\) \{\s*if \(e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*e\.currentTarget\.click\(\);\s*\}\s*\}/);
  });

  it("each file input's label shows a focus ring", () => {
    const labels = Array.from(page.matchAll(/<label className="([^"]*)">\s*(?:\{[^}]*\}\s*)?(?:<[A-Z][^>]*\/>\s*)?(?:<span[\s\S]*?<\/span>\s*)?<input type="file"/g), (m) => m[1]);
    expect(labels.length).toBe(3);
    for (const cls of labels) expect(cls).toMatch(/focus-within:ring-2/);
  });
});

describe("report status pill agrees with the failure panel", () => {
  // Found by local browser acceptance: after a definite provider failure the
  // panel said "Analysis Failed" while the pill still showed the initial
  // "pending" from the server render.
  it("the processing state reports failure to its parent and clears it on Retry", () => {
    expect(report).toMatch(/setError\(res\.error\);\s*onFailed\?\.\(true\);/);
    expect(report).toMatch(/setError\(NETWORK_FAILURE_COPY\);\s*onFailed\?\.\(true\);/);
    expect(report).toMatch(/setError\(null\); onFailed\?\.\(false\);/);
    expect(report).toContain("onFailed={setFailedNow}");
  });

  it("the pill shows failed while the failure is displayed", () => {
    expect(report).toContain('{isStalled ? "interrupted" : failedNow ? "failed" : analysis.status}');
  });
});

describe("analyze page touch targets", () => {
  it("the launch-monitor plans link is at least 44px tall", () => {
    const link = page.match(/<Link href="\/upgrade"\s+className="([^"]*)"[^>]*>\s*<Zap size=\{12\} \/>\s*\{CHECKOUT_AVAILABLE \? "Upgrade to Birdie to Unlock"/);
    expect(link).not.toBeNull();
    expect(link![1]).toMatch(/\bmin-h-11\b/);
  });

  it("the result-panel plans link and the error dismiss button are at least 44px", () => {
    expect(page).toMatch(/<Link href="\/upgrade"\s+className="shrink-0 inline-flex items-center min-h-11 /);
    expect(page).toMatch(/aria-label="Dismiss message"\s+className="[^"]*\bmin-w-11\b[^"]*\bmin-h-11\b/);
  });
});

describe("honest plan and availability messaging", () => {
  it("shows no plan badge: the page cannot tell a current membership from a lapsed one", () => {
    for (const claim of ["Par Basic", "Birdie AI", "Eagle Deep", "{getTierDisplayName(userTier)} plan"]) expect(page).not.toContain(claim);
  });

  it("the putting refusal states the plan fact and offers no upgrade, identically on client and server", () => {
    const route = readFileSync(path.join(__dirname, "..", "app/api/analyze-swing/route.ts"), "utf8");
    const copy = "Putting analysis isn't included with your current plan.";
    expect(page).toContain(`"${copy}";`);
    expect(route).toContain(`"${copy}",`);
    expect(page + route).not.toContain("Upgrade to unlock putting analysis");
  });

  it("no Upgrade Plan call to action in the navigation while checkout is paused", () => {
    const layout = readFileSync(path.join(__dirname, "..", "app/(dashboard)/layout.tsx"), "utf8");
    expect(layout).toContain("const showUpgradeCallout = CHECKOUT_AVAILABLE && shouldShowUpgradeCallout(role, isActive);");
  });

  it("no control offers an upgrade it cannot deliver while checkout is paused", () => {
    expect(page).toContain('import { CHECKOUT_AVAILABLE } from "@/lib/billing/checkout-availability";');
    // The locked putting action is a state, not an action.
    expect(page).toContain("PUTTING NOT IN YOUR PLAN");
    expect(page).not.toContain("UPGRADE TO UNLOCK PUTTING");
    expect(page).toContain('{!CHECKOUT_AVAILABLE && " New memberships are temporarily paused."}');
    expect(page).toMatch(/\{!CHECKOUT_AVAILABLE && \(\s*<p className="text-xs text-gray-500 mt-1">New memberships are temporarily paused\.<\/p>/);
    // The local "Pro mode" toggle unlocked nothing and is gone.
    for (const gone of ["GET PRO", "Activate Pro Mode", "setShowProUpgrade", "Pro Biomechanics"]) expect(page).not.toContain(gone);
  });
});

describe("video file checks and upload recovery copy", () => {
  it("refuses a non-video or empty file before preview, and shows why without a preview", () => {
    const handle = page.slice(page.indexOf("const handleFile = useCallback("), page.indexOf("setFile(f); setPreviewUrl("));
    expect(handle).toContain("refuse(NOT_A_VIDEO_MESSAGE);");
    expect(handle).toContain("if (f.size < MIN_VIDEO_BYTES) {");
    expect(handle).toContain("refuse(EMPTY_VIDEO_MESSAGE);");
    // A refusal also drops the earlier selection, so a different video can't be sent.
    expect(handle).toContain("setFile(null); setPreviewUrl(null); setResult(null); setError(message);");
    expect(page).toMatch(/\{!previewUrl \? \(\s*<div className="flex-1 flex flex-col">[\s\S]{0,400}\{error && \(\s*<div role="alert"/);
  });

  it("refuses a final clip the analysis cannot read, before anything is uploaded", () => {
    const run = page.slice(page.indexOf("const blob = await getTrimmedBlob();"), page.indexOf(".from(BUCKET).upload("));
    expect(run).toContain("if (blob.size < MIN_VIDEO_BYTES) throw new Error(EMPTY_VIDEO_MESSAGE);");
    expect(run).toContain("if (blob.size > MAX_ANALYSIS_VIDEO_BYTES) throw new Error(CLIP_TOO_LARGE_MESSAGE);");
  });

  it("never shows raw Storage or network text", () => {
    expect(page).not.toContain("Video upload failed: ${");
    expect(page).not.toContain("Failed to register video: ${");
    expect(page).toContain("throw new Error(UPLOAD_FAILED_MESSAGE);");
    expect(page).toMatch(/err instanceof TypeError && \/Failed to fetch\|NetworkError\|Load failed\/\.test\(err\.message\)/);
    expect(page).toContain("setError(analysisStarted ? ANALYSIS_CONNECTION_LOST_MESSAGE : UPLOAD_FAILED_MESSAGE);");
  });

  it("an unusable-video refusal on the analyze page clears the selection, so the same bytes are not re-uploaded", () => {
    expect(page).toMatch(/if \(err\.status === VIDEO_UNUSABLE_STATUS\) \{\s*setFile\(null\); setPreviewUrl\(null\);/);
  });

  it("an unusable stored video sends the golfer to upload again instead of a Retry that cannot help", () => {
    expect(report).toContain("setVideoUnusable(res.status === VIDEO_UNUSABLE_STATUS);");
    expect(report).toMatch(/\{videoUnusable \? \(\s*<a\s+href="\/analyze"[\s\S]*?Upload a new video\s*<\/a>\s*\) : \(/);
  });
});

describe("a revisited failed analysis shows why, without requesting another analysis", () => {
  const reportPage = readFileSync(path.join(__dirname, "..", "app/(dashboard)/analyze/[id]/page.tsx"), "utf8");
  const swingsPage = readFileSync(path.join(__dirname, "..", "app/(dashboard)/swings/[id]/page.tsx"), "utf8");

  it("both server pages classify a failed row from its stored object, and only a failed row", () => {
    expect(reportPage).toContain('view.status === "failed"\n      ? await classifyFailedAnalysisVideo(supabase, videoRow?.storage_path, user.id)\n      : null;');
    expect(reportPage).toContain("failedReason={failedReason}");
    expect(swingsPage).toContain('swing.status === "failed"\n      ? await classifyFailedAnalysisVideo(supabase, videoRow?.storage_path, user.id)\n      : null;');
  });

  it("the report's stored failed view shows the upload-again guidance with no Retry, and keeps Retry otherwise", () => {
    const unusable = report.slice(report.indexOf("{isFailed && !showProcessing && failedReason === VIDEO_UNUSABLE_STATUS && ("), report.indexOf("{isFailed && !showProcessing && failedReason !== VIDEO_UNUSABLE_STATUS && ("));
    expect(unusable).toContain("{VIDEO_UNUSABLE_COPY}");
    expect(unusable).toContain("Upload a new video");
    expect(unusable).not.toContain("Retry");
    expect(unusable).not.toContain("onClick");
    const other = report.slice(report.indexOf("{isFailed && !showProcessing && failedReason !== VIDEO_UNUSABLE_STATUS && ("));
    expect(other.slice(0, 1400)).toContain("Retry");
  });

  it("the swings page names the reason or offers a way forward for every failed row", () => {
    expect(swingsPage).toContain('{swing.status === "failed" && failedReason === VIDEO_UNUSABLE_STATUS && (');
    expect(swingsPage).toContain('{swing.status === "failed" && failedReason !== VIDEO_UNUSABLE_STATUS && (');
    // Family-neutral, like the stalled banner beside it.
    expect(swingsPage).toContain("This analysis didn&apos;t finish. Recording the swing again starts a new analysis.");
  });

  it("the report's back link is a 44px target", () => {
    expect(reportPage).toMatch(/className="-mt-2 -ml-2 min-w-11 min-h-11 [^"]*"\s+aria-label="Back to telemetry logs"/);
  });
});

describe("dashboard navigation fits phone widths and meets the touch target", () => {
  const mobile = readFileSync(path.join(__dirname, "..", "components/navigation/MobileDashboardNavigation.tsx"), "utf8");
  const layout = readFileSync(path.join(__dirname, "..", "app/(dashboard)/layout.tsx"), "utf8");

  it("bottom tabs show a short label and keep the full one as the accessible name", () => {
    expect(mobile).toContain("{item.tabLabel ?? item.label}");
    expect(mobile).toMatch(/key=\{item\.href\}\s+href=\{item\.href\}\s+aria-label=\{item\.label\}/);
  });

  it("the logo link is a 44px target on every shell", () => {
    expect(mobile).toContain('<Link href="/" className="flex items-center gap-2 min-w-0 min-h-11">');
    expect(layout).toContain('<Link href="/" className="flex items-center gap-3 min-h-11">');
  });

  it("the italic wordmark is not clipped by its own truncation", () => {
    expect(mobile).toMatch(/italic tracking-tighter uppercase text-sm leading-none truncate pr-1/);
  });

  it("every desktop sidebar control is at least 44px tall", () => {
    // NavLink, the upgrade callout and End Session.
    const controls = Array.from(layout.matchAll(/className="(flex items-center gap-3 px-3 py-2\.5[^"]*)"/g), (m) => m[1]);
    expect(controls.length).toBe(3);
    for (const cls of controls) expect(cls).toMatch(/\bmin-h-11\b/);
  });
});
