import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDrillHubLoader,
  readDrillHub,
  DRILL_HUB_UNAVAILABLE_COPY,
  type DrillHubRead,
  type DrillHubResult,
  type DrillHubState,
  type ListReadResponse,
} from "@/lib/golfer-journey-read-state";
import DrillsPage from "@/app/(dashboard)/drills/page";
import { DRILL_HUB_UNCONFIRMED_COPY } from "@/lib/drill-hub-session";

// Vitest compiles TSX with the classic JSX runtime, which needs React in scope
// (the same arrangement as the existing render tests).
(globalThis as Record<string, unknown>).React = React;

/**
 * GJ-PARALLEL-01 — Drill Hub loading. The catalog and the golfer's progress are
 * read together; the hub is ready only when both succeed. A failure of either
 * (returned error, rejection, throw, client construction) is one finite
 * "unavailable" state that carries no drills, statuses, counts or error text.
 * Try again reuses one loader: no stacked reads, no stale or post-unmount
 * completion replacing newer state.
 */

interface Drill { id: string; name: string; target_metric: string; the_why: string; the_how: string; the_feel: string }
interface UserDrill { drill_id: string; status: "pending" | "submitted" | "verified" | "needs_work"; latest_ai_feedback: string | null }

const DRILLS: Drill[] = [
  { id: "d-1", name: "Gate Drill", target_metric: "club_path", the_why: "w", the_how: "h", the_feel: "f" },
  { id: "d-2", name: "Pump Drill", target_metric: "lag", the_why: "w", the_how: "h", the_feel: "f" },
];
const PROGRESS: UserDrill[] = [{ drill_id: "d-1", status: "verified", latest_ai_feedback: "Nice." }];
const SQL_ERROR = { message: 'relation "public.user_drills" permission denied; JWT expired for 7f3c', code: "42501" };

const ok = <T,>(data: T[]): (() => Promise<ListReadResponse<T>>) => () => Promise.resolve({ data, error: null });
const failed = <T,>(): (() => Promise<ListReadResponse<T>>) => () => Promise.resolve({ data: null, error: SQL_ERROR });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function recorder() {
  const states: DrillHubState<Drill, UserDrill>[] = [];
  return { states, publish: (s: DrillHubState<Drill, UserDrill>) => states.push(s) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// R1: readDrillHub returns { result, settled }; these classification tests look at the result.
const hub = <D, P>(make: Parameters<typeof readDrillHub<D, P>>[0]) => readDrillHub<D, P>(make).result;
// R1: a loader read returns { result, settled }; a plain promise is both.
const asRead = (p: Promise<DrillHubResult<Drill, UserDrill>>): DrillHubRead<Drill, UserDrill> => ({ result: p, settled: p.then(() => undefined, () => undefined) });

describe("readDrillHub — classification of the two reads", () => {
  it("both reads succeed: ready with the catalog and the progress", async () => {
    await expect(hub(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }))).resolves.toEqual({
      phase: "ready", drills: DRILLS, progress: PROGRESS,
    });
  });

  it("a genuinely empty catalog with successful progress is ready and empty (not an error)", async () => {
    await expect(hub(() => ({ catalog: ok<Drill>([]), progress: ok<UserDrill>([]) }))).resolves.toEqual({
      phase: "ready", drills: [], progress: [],
    });
  });

  it("successful catalog with no progress rows yet is ready (every drill genuinely not started)", async () => {
    await expect(hub(() => ({ catalog: ok(DRILLS), progress: ok<UserDrill>([]) }))).resolves.toEqual({
      phase: "ready", drills: DRILLS, progress: [],
    });
  });

  it("catalog returns an error: unavailable", async () => {
    await expect(hub(() => ({ catalog: failed<Drill>(), progress: ok(PROGRESS) }))).resolves.toEqual({ phase: "unavailable" });
  });

  it("progress returns an error: unavailable — never ready with empty progress (which would read as all pending, 0 verified)", async () => {
    const result = await hub(() => ({ catalog: ok(DRILLS), progress: failed<UserDrill>() }));
    expect(result).toEqual({ phase: "unavailable" });
    expect(result).not.toHaveProperty("drills");
    expect(result).not.toHaveProperty("progress");
  });

  it("both reads return errors: unavailable", async () => {
    await expect(hub(() => ({ catalog: failed<Drill>(), progress: failed<UserDrill>() }))).resolves.toEqual({ phase: "unavailable" });
  });

  it("a rejected catalog or progress promise is unavailable and does not reject", async () => {
    await expect(hub(() => ({ catalog: () => Promise.reject(new Error("TypeError: Failed to fetch")), progress: ok(PROGRESS) })))
      .resolves.toEqual({ phase: "unavailable" });
    await expect(hub(() => ({ catalog: ok(DRILLS), progress: () => Promise.reject(new Error("socket hang up")) })))
      .resolves.toEqual({ phase: "unavailable" });
  });

  it("a read function that throws synchronously is unavailable", async () => {
    await expect(hub(() => ({ catalog: () => { throw new Error("bad query"); }, progress: ok(PROGRESS) })))
      .resolves.toEqual({ phase: "unavailable" });
  });

  it("client construction (or a missing session) that throws is unavailable, and does not reject", async () => {
    const makeReads = vi.fn((): never => { throw new Error("supabaseUrl is required."); });
    await expect(hub<Drill, UserDrill>(makeReads)).resolves.toEqual({ phase: "unavailable" });
    expect(makeReads).toHaveBeenCalledTimes(1);
  });

  it("null data without an error is unavailable, not an empty catalog", async () => {
    await expect(hub(() => ({ catalog: () => Promise.resolve({ data: null, error: null }), progress: ok(PROGRESS) })))
      .resolves.toEqual({ phase: "unavailable" });
  });

  it("no error text from either read reaches the result", async () => {
    const result = await hub(() => ({ catalog: failed<Drill>(), progress: () => Promise.reject(new Error("JWT 7f3c")) }));
    expect(JSON.stringify(result)).not.toMatch(/relation|permission|JWT|7f3c|42501|fetch/i);
  });
});

describe("createDrillHubLoader — one finite load at a time", () => {
  it("publishes loading, then exactly one ready result", async () => {
    const { states, publish } = recorder();
    const loader = createDrillHubLoader((signal) => readDrillHub(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }), signal), publish);
    expect(loader.load()).toBe(true);
    expect(states).toEqual([{ phase: "loading" }]);
    await flush();
    expect(states).toEqual([{ phase: "loading" }, { phase: "ready", drills: DRILLS, progress: PROGRESS }]);
  });

  it("a thrown or rejected read ends in a finite unavailable state (no permanent loading, no unhandled rejection)", async () => {
    for (const read of [
      () => { throw new Error("sync"); },
      () => ({ result: Promise.reject(new Error("async")), settled: Promise.resolve() }),
    ] as (() => DrillHubRead<Drill, UserDrill>)[]) {
      const { states, publish } = recorder();
      const loader = createDrillHubLoader(read, publish);
      loader.load();
      await flush();
      expect(states).toEqual([{ phase: "loading" }, { phase: "unavailable" }]);
      expect(loader.load()).toBe(true); // not stuck pending
    }
  });

  it("Try again after a failure clears the error (publishes loading) and recovers to ready", async () => {
    const { states, publish } = recorder();
    let attempt = 0;
    const loader = createDrillHubLoader((signal) => {
      attempt++;
      return readDrillHub(() => ({ catalog: ok(DRILLS), progress: attempt === 1 ? failed<UserDrill>() : ok(PROGRESS) }), signal);
    }, publish);
    loader.load();
    await flush();
    expect(states.at(-1)).toEqual({ phase: "unavailable" });
    expect(loader.load()).toBe(true);
    expect(states.at(-1)).toEqual({ phase: "loading" });
    await flush();
    expect(states).toEqual([
      { phase: "loading" }, { phase: "unavailable" },
      { phase: "loading" }, { phase: "ready", drills: DRILLS, progress: PROGRESS },
    ]);
  });

  it("repeated Try again while a load is pending does not stack reads", async () => {
    const { states, publish } = recorder();
    const gate = deferred<DrillHubResult<Drill, UserDrill>>();
    const read = vi.fn(() => asRead(gate.promise));
    const loader = createDrillHubLoader(read, publish);
    expect(loader.load()).toBe(true);
    expect(loader.load()).toBe(false);
    expect(loader.load()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ phase: "loading" }]);
    gate.resolve({ phase: "unavailable" });
    await flush();
    expect(states).toEqual([{ phase: "loading" }, { phase: "unavailable" }]);
    expect(loader.load()).toBe(true); // allowed again once settled
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a completion after dispose (unmount) is dropped, and a disposed loader starts nothing", async () => {
    const { states, publish } = recorder();
    const gate = deferred<DrillHubResult<Drill, UserDrill>>();
    const read = vi.fn(() => asRead(gate.promise));
    const loader = createDrillHubLoader(read, publish);
    loader.load();
    loader.dispose();
    gate.resolve({ phase: "ready", drills: DRILLS, progress: PROGRESS });
    await flush();
    expect(states).toEqual([{ phase: "loading" }]);
    expect(loader.load()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a stale load from a disposed mount cannot replace the newer mount's state (React StrictMode remount)", async () => {
    const { states, publish } = recorder(); // one page state, two mounts
    const first = deferred<DrillHubResult<Drill, UserDrill>>();
    const second = deferred<DrillHubResult<Drill, UserDrill>>();
    const mount1 = createDrillHubLoader(() => asRead(first.promise), publish);
    mount1.load();
    mount1.dispose();
    const mount2 = createDrillHubLoader(() => asRead(second.promise), publish);
    mount2.load();
    second.resolve({ phase: "ready", drills: DRILLS, progress: PROGRESS });
    await flush();
    first.resolve({ phase: "unavailable" }); // the older, slower load finishes last
    await flush();
    expect(states.at(-1)).toEqual({ phase: "ready", drills: DRILLS, progress: PROGRESS });
    expect(states.filter((s) => s.phase === "unavailable")).toHaveLength(0);
  });

  it("the loader invokes only the read it was given, once per load, with that load's own cancellation signal", async () => {
    const read = vi.fn((signal: AbortSignal) => readDrillHub(() => ({ catalog: ok(DRILLS), progress: ok(PROGRESS) }), signal));
    const loader = createDrillHubLoader(read, () => {});
    loader.load();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toHaveLength(1);
    expect(read.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(read.mock.calls[0][0].aborted).toBe(false);
  });
});

describe("Drill Hub page wiring", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const page = readFileSync(path.join(ROOT, "app/(dashboard)/drills/page.tsx"), "utf8");

  it("first paint is a finite loading status with no counts, statuses or empty-state claim", () => {
    const html = renderToStaticMarkup(React.createElement(DrillsPage));
    const text = html.replace(/<[^>]+>/g, " ");
    expect(html).toContain('role="status"');
    expect(text).toContain("Loading drills…");
    expect(text).not.toMatch(/\d+\/\d+|Pending|Needs Work|Submitted|to fix|No Drills Available Yet|Try again|didn.t load/);
    // "Verified" appears only in the static subtitle "Practice · Submit · Get Verified", never as a status
    expect(text.match(/Verified/g)).toEqual(["Verified"]);
    expect(text).toContain("Get Verified");
  });

  it("the page loads through the helper with the unchanged queries and shows no raw error text", () => {
    // AG-WEB-READY-01-R1: the unchanged single-flight loader and readDrillHub, wrapped by lib/drill-hub-session.ts
    // createDrillHubSessionLoader (which also says whose drills a result is, and why a load ended)
    expect(page).toContain("createDrillHubSessionLoader<Drill, UserDrill>(");
    expect(page).not.toMatch(/createDrillHubLoader<|readDrillHub\(/);
    expect(page).toContain('cancellable(supabase.from("drills").select("id, name, target_metric, the_why, the_how, the_feel").eq("drill_family", "full_swing").order("name"), readSignal)');
    expect(page).toContain('cancellable(supabase.from("user_drills").select("drill_id, status, latest_ai_feedback"), readSignal)');
    expect(page).toContain("return query.abortSignal(signal);");
    // a refused Try again (abandoned-read bound) is announced rather than silently ignored
    expect(page).toContain("setRetryRefused(!started && hubPhase === \"unavailable\");");
    expect(page).toContain("DRILL_HUB_UNAVAILABLE_COPY.stillFinishing");
    expect(page).not.toMatch(/fetchError|drillsRes\.error\.message|Promise\.all/);
    expect(page).toContain("DRILL_HUB_UNAVAILABLE_COPY");
    expect(page).toContain("loader.dispose()");
    // AG-WEB-READY-01: a progress read without a usable session would be anonymous (zero rows = all "pending"). Both
    // reads wait for one session from the shared browser client and carry exactly its access token; the page reads no
    // cookie itself (the SDK owns whole and chunked session cookies).
    expect(page).toContain("const loader = createDrillHubSessionLoader<Drill, UserDrill>(");
    expect(page).toMatch(/currentSession,\n\s+\(session, readSignal\) => \{\n\s+const supabase = clientForSession\(session\);/);
    // A1 review (QA I5): each acquisition's outcome is also reported to the mounted page, so a read refused as unconfirmed
    // (the browser could not confirm its sign-in) adds the "sign in again" guidance; the acquisition itself is unchanged
    expect(page).toContain("return acquireDrillHubSession(sharedClient).then((result) => {\n    noteAcquisition?.(result);\n    return result;\n  });");
    expect(page).toContain('noteAcquisition = (result) => setUnconfirmed(result.status === "unavailable" && result.unconfirmed === true);');
    expect(page).toMatch(/\{unconfirmed && \(\n\s+<p [^>]*>\n\s+\{DRILL_HUB_UNCONFIRMED_COPY\.body\}\{" "\}\n\s+<Link\n\s+href="\/login"\n\s+prefetch=\{false\}\n\s+className="inline-flex items-center min-h-11 min-w-11 /);
    expect(page).toContain("function sharedClient() {\n  return createSharedBrowserClient();\n}");
    expect(page).toContain('import { createClient as createSharedBrowserClient } from "@/utils/supabase/client";');
    expect(page).not.toMatch(/document\.cookie|getSessionFromCookie|auth-token|JSON\.parse|decodeURIComponent/);
    // the shared client is used for the session and its events only; every read and the upload use the session-bound
    // client (lib/drill-hub-session.ts clientForDrillHubSession: that token only, no anonymous fallback, no Auth client)
    expect(page.split("createSharedBrowserClient()").length - 1).toBe(1);
    expect(page.split("sharedClient()").length - 1).toBe(2); // the definition and the event subscription
    expect(page).not.toContain('from "@supabase/supabase-js"');
    expect(page).toContain("return clientForDrillHubSession(session, process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);");
    expect(page.split("const supabase = clientForSession(session);").length - 1).toBe(2);
    expect(page.split("supabase.").length - 1).toBe(3); // the two reads and the upload, all on that client
    // the golfer the shown progress belongs to comes from the first ready result, and is never replaced
    // ...or, before anything is shown, the golfer last seen in the shared client's events or session checks
    expect(page).toContain("() => hubUserRef.current ?? seenUserRef.current,");
    expect(page.split("hubUserRef.current = ").length - 1).toBe(1);
    expect(page).toContain("hubUserRef.current = state.userId;");
  });

  it("R1: a sign-out or account change clears the golfer's drills, progress and verdicts at once, and nothing restores them", () => {
    const end = page.slice(page.indexOf("const endIdentity = useCallback("), page.indexOf("// ── Fetch data on mount"));
    expect(end.length).toBeGreaterThan(0);
    for (const step of ["if (identityEndRef.current !== null) return;", "identityEndRef.current = end;", "hubLoaderRef.current?.dispose();",
      "setDrills([]);", "setUserDrills([]);", "setSelectedId(null);", "setVideoFile(null);", "setVerifyResult(null);", "setVerifyError(null);",
      "setHubPhase(end);"]) {
      expect(end).toContain(step);
    }
    // the loader's own results: a signed-out or changed-account load ends the hub; an ended hub publishes nothing
    expect(page).toContain("if (identityEndRef.current !== null) return; // an ended hub's loader is disposed; never restore anything");
    expect(page).toContain('if (state.phase === "signed_out" || state.phase === "account_changed") {\n          endIdentity(state.phase);');
    // a sign-out or account change made elsewhere: shared-client events, and a fresh session read on return to the tab
    const watch = page.slice(page.indexOf("// ── Notice a sign-out or account change made elsewhere"), page.indexOf("// After a successful retry"));
    expect(watch).toContain("sharedClient().auth.onAuthStateChange((event, session) => {");
    expect(watch).toContain("const end = drillHubIdentityEndFromEvent(hubUserRef.current ?? seenUserRef.current, event, session);");
    expect(watch).toContain("const end = drillHubIdentityEnd(hubUserRef.current ?? seenUserRef.current, observed);");
    // the golfer last seen is recorded only when nothing ended (a first load still in flight then meets it)
    expect(watch).toContain("const seen = drillHubSessionUserId(session);\n        if (seen !== null) seenUserRef.current = seen;");
    expect(watch).toContain('else if (observed.status === "ready") seenUserRef.current = observed.session.userId;');
    expect(page.split("seenUserRef.current = ").length - 1).toBe(2);
    for (const listener of ['document.addEventListener("visibilitychange", onVisible);', 'window.addEventListener("focus", check);', 'window.addEventListener("pageshow", onPageShow);',
      "unsubscribe();", 'document.removeEventListener("visibilitychange", onVisible);', 'window.removeEventListener("focus", check);', 'window.removeEventListener("pageshow", onPageShow);']) {
      expect(watch).toContain(listener);
    }
    // signed out and changed account have their own panels and actions, never Try again
    expect(page).toContain('{(hubPhase === "signed_out" || hubPhase === "account_changed") && (');
    expect(page).toContain("DRILL_HUB_IDENTITY_COPY[hubPhase].title");
    expect(page).toContain('href="/login"');
    expect(page).toContain("onClick={() => window.location.reload()}");
    expect(page).toContain("{notSent && <p");
    const panel = page.slice(page.indexOf('{(hubPhase === "signed_out" || hubPhase === "account_changed") && ('), page.indexOf("{/* Empty state"));
    expect(panel).not.toContain("handleRetryLoad");
    expect(panel.split("min-h-11 min-w-11").length - 1).toBe(2);
    // focus that went with the removed controls lands on the panel's own heading, with a visible ring
    expect(panel).toContain('<h2 ref={endHeadingRef} tabIndex={-1} className="text-sm font-black text-white rounded focus:outline focus:outline-2');
    expect(page).toContain('if (hubPhase === "signed_out" || hubPhase === "account_changed") endHeadingRef.current?.focus();');
    // the watcher's listeners are removed in its cleanup
    const cleanup = watch.slice(watch.indexOf("return () => {"));
    for (const off of ["unsubscribe();", 'document.removeEventListener("visibilitychange", onVisible);', 'window.removeEventListener("focus", check);', 'window.removeEventListener("pageshow", onPageShow);']) {
      expect(cleanup).toContain(off);
    }
  });

  it("R1: the video picker is reachable by keyboard and the remaining controls are at least 44 px tall", () => {
    // visually hidden, not display:none: Tab reaches it and Space/Enter opens the picker; the drop zone shows its focus
    expect(page).toContain('className="peer sr-only"');
    expect(page).not.toMatch(/type="file"[\s\S]{0,120}className="hidden"/);
    expect(page.indexOf('id="drill-video"')).toBeLessThan(page.indexOf('htmlFor="drill-video"'));
    expect(page).toContain("peer-focus-visible:outline peer-focus-visible:outline-2");
    // "Submit Another Attempt" (was about 15 px tall) and its focus goes to the picker when it disappears
    const start = page.indexOf("{!verifyResult.pass && (");
    const again = page.slice(start, page.indexOf("Submit Another Attempt\n", start) + 30);
    expect(start).toBeGreaterThan(-1);
    expect(again.length).toBeGreaterThan(100);
    expect(again).toContain("min-h-11");
    expect(again).toContain("focusPickerRef.current = true;");
    // focus moves after the re-render, so the picker is announced with its fresh label
    expect(page).toContain("if (focusPickerRef.current && !verifyResult && !videoFile) {\n      focusPickerRef.current = false;\n      fileInputRef.current?.focus();");
    expect(page).toContain("w-full min-h-11 flex items-center justify-center gap-2 px-6 py-3"); // Verify
  });

  it("the verification entry takes its session from the shared client and shows only fixed messages", () => {
    const verify = page.slice(page.indexOf("async function handleVerify()"), page.indexOf("const selectedDrill ="));
    expect(verify.length).toBeGreaterThan(0);
    // the session is acquired before anything is uploaded; a missing or unusable one is refused with fixed copy
    expect(verify.indexOf("await currentSession()")).toBeGreaterThan(-1);
    expect(verify.indexOf("await currentSession()")).toBeLessThan(verify.indexOf(".upload(storagePath"));
    // R1: signed out at submission ends the hub (cleared, "not sent"); an unconfirmed sign-in is a fixed message
    expect(verify).toContain('if (acquired.status === "signed_out") {\n        endIdentity("signed_out", true);\n        return;');
    expect(verify).toContain('show("sessionUnavailable");');
    // a session that now belongs to another golfer than the one whose progress is shown ends the hub before the upload
    expect(verify).toContain('if (session.userId !== hubUserRef.current) {\n        endIdentity("account_changed", true);\n        return;');
    expect(verify.indexOf("hubUserRef.current")).toBeLessThan(verify.indexOf(".upload(storagePath"));
    // R1 late results: after every await, nothing shows once the hub has ended
    // (ended while the sign-in was being checked: nothing was sent, and the panel says so)
    expect(verify).toContain("const acquired = await currentSession();\n      // The hub ended while the sign-in was being checked: nothing was sent, and the panel says so.\n      if (identityEndRef.current !== null) {\n        setNotSent(true);\n        return;\n      }");
    // every await in the submission is followed by the end check: session, upload, the answer's body, the re-check
    expect(verify.split("await ").length - 1).toBe(5);
    expect(verify.split("if (identityEndRef.current !== null)").length - 1).toBe(4);
    // a 401/403 from the endpoint re-checks the session and ends the hub if the sign-in changed
    expect(verify).toContain("if (res.status === 401 || res.status === 403) {\n          const again = await currentSession();\n          if (identityEndRef.current !== null) return;\n          const end = drillHubIdentityEnd(hubUserRef.current, again);\n          if (end !== null) {\n            endIdentity(end);");
    // a hub that ended during the upload sends no verification request
    const afterUpload = "// The hub ended during the upload: send no verification request.\n      if (identityEndRef.current !== null) return;";
    expect(verify).toContain(afterUpload);
    expect(verify.indexOf(afterUpload)).toBeGreaterThan(verify.indexOf(".upload(storagePath"));
    expect(verify.indexOf(afterUpload)).toBeLessThan(verify.indexOf('await fetch("/api/verify-drill"'));
    expect(verify).toContain("// A verdict that arrives after the hub ended restores nothing: no verdict, no badge.\n      if (identityEndRef.current !== null) return;\n      if (selectedIdRef.current === drillId) setVerifyResult(result);");
    expect(verify.indexOf("if (identityEndRef.current !== null) return;\n      if (selectedIdRef.current === drillId) setVerifyResult(result);")).toBeLessThan(verify.indexOf("setUserDrills((prev)"));
    expect(verify).toContain("if (identityEndRef.current === null && selectedIdRef.current === drillId) setVerifyError(DRILL_VERIFY_COPY[message]);");
    expect(verify).toContain("if (verifyingRef.current || identityEndRef.current !== null) return;");
    // the existing endpoint payload and canonical upload path, with the id the session states (the server re-checks it)
    expect(verify).toContain("const storagePath  = `${session.userId}/${Date.now()}_${safeFilename}`;");
    expect(verify).toContain("body: JSON.stringify({ drillId, userId: session.userId, videoStoragePath: storagePath }),");
    expect(verify).toContain("const drillId = selectedId;");
    // no Storage, server or exception text reaches the golfer; the size limit has its own fixed message
    expect(verify).not.toMatch(/uploadErr\.message|data\.error|err\.message|res\.status\}/);
    expect(verify).toContain("readDrillVerifyResult(data)");
    // R1 refusal guidance: classified from numbers only (lib/drill-hub-session.ts drillUploadRefusal / drillVerifyRefusal)
    expect(verify).toContain("show(drillUploadRefusal(uploadErr));");
    expect(verify).toContain("show(drillVerifyRefusal(res.ok ? null : res.status));");
    expect(verify).toContain('show(step === "session" ? "sessionUnavailable" : step === "upload" ? "uploadFailed" : drillVerifyRefusal(null));');
    expect(verify).not.toMatch(/DRILL_VERIFY_COPY\.checkFailed|show\(res\.status/);
    // outcomes appear only under the drill that was submitted
    expect(verify).toContain("if (selectedIdRef.current === drillId) setVerifyResult(result);");
    // one submission at a time, decided synchronously, and released however the submission ends
    expect(verify).toContain("if (verifyingRef.current || identityEndRef.current !== null) return;\n    verifyingRef.current = true;");
    expect(verify).toMatch(/finally \{\n\s+verifyingRef\.current = false;/);
    // the outcome is announced
    expect(page).toContain('<div role="alert" className="mt-3 flex items-center gap-2');
    expect(page).toContain('<div role="status" className={`rounded-4xl border p-6');
  });

  it("the golfer-facing failure copy is plain language with no technical detail", () => {
    for (const text of [...Object.values(DRILL_HUB_UNAVAILABLE_COPY), ...Object.values(DRILL_HUB_UNCONFIRMED_COPY)]) {
      expect(text).not.toMatch(/error|sql|supabase|jwt|token|exception|status code|\d{3}/i);
    }
  });
});
