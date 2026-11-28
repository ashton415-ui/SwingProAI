import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AG-WEB-READY-08-P1 — when the plan view CONFIRMS that its rendered account changed or its sign-in ended while a
 * generation's answer was pending, the whole account-bearing page around it ends too: header and saved-goal context, desktop
 * sidebar (also when hidden below lg), phone/tablet header, navigation and drawer, and every End Session control are
 * replaced by the rendered-session boundary's fixed, account-free guidance, which takes keyboard focus and offers an explicit
 * reload; the browser's newer sign-in is kept (app/(dashboard)/goals/plan/PlanDisplay.tsx →
 * components/navigation/RenderedSessionObservation.tsx → components/navigation/RenderedSessionBoundary.tsx).
 *
 * 1. [real renderer] — the evidence lane. The production build's own React and ReactDOM in Chromium, driven through the
 *    loopback service of the 08-P1 evidence harness (P8R_URL, http://127.0.0.1:<port>): the real layout, boundary, plan page
 *    and plan view, a stand-in Auth/database (synthetic golfers A and B; per-owner goal operations and server-verified callers
 *    recorded), a synthetic provider stand-in (calls recorded with the goal each carried). Tab 1 receives no cross-tab notice
 *    (no BroadcastChannel), so only the plan view's own confirmation can end its page, as in the hosted S-4b observation.
 *    The service answers DOM markers (textContent without script/style/template — so the sidebar hidden below lg counts —
 *    and visible innerText, separately), the boundary's guidance, focus and keyboard traversal, recovery geometry with
 *    x/y/w/h at 1280×800 and 390×844, the jar's golfer, Auth writes, action POSTs and stand-in counts. An in-page
 *    MutationObserver records the page's state after each DELIVERED mutation batch: a state that appears and is replaced
 *    within one batch is not seen, and it observes DOM changes, not React renders. Every answer carries the sha256 of the
 *    three changed source files the served build was made from and the service's own sha256; the files must equal this
 *    tree's. "[seam]" cases run on an EXTERNAL copy of the same bytes plus scheduling gates/probes (window.__p1Seam), never
 *    on the candidate. Lifecycle cases capture the plan view's reporter and the boundary's channel through a minimal React
 *    DevTools global hook (installed only in those scenarios; a read-only fiber walk) and call them directly after a
 *    replacement. Without P8R_URL this lane is skipped and reported as skipped; with it, a service or infrastructure
 *    failure fails the case.
 *    "[window]" cases (completion continuation) run on an EXTERNAL WITNESS build: the final candidate's bytes plus one external
 *    replacement route under the same dashboard layout, whose layout effect calls the REMOVED plan view's captured reporter
 *    in the very commit that removed it (a controlled lifecycle witness, not a replay of a reported incident).
 * 2. [guard] — static checks of the final source (supplementary; they never replace lane 1).
 * 3. [sim] (completion continuation) — the REAL observation module's hook under a small SIMULATED hook runtime (React's
 *    hooks below are replaced for this file; no DOM library is installed, so no jsdom/act): strict-mode re-setup and the
 *    removal commit's ordering are driven by hand. A supplement to the real-renderer W1 witness, not a substitute.
 *
 * Not claimed: atomicity with a sign-in published after the plan view's last confirmation (the "[limit]" case records that
 * window), erasure of what the page already loaded (its RSC payload scripts stay in the document until it is reloaded or
 * left; recorded, not asserted), detection in a tab that is not running, physical devices, other engines or pixel contrast.
 */

// ── [sim] runtime: React's hooks for the observation module, driven by hand (layout and passive effects recorded apart) ──
const sim = vi.hoisted(() => ({
  channel: null as unknown,
  inst: null as null | { slots: unknown[]; i: number; effects: Array<{ kind: "layout" | "passive"; fn: () => unknown }> },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const slot = <T,>(make: () => T): T => {
    const inst = sim.inst!;
    const i = inst.i++;
    if (!(i in inst.slots)) inst.slots[i] = make();
    return inst.slots[i] as T;
  };
  return {
    ...actual,
    default: actual,
    useContext: () => sim.channel,
    useRef: (init: unknown) => slot(() => ({ current: init })),
    useMemo: (fn: () => unknown) => slot(() => ({ value: fn() })).value,
    useLayoutEffect: (fn: () => unknown) => { sim.inst!.effects.push({ kind: "layout", fn }); },
    useEffect: (fn: () => unknown) => { sim.inst!.effects.push({ kind: "passive", fn }); },
  };
});

const OWN = (rel: string) => createHash("sha256").update(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)))).digest("hex");
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const PLAN_DISPLAY = "app/(dashboard)/goals/plan/PlanDisplay.tsx";
const BOUNDARY = "components/navigation/RenderedSessionBoundary.tsx";
const OBSERVATION = "components/navigation/RenderedSessionObservation.tsx";

// ── [guard] ──────────────────────────────────────────────────────────────────────────────────────────
describe("[guard] 08-P1 static contract of the final source", () => {
  it("[guard] the plan view reports only a CONFIRMED change or end, only after its final live/departure checks, never from inside mayApplyAnswer", () => {
    const s = SRC(PLAN_DISPLAY);
    const run = s.slice(s.indexOf("  function run() {"), s.indexOf("  /** Generate when nothing is saved"));
    const helper = s.slice(s.indexOf("  async function mayApplyAnswer()"), s.indexOf("  function run() {"));
    expect(helper).not.toMatch(/report/i);
    expect(run.match(/report\(/g)).toHaveLength(1);
    const at = (needle: string) => { const i = run.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at("const may = await mayApplyAnswer();")).toBeLessThan(at("if (!liveRef.current) return;"));
    expect(at("if (!liveRef.current) return;")).toBeLessThan(at('if (may === "drop" || departedRef.current) {'));
    expect(at('if (may === "drop" || departedRef.current) {')).toBeLessThan(at("setWithheld({ kind: may, refusal });"));
    expect(at("setWithheld({ kind: may, refusal });")).toBeLessThan(at('if (may === "changed" || may === "ended") {'));
    expect(at('if (may === "changed" || may === "ended") {')).toBeLessThan(at("report({"));
    // only fixed enums leave the view; the refusal code only chooses between them
    expect(run).toContain('report({ end: may === "changed" ? "account_changed" : "signed_out", plan: refusal === null ? "may_be_saved" : "refused" });');
    // the reporter is the one of the view that asked (captured when the request starts)
    expect(at("const report = reportViewEnd;")).toBeLessThan(at("startTransition(async () => {"));
    // G1: the plan view still never takes an owner from the browser's stored session
    expect(s).not.toMatch(/readStoredSession|getSession|storedSubject/);
  });

  it("[guard] the observation module is presentation-only: no store, event bus, timer, listener, storage, cookie, network or credential access", () => {
    const s = SRC(OBSERVATION);
    const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/BroadcastChannel|addEventListener|setTimeout|setInterval|localStorage|sessionStorage|document\.cookie|indexedDB|fetch\(|postMessage|window\.|globalThis/);
    expect(code).not.toMatch(/accessToken|refresh_token|password|email|jwt|cookie/i);
    expect(code).toMatch(/export function createRenderedViewEndChannel\(own: Generation\)/);
    expect(code).not.toMatch(/export const RenderedViewEndContext|export \{ RenderedViewEndContext/); // the context itself is private
    // only the two fixed enums are passed on
    expect(code).toContain('new Set<RenderedViewEnd>(["signed_out", "account_changed"])');
    expect(code).toContain('new Set<RenderedPlanOutcome>(["refused", "may_be_saved"])');
    expect(code).toContain("return handler({ end: end as RenderedViewEnd, plan: plan as RenderedPlanOutcome }) === true;");
  });

  it("[guard] the boundary accepts a report only through its current generation's channel, ends synchronously through its existing guard state, and adds no upkeep", () => {
    const s = SRC(BOUNDARY);
    expect(s).toContain("const channel = useMemo(() => createRenderedViewEndChannel({ ownerId, lineage }), [ownerId, lineage]);");
    expect(s).toContain("channelRef.current = channel;");
    expect(s).toContain("const detachReports = channel.attach({ ownerId, lineage }, (report) => channelRef.current === channel && end(report.end, report.plan));");
    expect(s).toMatch(/live = false;\n\s+checkRef\.current = \(\) => undefined;\n\s+detachReports\(\);/);
    expect(s).toMatch(/if \(!live \|\| endedRef\.current !== null\) return false;\n\s+endedRef\.current = why;/);
    const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/setInterval|setTimeout|BroadcastChannel|router\.refresh|signOut|setSession|refreshSession/g)).toBeNull();
    expect(s).toMatch(/<RenderedSessionProvider ownerId=\{ownerId\} lineage=\{lineage\}>\s*\{children\}\s*<\/RenderedSessionProvider>/);
  });

  it("[guard] session, auth, Goals and layout bytes the order keeps unchanged are byte-identical to HEAD f9c03896", () => {
    const pinned: Record<string, string> = {
      "components/navigation/SessionKeeper.tsx": "8316294d440ccea0e36852371e56592ac418558860c4ca3e6dad981b702c2ea8",
      "app/(dashboard)/layout.tsx": "86dd3138c75547b64f0caa4c3f36cce8512b5e77a1add72216aa629bbd30ee48",
      "app/(dashboard)/goals/GoalsForm.tsx": "62e86409eacb8e3307062bf53d2e6f71350bbc804fc8a12a511ceff851c9e35c",
      "app/(dashboard)/goals/actions.ts": "ee8df27856a4a06717bde7dfc4204155f19a9409c90620fca94915ddb0af1349",
      "app/(dashboard)/goals/plan/page.tsx": "42d707ee0dbbefe27da81699f6851b38b093a015c874feae466aa604705a6680",
      "lib/goal-plan-generation.ts": "316ec16e55c347145479fd13bd16e40fd77bf467bac3bdf1957e9a167759de73",
      "lib/drill-hub-session.ts": "e485051db727777322e678db485d62dc21b8b40465acd7897a772735ec30fac8",
      "utils/supabase/client.ts": "9b231f0f70039f362e672fd2e8f80400b5daee7bebbf363c354f25e9a29b5a52",
      "utils/supabase/server.ts": "e75f81bf7faefbabfd949283d3ad559c990ddf6ac30b7292400e6210a39897c7",
      "utils/supabase/session-publication.ts": "0476e8ac37085d5f985836af728d63f37f2ddfcbdbeb62164912229aa72b17c9",
      "utils/supabase/session-storage.ts": "67f634426c16b42fe469fd0ed27a7008af19a584ce115780cf53ad007ee677f2",
      "utils/supabase/session-cookie-layout.ts": "9b1862271b1f577c71766e080fac9285e5e213dbc2966f2b06356531ea303f21",
      "components/navigation/EndSessionForm.tsx": "72ae4a64ba40e81c2dddd5c528f6d4e88fa390bf9a9ae677100b2910adb50347",
      "components/navigation/MobileDashboardNavigation.tsx": "e860a575f92d3c234a8d9051121455f6be91e391d902212421c683e75187e512",
      "utils/supabase/admin.ts": "1a2fe018aa8f1a21378ab3114f60716b96ee193a6298ae46e1d6b900e953046e",
      "utils/supabase/session-lease.ts": "47baefe37a4704c9c9d1c9b3129814701e98fbba9eb5b9ddf4d1b612f76aa624",
      "utils/supabase/session-resume.ts": "dbb417eb2de4e3b7d91632f526a23b9a10aa221e100255debb7f55b4c2213cbe",
      "middleware.ts": "aae1923dce3fad0bb8faac67fa9dc181f1aeade2cf97f932d4bf37dcd6dabc62",
    };
    for (const [rel, sha] of Object.entries(pinned)) expect([rel, OWN(rel)]).toEqual([rel, sha]);
  });

  it("[guard] the reporter's lifetime is commit-phase: switched on and off in a layout-phase effect in the browser (the ordinary effect only where there is no DOM), never a passive effect", () => {
    const code = SRC(OBSERVATION).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain('const useCommitPhaseEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;');
    const hook = code.slice(code.indexOf("export function useRenderedViewEndReport()"));
    expect(hook).toMatch(/useCommitPhaseEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{\s*mounted\.current = false;\s*\};\s*\}, \[\]\);/);
    expect(hook).not.toMatch(/\buseEffect\(/);
    expect(hook).toContain("(report) => mounted.current && channel !== null && channel.report(report)");
  });

  it("[guard] the candidate carries no witness route, harness hook or seam (the controlled-lifecycle fixture exists only on external witness copies)", () => {
    expect(existsSync(fileURLToPath(new URL("../app/(dashboard)/p8-window", import.meta.url)))).toBe(false);
    for (const rel of [PLAN_DISPLAY, BOUNDARY, OBSERVATION]) expect(SRC(rel)).not.toMatch(/__p8|__p1Seam|__REACT_DEVTOOLS|P8 SEAM|P8 CONTROL|p8-window/);
  });

  it("[guard] only the plan view reports and only the boundary provides: no other product module imports the observation channel", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(rel); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name)) continue;
        if (/RenderedSessionObservation|useRenderedViewEndReport|createRenderedViewEndChannel|RenderedViewEndProvider/.test(readFileSync(join(root, rel), "utf8"))) found.push(rel);
      }
    };
    for (const dir of ["app", "components", "lib", "utils"]) walk(dir);
    expect(found.sort()).toEqual([PLAN_DISPLAY, BOUNDARY, OBSERVATION].sort());
    expect(SRC(PLAN_DISPLAY)).toContain('import { useRenderedViewEndReport } from "@/components/navigation/RenderedSessionObservation";');
    expect(SRC(PLAN_DISPLAY)).not.toMatch(/createRenderedViewEndChannel|RenderedViewEndProvider/);
    expect(SRC(BOUNDARY)).not.toMatch(/useRenderedViewEndReport/);
  });
});

// ── [real renderer] ──────────────────────────────────────────────────────────────────────────────────
type Shell = {
  path: string;
  inDom: Record<string, boolean>;
  inVisible: Record<string, boolean>;
  counts: Record<string, number>;
  visibleLinks: string[];
  visibleButtons: string[];
  ended: null | { heading: string; alert: string; planOutcome: string | null; controls: string[] };
  focus: null | { tag: string; text: string; inEnded: boolean };
  scriptPayloadA: boolean;
  bodyOverflowStyle: string | null;
};
type Control = { tag: string; label: string; href: string | null; x: number; y: number; w: number; h: number; hitCenter: boolean; hitEdges: boolean; clipped: boolean };
type Geometry = { viewport: { w: number; h: number }; heading: null | { text: string; tabIndex: number; x: number; y: number; w: number; h: number }; controls: Control[]; focusableOutside: number; overflowX: boolean };
type Active = { tag: string | null; text?: string; inEnded: boolean; focusVisible?: boolean; outlineStyle?: string; outlineWidth?: string; outlineColor?: string; x?: number; y?: number; w?: number; h?: number; by?: string };
type AtViewport = { geometry: Geometry | null; focusStart: Active; tabs: Active[] };
type Recovery = { order: string[]; w1280?: AtViewport; w390?: AtViewport };
type View = { path: string; guidance: string[]; statuses: string[]; links: string[]; planButtons: string[]; initialShown: boolean; generatedShown: string[]; savedNotice: boolean; pending: boolean;
  ended: string | null; planOutcome: string | null; focusInEnded: boolean };
type ObserverEvent = { at: number; path: string; plan: boolean; saved: boolean; initial: boolean; guidance: boolean; ended: boolean; shellA: boolean; planHeader: boolean; endSessionForms: number; unconfirmed: boolean };
type OwnerOps = { read: number; insert: number; update: number };
type Run = {
  scenario: string;
  tree: string;
  buildId: string;
  harness: string;
  error?: string;
  identity: { planDisplay: string | null; boundary: string | null; observation: string | null; windowFixture?: string | null; windowFixturePage?: string | null; markers: { seam: number; control: number } };
  steps: Record<string, boolean>;
  marks: { press: number; release: number };
  events: ObserverEvent[] | null;
  seamCalls: Array<{ point: string; at: number }> | null;
  pageErrors: string[];
  ops: { perOwner: { A: OwnerOps; B: OwnerOps; other: number }; serverAuthChecks: Array<{ as: string | null; status: number }>; browserAuth: string[] };
  providerCalls: Array<{ goal: string | null; mode: string }>;
  jarAtRelease?: string | null;
  jarAfter: string | null;
  logouts: number;
  posts: number;
  view: View;
  shell: Shell | null;
  before?: Shell;
  after?: Shell;
  withDrawer?: Shell | null;
  recovery?: Recovery | null;
  [extra: string]: unknown;
};

const P8R_URL = process.env.P8R_URL;
// set by the lane alongside P8R_URL: the service file's sha256 and each named build's BUILD_ID, read from disk
const EXPECT_HARNESS = process.env.P8R_EXPECT_HARNESS ?? "(P8R_EXPECT_HARNESS not set)";
const EXPECT_BUILDS: Record<string, string> = Object.fromEntries(
  String(process.env.P8R_EXPECT_BUILDS ?? "").split(",").filter((p) => p.includes("=")).map((p) => [p.split("=")[0], p.split("=")[1]]),
);
// the witness fixture's two files (sentinel, page), sha256 read from disk by the lane
const EXPECT_WINDOW = String(process.env.P8R_EXPECT_WINDOW ?? "(P8R_EXPECT_WINDOW not set),").split(",");
const REAL_TIMEOUT = 300_000;
const A_GOAL = "P1 A stored goal: lag putting";
const A_PLAN = `[from: ${A_GOAL}]`;
const NOTHING: OwnerOps = { read: 0, insert: 0, update: 0 };
const PLAN_MAY = "A new plan may already have been saved for the account this page was opened for.";
const PLAN_REFUSED = "Your plan request was refused before anything was saved or generated.";
const A_MARKERS = ["accountA", "goalA", "initialPlan", "planHeader", "goalsEntry", "answers", "setNewGoals", "endSession", "badge", "navProgress", "navBag", "navDrills", "planBilling", "aiIntegrated", "generatedPlan"];
const SHELL_COUNTS = ["aside", "header", "nav", "endSessionForms", "drawer", "drawerButtons", "planHeading", "planButtons", "forms", "planGuidance", "refusedNotice"];

type Tree = "final" | "seam" | "window";
function realRun(scenario: string, tree: Tree): Promise<Run> {
  const body = JSON.stringify({ scenario, tree });
  return new Promise((resolve, reject) => {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(String(P8R_URL))) {
      reject(new Error("P8R_URL must be a loopback origin (http://127.0.0.1:<port>)"));
      return;
    }
    const req = request(new URL("/run", String(P8R_URL)), { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(new Error(`real-renderer service answered ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as Run);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(REAL_TIMEOUT - 10_000, () => req.destroy(new Error("the real-renderer service did not answer in time")));
    req.end(body);
  });
}
// one run per scenario and build, shared by the cases that read different properties of it (so a control build can fail
// the shell cases while the plan-side cases of the very same run pass)
const runs = new Map<string, Promise<Run>>();
async function once(scenario: string, tree: Tree): Promise<Run> {
  const key = `${scenario}@${tree}`;
  if (!runs.has(key)) runs.set(key, realRun(scenario, tree));
  const r = await runs.get(key)!;
  expect(r.error).toBeUndefined();
  expect(Array.isArray(r.events) && r.events.length > 0).toBe(true);
  return r;
}
const sincePress = (r: Run) => (r.events ?? []).filter((e) => e.at >= r.marks.press);
const sinceRelease = (r: Run) => (r.events ?? []).filter((e) => e.at >= r.marks.release);
const seamCount = (r: Run, point: string) => (r.seamCalls ?? []).filter((c) => c.at >= r.marks.press && c.point === point).length;

/** The scenario ran as described, on the named build made from THIS tree's three changed files, without a page error. */
function expectRan(r: Run, tree: Tree) {
  expect.soft(r.tree).toBe(tree);
  expect.soft(Object.keys(r.steps ?? {}).length).toBeGreaterThan(0);
  for (const [step, ok] of Object.entries(r.steps ?? {})) expect.soft([step, ok]).toEqual([step, true]);
  expect.soft(r.pageErrors).toEqual([]);
  // the service file and the build ids the lane read from disk before starting (independently of the service's answers)
  expect.soft(r.harness).toBe(EXPECT_HARNESS);
  expect.soft(r.buildId).toBe(EXPECT_BUILDS[tree]);
  expect.soft(r.identity.observation).toBe(OWN(OBSERVATION));
  // continuation: only a witness build carries the external controlled-lifecycle route; the candidate and seam builds never do
  expect.soft(r.identity.windowFixture ?? null).toBe(tree === "window" ? EXPECT_WINDOW[0] : null);
  expect.soft(r.identity.windowFixturePage ?? null).toBe(tree === "window" ? EXPECT_WINDOW[1] : null);
  if (tree === "final" || tree === "window") {
    expect.soft(r.identity.planDisplay).toBe(OWN(PLAN_DISPLAY));
    expect.soft(r.identity.boundary).toBe(OWN(BOUNDARY));
    expect.soft(r.identity.markers.seam).toBe(0);
    expect.soft(r.seamCalls).toEqual([]);
  } else {
    expect.soft(r.identity.boundary).toBe(OWN(BOUNDARY));
    expect.soft(r.identity.markers.seam).toBeGreaterThan(0);
    expect.soft(r.identity.markers.control).toBe(0);
  }
}

/** Nothing of A's account, plan, saved goal, navigation or End Session remains in the DOM (hidden or not) or on screen. */
function expectNoOldPage(s: Shell | null | undefined, label: string) {
  expect.soft(s, label).toBeTruthy();
  if (!s) return;
  for (const k of A_MARKERS) {
    expect.soft([label, "dom", k, s.inDom[k]]).toEqual([label, "dom", k, false]);
    expect.soft([label, "visible", k, s.inVisible[k]]).toEqual([label, "visible", k, false]);
  }
  expect.soft([label, "accountB", s.inDom.accountB]).toEqual([label, "accountB", false]); // nothing of B is shown either
  for (const k of SHELL_COUNTS) expect.soft([label, k, s.counts[k]]).toEqual([label, k, 0]);
  expect.soft(s.bodyOverflowStyle === "hidden").toBe(false); // the drawer's scroll lock went with it
}

/** The fixed recovery at both viewports: reachable controls ≥44×44 (hit at the centre and at four 2px-inset edge
 *  midpoints, not clipped), no horizontal overflow, nothing focusable outside it, focus starting inside it and Tab
 *  reaching its Reload control with a visible (non-transparent) focus outline. */
function expectRecovery(r: Run, controls: string[]) {
  const rec = r.recovery;
  expect.soft(rec).toBeTruthy();
  if (!rec) return;
  for (const name of ["w1280", "w390"] as const) {
    const at = rec[name];
    expect.soft(at, name).toBeTruthy();
    if (!at) continue;
    const g = at.geometry;
    expect.soft(g, name).toBeTruthy();
    if (!g) continue;
    expect.soft(g.viewport).toEqual(name === "w1280" ? { w: 1280, h: 800 } : { w: 390, h: 844 });
    expect.soft(g.controls.map((c) => c.label)).toEqual(controls);
    for (const c of g.controls) {
      expect.soft([name, c.label, typeof c.x, typeof c.y]).toEqual([name, c.label, "number", "number"]);
      expect.soft([name, c.label, c.w >= 44, c.h >= 44, c.hitCenter, c.hitEdges, c.clipped]).toEqual([name, c.label, true, true, true, true, false]);
    }
    expect.soft([name, "overflowX", g.overflowX]).toEqual([name, "overflowX", false]);
    expect.soft([name, "focusableOutside", g.focusableOutside]).toEqual([name, "focusableOutside", 0]);
    expect.soft([name, "heading tabIndex", g.heading?.tabIndex]).toEqual([name, "heading tabIndex", -1]);
    expect.soft([name, "focus start", at.focusStart.tag, at.focusStart.inEnded]).toEqual([name, "focus start", "h1", true]);
    const firstTab = at.tabs[0];
    expect.soft([name, "first Tab", firstTab?.text, firstTab?.inEnded, firstTab?.focusVisible, firstTab?.outlineStyle, firstTab?.outlineWidth]).toEqual([name, "first Tab", "Reload page", true, true, "solid", "2px"]);
    expect.soft([name, "first Tab outline colour", /^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(firstTab?.outlineColor ?? "transparent")]).toEqual([name, "first Tab outline colour", false]);
    if (controls.length > 1) expect.soft([name, "second Tab", at.tabs[1]?.text, at.tabs[1]?.inEnded]).toEqual([name, "second Tab", controls[1], true]);
  }
  expect.soft(rec[rec.order[0] as "w1280" | "w390"]?.focusStart.by).toBe("app"); // the app moved focus into the recovery itself
}

/** A's request was verified and finished as A only; nothing ran as B; B's session was kept; nothing was retried. */
function expectOnlyAsA(r: Run, update: 0 | 1, provider: Array<{ goal: string | null; mode: string }>) {
  expect.soft(r.ops.perOwner.B).toEqual(NOTHING);
  expect.soft(r.ops.perOwner.other).toBe(0);
  expect.soft(r.ops.perOwner.A).toMatchObject({ insert: 0, update });
  expect.soft(r.providerCalls).toEqual(provider);
  expect.soft(r.posts).toBe(1);
}

const CORE = [
  { id: "S1", what: "no plan on screen, 1280×800", initial: false, drawer: false },
  { id: "S2", what: "A's saved plan on screen, 1280×800", initial: true, drawer: false },
  { id: "S3", what: "A's saved plan on screen, 390×844 with the navigation drawer open", initial: true, drawer: true },
] as const;

describe.skipIf(!P8R_URL)("[real renderer] 08-P1: the composed plan view and rendered-session boundary in the production build (P8R_URL)", () => {
  // ── core S-4b closure ──
  it.each(CORE)("[final] $id plan side ($what): A's held answer, released after B signed in from another tab, is withheld; B's session kept; only A's verified work finished", async ({ id }) => {
    const r = await once(id, "final");
    expectRan(r, "final");
    expect.soft(sincePress(r).filter((e) => e.plan || e.saved)).toEqual([]);
    // the answer did arrive and was withheld: the view left "Generating…" for withheld guidance (the plan view's own, or the
    // boundary's that replaced it), never for a result
    expect.soft(r.view.pending).toBe(false);
    expect.soft(sinceRelease(r).some((e) => e.ended || e.guidance)).toBe(true);
    expect.soft(r.view.generatedShown).toEqual([]);
    expect.soft(r.view.savedNotice).toBe(false);
    expect.soft(r.view.initialShown).toBe(false);
    expect.soft(r.jarAtRelease).toBe("B");
    expect.soft(r.jarAfter).toBe("B");
    expect.soft(r.logouts).toBe(0);
    expectOnlyAsA(r, 1, [{ goal: A_GOAL, mode: "hold" }]);
  }, REAL_TIMEOUT);

  it.each(CORE)("[final] $id shell side ($what): the whole old page — account, plan header, saved goal, sidebar (hidden or not), navigation, drawer, End Session — is replaced by fixed recovery that takes focus", async ({ id, drawer }) => {
    const r = await once(id, "final");
    // before: A's full shell, header and saved goal were there (and the drawer, when opened)
    for (const k of ["accountA", "goalA", "planHeader", "answers", "endSession", "navBag"]) expect.soft(["before", k, r.before?.inDom[k]]).toEqual(["before", k, true]);
    expect.soft(r.before?.counts.aside).toBe(1);
    expect.soft((r.before?.counts.endSessionForms ?? 0) >= 1).toBe(true);
    if (drawer) {
      expect.soft(r.withDrawer?.counts.drawer).toBe(1);
      expect.soft(r.withDrawer?.inVisible.accountA).toBe(true);
      expect.soft(r.withDrawer?.counts.endSessionForms).toBe(2); // the hidden sidebar's and the drawer's
    }
    expectNoOldPage(r.after, "after");
    expect.soft(r.after?.ended?.heading).toBe("Signed in to a different account");
    expect.soft(r.after?.ended?.alert).toContain(PLAN_MAY);
    expect.soft(r.after?.ended?.planOutcome).toBe("may_be_saved");
    expect.soft(r.after?.ended?.controls).toEqual(["button:Reload page"]);
    expect.soft(r.view.focusInEnded).toBe(true);
    // the observer never delivered a state with the recovery AND any of the old page at once
    expect.soft(sinceRelease(r).filter((e) => e.ended && (e.shellA || e.planHeader || e.endSessionForms > 0))).toEqual([]);
    expect.soft(sinceRelease(r).some((e) => e.ended)).toBe(true);
    expectRecovery(r, ["Reload page"]);
  }, REAL_TIMEOUT);

  it("[final] S2 the recovery's Reload page, by keyboard (Tab, Enter), loads a fresh page for the account signed in now; nothing is generated or sent", async () => {
    const r = await once("S2", "final");
    const re = r.reloaded as { onReload: Active; newDocument: boolean; shell: Shell; view: View; postsSince: number; providerSince: unknown[]; opsSince: { perOwner: { A: OwnerOps; B: OwnerOps } } } | null;
    expect.soft(re).toBeTruthy();
    if (!re) return;
    expect.soft([re.onReload.text, re.onReload.focusVisible]).toEqual(["Reload page", true]);
    expect.soft(re.newDocument).toBe(true);
    expect.soft(re.shell.ended).toBeNull();
    expect.soft(re.shell.inDom.accountB).toBe(true);
    expect.soft(re.shell.inDom.accountA).toBe(false);
    expect.soft(re.shell.inDom.goalA).toBe(false);
    expect.soft(re.postsSince).toBe(0);
    expect.soft(re.providerSince).toEqual([]);
    expect.soft(re.opsSince.perOwner.B).toMatchObject({ insert: 0, update: 0 });
    expect.soft(re.opsSince.perOwner.A).toEqual(NOTHING);
  }, REAL_TIMEOUT);

  // ── confirmed end, and a newer sign-in of the same account ──
  it("[final] S4 End Session of the rendered lineage (another tab) while A's answer is held: the whole page ends as 'sign-in has ended', with Sign in; nothing else revoked", async () => {
    const r = await once("S4", "final");
    expectRan(r, "final");
    expect.soft(r.jarAfterEnd).toBeNull();
    expect.soft(r.jarAtRelease).toBeNull();
    expect.soft(r.logouts).toBe(1); // tab 2's own End Session, of the rendered lineage; nothing more
    expect.soft(sincePress(r).filter((e) => e.plan || e.saved)).toEqual([]);
    expectOnlyAsA(r, 1, [{ goal: A_GOAL, mode: "hold" }]);
    expectNoOldPage(r.after, "after");
    expect.soft(r.after?.ended?.heading).toBe("This page's sign-in has ended");
    expect.soft(r.after?.ended?.planOutcome).toBe("may_be_saved");
    expect.soft(r.after?.ended?.controls).toEqual(["button:Reload page", "a:Sign in -> /login"]);
    expectRecovery(r, ["Reload page", "Sign in"]);
  }, REAL_TIMEOUT);

  it("[final] S5 End Session, then a NEWER sign-in of the same account before the answer: not an end — the server's own outcome for A's request is shown ('couldn't confirm whether your new plan was saved', its readback ran on the token End Session revoked) and the page stays", async () => {
    const r = await once("S5", "final");
    expectRan(r, "final");
    expect.soft(r.jarAfterEnd).toBeNull();
    expect.soft(r.jarAtRelease).toBe("A");
    // applied, not withheld: no plan-view or boundary guidance. The server's own outcome is shown — with the stand-in, End
    // Session revoked the token A's request was still using, so its post-write readback could not see the row: the honest
    // "couldn't confirm" notice with Reload My Plan (observed outcome, pinned)
    expect.soft(r.view.guidance).toEqual([]);
    expect.soft(r.view.statuses.join(" ")).toMatch(/couldn't confirm whether your new plan was saved/);
    expect.soft(r.view.links).toContain("Reload My Plan -> /goals/plan");
    expect.soft(r.view.ended).toBeNull();
    expect.soft(r.after?.ended).toBeNull();
    expect.soft(r.after?.inDom.accountA).toBe(true);
    expect.soft(r.after?.counts.aside).toBe(1);
    expect.soft(sincePress(r).filter((e) => e.ended || e.guidance)).toEqual([]);
    expect.soft(r.logouts).toBe(1);
    expect.soft(r.jarAfter).toBe("A");
    expectOnlyAsA(r, 1, [{ goal: A_GOAL, mode: "hold" }]);
  }, REAL_TIMEOUT);

  // ── a known refusal together with a confirmed change ──
  it("[final] S6 the request leaves after B signed in and is refused by G1 (verified as B) before any work; the confirmed change ends the page with 'refused before anything was saved'", async () => {
    const r = await once("S6", "final");
    expectRan(r, "final");
    expect.soft(r.jarAtRelease).toBe("B");
    expect.soft(r.ops.serverAuthChecks.some((c) => c.as === "B")).toBe(true);
    expect.soft(r.ops.perOwner.A).toEqual(NOTHING);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING);
    expect.soft(r.providerCalls).toEqual([]);
    expect.soft(r.posts).toBe(1);
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.jarAfter).toBe("B");
    expectNoOldPage(r.after, "after");
    expect.soft(r.after?.ended?.heading).toBe("Signed in to a different account");
    expect.soft(r.after?.ended?.alert).toContain(PLAN_REFUSED);
    expect.soft(r.after?.ended?.alert).not.toContain("may already have been saved");
    expect.soft(r.after?.ended?.planOutcome).toBe("refused");
    expectRecovery(r, ["Reload page"]);
  }, REAL_TIMEOUT);

  // ── ordinary positives ──
  it("[final] S7 ordinary use is unchanged: generate, Regenerate → Keep current plan (nothing sent), provider failure (plan kept), saved plan read back; the page never ends", async () => {
    const r = await once("S7", "final");
    expectRan(r, "final");
    const v1 = r.v1 as View;
    const v2 = r.v2 as View;
    const v3 = r.v3 as View;
    expect.soft(v1.generatedShown).toEqual([A_PLAN]);
    expect.soft(v1.savedNotice).toBe(true);
    expect.soft(r.postsAfterKeep).toBe(1);
    expect.soft(v2.statuses.join(" ")).toMatch(/We couldn't create a new plan/);
    expect.soft(v2.generatedShown).toEqual([A_PLAN]);
    expect.soft((r.shellAfterFailure as Shell).inDom.accountA).toBe(true);
    expect.soft(v3.generatedShown).toEqual([A_PLAN]);
    expect.soft(v3.guidance).toEqual([]);
    expect.soft(sincePress(r).filter((e) => e.ended || e.guidance)).toEqual([]);
    expect.soft(r.posts).toBe(2);
    expect.soft(r.providerCalls).toEqual([{ goal: A_GOAL, mode: "ok" }, { goal: A_GOAL, mode: "fail500" }]);
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING);
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
  }, REAL_TIMEOUT);

  // ── uncertainty ──
  it("[final] S8 the account cannot be confirmed (Auth refresh refused): the plan view withholds as before and the page is NOT ended; no identity mutation and no B effects — A's already-verified request still completes as A", async () => {
    const r = await once("S8", "final");
    expectRan(r, "final");
    expect.soft(r.view.guidance.join(" ")).toMatch(/^plan: We couldn't confirm the signed-in account/);
    expect.soft(r.view.ended).toBeNull();
    expect.soft(r.after?.ended).toBeNull();
    expect.soft(r.after?.inDom.accountA).toBe(true);
    expect.soft(r.after?.counts.aside).toBe(1);
    expect.soft(sincePress(r).filter((e) => e.ended)).toEqual([]);
    // no identity mutation: the jar still names A, nothing was logged out, and the browser's only Auth request was the
    // refused refresh (no new session was issued or adopted); no B effect of any kind
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.ops.browserAuth).toEqual(["auth:refresh:anon:429"]); // exactly the one refused refresh (the precondition)
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING);
    expect.soft(r.ops.perOwner.other).toBe(0);
    // A's verified work did finish while its client could not confirm the result (valid uncertainty behaviour, kept as observed):
    // the server verified A once, read A's goal and wrote A's plan (one update), and called the synthetic provider once
    expect.soft(r.ops.serverAuthChecks.map((c) => c.as)).toEqual(["A"]);
    expect.soft(r.ops.perOwner.A).toEqual({ read: 2, insert: 0, update: 1 }); // A's goal read and post-write readback, one update
    expect.soft(r.providerCalls).toEqual([{ goal: A_GOAL, mode: "ok" }]);
    expect.soft(r.posts).toBe(1);
  }, REAL_TIMEOUT);

  // ── lifecycle: removed views' reporters and channels ──
  it("[final] S9 a true unmount (back) while the answer is held: nothing is reported; the removed plan view's captured reporter, called directly, ends nothing", async () => {
    const r = await once("S9", "final");
    expectRan(r, "final");
    expect.soft(r.devtoolsHook).toBe(true);
    expect.soft(r.sameBoundaryGeneration).toBe(true);
    expect.soft(r.staleReporter).toBe(false);
    expect.soft(r.after?.path).toBe("/dashboard");
    expect.soft(r.after?.ended).toBeNull();
    expect.soft(r.after?.inDom.accountA).toBe(true);
    expect.soft(sincePress(r).filter((e) => e.ended || e.plan || e.saved)).toEqual([]);
    expectOnlyAsA(r, 1, [{ goal: A_GOAL, mode: "hold" }]); // the held answer did finish (as A) after the view was gone
    expect.soft(r.jarAfter).toBe("A");
  }, REAL_TIMEOUT);

  // S10's reporter half is from a plan view already unmounted on /bag; the channel half is the lineage evidence. S13 covers
  // a still-mounted plan view across the same-owner lineage change.
  it("[final] S10 a retained boundary receiving a NEWER LINEAGE of the same owner (A2, via the page's own Try again refresh): the A1 channel (and the unmounted A1 reporter) end nothing; the current channel does (control)", async () => {
    const r = await once("S10", "final");
    expectRan(r, "final");
    expect.soft(r.jarAfterA2).toBe("A");
    expect.soft(r.sameGenerationBeforeRefresh).toBe(true);
    expect.soft(r.session).toEqual({ sameOwner: true, sameLineage: false, lineagePresent: true });
    expect.soft(r.channelReplaced).toBe(true);
    expect.soft([r.staleReporter, r.staleChannel, r.staleChannelEnd]).toEqual([false, false, false]);
    expect.soft((r.afterStale as Shell).ended).toBeNull();
    expect.soft((r.afterStale as Shell).inDom.accountA).toBe(true);
    expect.soft(r.currentChannel).toBe(true);
    expect.soft((r.afterCurrent as Shell).ended?.heading).toBe("This page's sign-in has ended");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.jarAfter).toBe("A");
  }, REAL_TIMEOUT);

  it.each([
    { id: "S11", who: "B", what: "B", sameOwner: false },
    { id: "S11b", who: "A", what: "a newer sign-in of the same owner (A2)", sameOwner: true },
  ])("[final] $id a FRESH boundary for $what in the same document: the A1 view's captured reporter and channel, called directly, cannot end it; its own live reporter can (control)", async ({ id, who, sameOwner }) => {
    const r = await once(id, "final");
    expectRan(r, "final");
    expect.soft(r.session).toEqual({ sameOwner, sameLineage: false, lineagePresent: true });
    expect.soft(r.channelReplaced).toBe(true);
    expect.soft([r.staleReporter, r.staleChannel]).toEqual([false, false]);
    const stale = r.afterStale as Shell;
    expect.soft(stale.ended).toBeNull();
    expect.soft(stale.counts.aside).toBe(1);
    if (who === "B") {
      expect.soft(stale.inDom.accountB).toBe(true);
      expect.soft(stale.inDom.goalB).toBe(true);
      expect.soft(stale.inDom.accountA).toBe(false);
    } else expect.soft(stale.inDom.accountA).toBe(true);
    // positive control (harness-invoked): the new view's own live reporter is accepted — the capture and the path are real
    expect.soft(r.liveReporter).toBe(true);
    expect.soft((r.afterLive as Shell).ended?.heading).toBe("Signed in to a different account");
    expect.soft(r.jarAfter).toBe(who);
    expect.soft(r.logouts).toBe(0);
  }, REAL_TIMEOUT);

  it("[final] S13 a retained boundary and a STILL-MOUNTED plan view receiving a newer lineage of the same owner (A2, code-started refresh): the A1 reporter and channel end nothing; the A2 reporter does (control)", async () => {
    const r = await once("S13", "final");
    expectRan(r, "final");
    expect.soft(r.jarAfterA2).toBe("A");
    expect.soft(r.session).toEqual({ sameOwner: true, sameLineage: false, lineagePresent: true });
    expect.soft(r.planStillMounted).toBe(true); // the same plan-view DOM node before and after the refresh
    expect.soft([r.reporterReplaced, r.channelReplaced]).toEqual([true, true]);
    expect.soft([r.staleReporter, r.staleChannel]).toEqual([false, false]);
    expect.soft((r.afterStale as Shell).ended).toBeNull();
    expect.soft((r.afterStale as Shell).inDom.accountA).toBe(true);
    expect.soft(r.liveReporter).toBe(true);
    expect.soft((r.afterLive as Shell).ended?.heading).toBe("This page's sign-in has ended");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.posts).toBe(0);
  }, REAL_TIMEOUT);

  it("[final] S12 the retained layout rendered again for another owner (a code-started refresh after B signed in): the view ends as an account change with no plan claim; A's reporter and channel end nothing more", async () => {
    const r = await once("S12", "final");
    expectRan(r, "final");
    expectNoOldPage(r.after, "after");
    expect.soft(r.after?.ended?.heading).toBe("Signed in to a different account");
    expect.soft(r.after?.ended?.planOutcome).toBeNull();
    expect.soft([r.staleReporter, r.staleChannel]).toEqual([false, false]);
    expect.soft(r.jarAfter).toBe("B");
  }, REAL_TIMEOUT);

  // ── continuation: the removal-commit window (CONTROLLED LIFECYCLE WITNESS on an external witness build) ──
  // The witness build is the final candidate's bytes plus an external replacement route under the same dashboard layout
  // (fixtures/p8-window); its sentinel calls the REMOVED plan view's captured reporter in the very commit that removed it.
  type WitnessProbe = { when: string; at: number; planDomConnected: boolean; passiveCleanupRan: boolean; result: unknown };
  type WitnessRecord = { mode: string; probes: WitnessProbe[]; navAt: number; sentinelLayoutAt: number | null; sentinelPassiveAt: number | null; passiveCleanupAt: number | null;
    passiveCleanupRanBeforeSentinelPassive: boolean | null; popstateRemovalsSinceNav: number };
  it("[window] W1 the removed plan view's captured reporter, called from the replacement page's layout effect in the removal commit — after its DOM was removed, before its passive cleanup — ends nothing; the replacement page stays usable", async () => {
    const r = await once("W1", "window");
    expectRan(r, "window");
    const rec = r.record as WitnessRecord;
    expect.soft(rec.mode).toBe("layout");
    expect.soft(rec.probes).toHaveLength(1);
    const probe = rec.probes[0];
    // the probe was really inside the window: DOM removed, passive cleanup not yet run (it ran after the probe)
    expect.soft([probe?.when, probe?.planDomConnected, probe?.passiveCleanupRan]).toEqual(["sentinel-layout-effect", false, false]);
    expect.soft(rec.passiveCleanupAt !== null && probe !== undefined && rec.passiveCleanupAt > probe.at).toBe(true);
    expect.soft(rec.popstateRemovalsSinceNav).toBe(1); // the removed plan view's own cleanup, once
    // the old reporter was refused: same retained boundary generation, no guidance, the replacement page and its control usable
    expect.soft(probe?.result).toBe(false);
    expect.soft(r.sameChannel).toBe(true);
    expect.soft(r.sentinelPresent).toBe(true);
    expect.soft(r.presses).toBe(1);
    const page = r.replacement as Shell;
    expect.soft(page.path).toBe("/p8-window");
    expect.soft(page.ended).toBeNull();
    expect.soft(page.inDom.accountA).toBe(true);
    expect.soft(page.counts.aside).toBe(1);
    expect.soft(sincePress(r).filter((e) => e.ended)).toEqual([]);
    // the browser session and identity are unchanged
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.posts).toBe(0);
    expect.soft(r.ops.browserAuth).toEqual([]);
  }, REAL_TIMEOUT);

  it("[window] W2 the same reporter called from a microtask queued in that layout effect ends nothing (records whether that microtask fell before the passive cleanup)", async () => {
    const r = await once("W2", "window");
    expectRan(r, "window");
    const rec = r.record as WitnessRecord;
    expect.soft(rec.mode).toBe("microtask");
    expect.soft(rec.probes).toHaveLength(1);
    expect.soft(rec.probes[0]?.planDomConnected).toBe(false);
    expect.soft(rec.probes[0]?.result).toBe(false);
    expect.soft(typeof rec.probes[0]?.passiveCleanupRan).toBe("boolean"); // recorded as observed (the schedule decides)
    expect.soft(r.sentinelPresent).toBe(true);
    expect.soft(r.presses).toBe(1);
    expect.soft((r.replacement as Shell).ended).toBeNull();
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
  }, REAL_TIMEOUT);

  it("[final] W3 positive control: the CURRENT plan view's captured reporter is accepted and ends only its own page — another view of the same account in the same browser is untouched; the session is unchanged", async () => {
    const r = await once("W3", "final");
    expectRan(r, "final");
    expect.soft(r.live).toBe(true);
    expect.soft(r.after?.ended?.heading).toBe("Signed in to a different account");
    expectNoOldPage(r.after, "after");
    const tab2 = r.tab2 as Shell;
    expect.soft(tab2.ended).toBeNull();
    expect.soft(tab2.inDom.accountA).toBe(true);
    expect.soft(tab2.counts.aside).toBe(1);
    expect.soft(r.jarAfter).toBe("A");
    expect.soft(r.logouts).toBe(0);
    expect.soft(r.posts).toBe(0);
    expect.soft(r.ops.browserAuth).toEqual([]);
  }, REAL_TIMEOUT);

  // ── exact schedules on the external seam copy ──
  it.each([
    ["R6", 1, "FIRST"],
    ["R6b", 2, "SECOND"],
  ] as const)("[seam] %s B is published while the owner confirmation %i (%s) is awaited: one report after the caller's checks; the whole page ends", async (id, confirmations, which) => {
    expect(which).toBe(confirmations === 1 ? "FIRST" : "SECOND");
    const r = await once(id, "seam");
    expectRan(r, "seam");
    expect.soft(seamCount(r, "confirm")).toBe(confirmations);
    expect.soft(seamCount(r, "report")).toBe(1);
    expectNoOldPage(r.shell, "shell");
    expect.soft(r.shell?.ended?.planOutcome).toBe("may_be_saved");
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING);
    expect.soft(r.jarAfter).toBe("B");
  }, REAL_TIMEOUT);

  it("[seam] R7 unmounted (back) at the helper-to-caller handoff: no report; the page the golfer went back to stays", async () => {
    const r = await once("R7", "seam");
    expectRan(r, "seam");
    expect.soft(seamCount(r, "handoff")).toBe(1);
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(r.shell?.path).toBe("/dashboard");
    expect.soft(r.shell?.ended).toBeNull();
    expect.soft(r.shell?.inDom.accountA).toBe(true);
  }, REAL_TIMEOUT);

  it("[seam] R8 left while still mounted at the handoff (queued navigation): no report; the chosen page is reached and stays", async () => {
    const r = await once("R8", "seam");
    expectRan(r, "seam");
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(r.shell?.ended).toBeNull();
    expect.soft(r.shell?.path).not.toBe("/goals/plan");
    expect.soft(r.shell?.inDom.accountA).toBe(true);
  }, REAL_TIMEOUT);

  it("[seam] [limit] S14 B is published while the handoff is held, after both confirmations answered A: no report (nothing was confirmed changed); recorded as the non-atomic window — the page's next press is refused and the boundary's own check ends it", async () => {
    const r = await once("S14", "seam");
    expectRan(r, "seam");
    expect.soft(seamCount(r, "confirm")).toBe(2);
    expect.soft(seamCount(r, "report")).toBe(0);
    expect.soft(r.jarAtRelease).toBe("B");
    expect.soft((r.afterRelease as Shell).ended).toBeNull();
    expect.soft(r.pressRefused).toEqual({ target: "button", defaultPrevented: true }); // the old page's press was refused
    expect.soft(r.endedByGuard).toBe(true);
    expect.soft(r.after?.ended?.heading).toBe("Signed in to a different account");
    expect.soft(r.after?.ended?.planOutcome).toBeNull();
    expect.soft(r.ops.perOwner.B).toEqual(NOTHING);
    expect.soft(r.jarAfter).toBe("B");
    expect.soft(r.logouts).toBe(0);
  }, REAL_TIMEOUT);
});

// ── [sim] the reporter's own lifetime under a simulated hook runtime (see header lane 3) ─────────────────────────────
describe("[sim] 08-P1 continuation: the real reporter hook's commit-phase lifetime, driven by hand", () => {
  type Mod = typeof import("@/components/navigation/RenderedSessionObservation");
  const REPORT = { end: "account_changed", plan: "may_be_saved" } as const;
  /** Imports the module fresh, with or without a browser `window` (its effect kind is chosen once, at import). */
  async function load(browser: boolean): Promise<Mod> {
    vi.resetModules();
    if (browser) vi.stubGlobal("window", {});
    try {
      return await import("@/components/navigation/RenderedSessionObservation");
    } finally {
      if (browser) vi.unstubAllGlobals();
    }
  }
  /** Renders the hook once as one component instance; returns its reporter and the effects that render scheduled. */
  function render(mod: Mod) {
    sim.inst = { slots: [], i: 0, effects: [] };
    const report = mod.useRenderedViewEndReport();
    const effects = sim.inst.effects;
    sim.inst = null;
    return { report, effects };
  }
  function channelFor(mod: Mod, accepted: unknown[]) {
    const channel = mod.createRenderedViewEndChannel({ ownerId: "owner-a", lineage: "lineage-a1" });
    channel.attach({ ownerId: "owner-a", lineage: "lineage-a1" }, (r) => { accepted.push(r); return true; });
    sim.channel = channel;
    return channel;
  }

  it("[sim] in the browser the lifetime is a layout-phase effect: strict-mode re-setup (setup → cleanup → setup) leaves the reporter live; the removal commit's layout cleanup makes it inert before the replacement's layout effect calls it", async () => {
    const mod = await load(true);
    const accepted: unknown[] = [];
    channelFor(mod, accepted);
    const old = render(mod);
    expect(old.effects.map((e) => e.kind)).toEqual(["layout"]); // commit-phase, never passive
    expect(old.report(REPORT)).toBe(false); // not yet committed
    // StrictMode (development): React sets the layout effect up, cleans it up and sets it up again
    const first = old.effects[0].fn() as () => void;
    first();
    const cleanup = old.effects[0].fn() as () => void;
    expect(old.report(REPORT)).toBe(true); // the live view's report is accepted (positive)
    // the commit that removes the old view and mounts its replacement: the removed view's layout cleanup runs (mutation
    // phase), then the replacement's layout effect is set up and calls the OLD captured reporter
    const replacement = render(mod);
    const order: string[] = [];
    cleanup();
    order.push("removed view: layout cleanup");
    order.push(`replacement layout effect: old reporter -> ${String(old.report(REPORT))}`);
    replacement.effects[0].fn();
    order.push(`replacement: its own reporter -> ${String(replacement.report(REPORT))}`);
    expect(order).toEqual(["removed view: layout cleanup", "replacement layout effect: old reporter -> false", "replacement: its own reporter -> true"]);
    expect(accepted).toEqual([REPORT, REPORT]); // the live view's report and the replacement's own — never the removed view's
    sim.channel = null;
  });

  it("[sim] where there is no DOM (server rendering) the ordinary effect stands in, never runs there, and nothing is reported", async () => {
    const mod = await load(false);
    const accepted: unknown[] = [];
    channelFor(mod, accepted);
    const view = render(mod);
    expect(view.effects.map((e) => e.kind)).toEqual(["passive"]);
    expect(view.report(REPORT)).toBe(false);
    expect(accepted).toEqual([]);
    sim.channel = null;
  });
});
