"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SIGN_OUT } from "@/components/navigation/dashboard-navigation";
import { endSessionInBrowser, type EndOutcome } from "@/utils/supabase/session-publication";

/**
 * The End Session control (desktop sidebar and phone/tablet drawer). A POST form to SIGN_OUT.href in every state.
 *
 * The form names the account the page was rendered for (`expected_user`) and that render's session LINEAGE
 * (`expected_session`: a digest of the Auth session id, never a token; utils/supabase/session-cookie-layout.ts). A
 * session of any other lineage — another account's, or a newer sign-in of the same account — is never ended from here.
 *
 * Before this page's script runs (or without it) the browser posts it natively: the server revokes, at Auth, the
 * session the request carries (when it is that lineage) and never writes or removes a session cookie, so a response
 * that arrives after another tab signed in cannot touch that newer session (app/api/auth/signout/route.ts). It then
 * says honestly that the session was ended but that this browser's copy is still to be removed, and leaves a
 * single-use instruction naming only the ended lineage, which the sign-in page acts on once it has hydrated.
 *
 * Once the script runs, a press first ends the session in this browser under the session-publication lease
 * (utils/supabase/session-publication.ts) and waits for that to finish — every step is bounded — and only then posts,
 * telling the server which local outcome it reached (`end_state`, display only: it authorises nothing):
 * - "ended": revoked at Auth and removed here; the end section stays held until this page unloads, so the post arrives
 *   without a session cookie and only redirects to /login.
 * - "ended_unconfirmed": removed here, but Auth did not confirm the revocation; the server's answer says exactly that.
 * - "unavailable": the lease could not be held in time (its request is aborted, so it can never be granted later), or
 *   this tab's view of the session cookies was not the recorded one (another sign-in may not be visible here yet), and
 *   nothing here was changed; the post asks the server to revoke the session the request carries, which is safe for the
 *   same reason as above.
 * - "other_account": this browser now holds another sign-in, which is left alone; the page reloads.
 *
 * One press per page: the attempt is shared by every instance (desktop sidebar, phone/tablet drawer), so a drawer
 * re-opened while it runs mounts a form that shows the same progress and starts nothing more. The progress message is
 * visible as soon as the press is taken and sits in a live region that is always mounted (so assistive technology
 * announces it); the button stays focusable (aria-disabled) while the attempt runs.
 */
let attempt: Promise<EndOutcome> | null = null;
const watchers = new Set<(ending: boolean) => void>();

/** Starts this page's one End Session attempt; null when one is already running (its own press posts when it ends). */
function startEnding(expectedUserId: string, expectedSession: string | null): Promise<EndOutcome> | null {
  if (attempt !== null) return null;
  attempt = endSessionInBrowser(expectedUserId, undefined, expectedSession).catch((): EndOutcome => "unavailable"); // nothing ended here then
  watchers.forEach((watch) => watch(true));
  return attempt;
}

/** What the post tells the server about the local outcome (display only). */
function endState(outcome: EndOutcome): string {
  return outcome === "ended" || outcome === "ended_unconfirmed" ? outcome : "";
}

export default function EndSessionForm({
  expectedUserId,
  expectedSession,
  className,
  children,
}: {
  expectedUserId: string;
  expectedSession: string | null;
  className: string;
  children: ReactNode;
}) {
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    watchers.add(setEnding);
    setEnding(attempt !== null); // a form mounted while an attempt runs (a re-opened drawer) shows it
    return () => {
      watchers.delete(setEnding);
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const outcome = startEnding(expectedUserId, expectedSession); // synchronous: a second press or Enter in this moment starts nothing
    if (outcome === null) return;
    const result = await outcome;
    if (result === "other_account") {
      window.location.reload();
      return;
    }
    // The phone/tablet drawer may have closed (and removed this form) meanwhile: post a hidden copy instead.
    let target = form;
    if (!form.isConnected) {
      target = form.cloneNode(true) as HTMLFormElement;
      target.hidden = true;
      target.setAttribute("data-end-session-copy", "");
      document.body.appendChild(target);
    }
    const state = target.elements?.namedItem("end_state") as { value: string } | null | undefined;
    if (state && typeof state === "object" && "value" in state) state.value = endState(result);
    target.submit(); // submit() does not dispatch another submit event
  }

  return (
    <form action={SIGN_OUT.href} method="POST" onSubmit={handleSubmit}>
      <input type="hidden" name="expected_user" value={expectedUserId} />
      {expectedSession !== null && <input type="hidden" name="expected_session" value={expectedSession} />}
      <input type="hidden" name="end_state" defaultValue="" />
      <button type="submit" aria-disabled={ending} aria-busy={ending} className={`${className}${ending ? " opacity-60 cursor-wait" : ""}`}>
        {children}
      </button>
      <p role="status" aria-live="polite" className={ending ? "mt-2 px-2 text-xs text-gray-300" : "sr-only"}>
        {ending ? "Ending your session…" : ""}
      </p>
    </form>
  );
}
