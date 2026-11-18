"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { signupAction } from "./actions";
import Link from "next/link";
import { LogIn, UserPlus, Zap } from "lucide-react";

// Shown for every returned sign-up failure. It never repeats provider text and never says whether an account exists.
const SIGN_UP_FAILED =
  "We couldn't create your account. Check your details or try again in a moment. If you already have an account, sign in instead.";
// Shown when the request threw, was lost or came back with no usable answer, and when the action itself could not tell
// what happened. The account may or may not have been created, so the page does not say it was not.
const SIGN_UP_UNCONFIRMED =
  "We couldn't confirm whether your account was created. Check your email or try signing in before creating it again.";
// AG-AUTH-03: the one completion, the same for every answer the action recognizes (a new account with or without a
// session, the answer Auth can give for an address it already holds, and the recognized duplicate). It says neither that
// an account was created, nor that the golfer is signed in, nor that an email was sent.
const CONTINUE_HEADING = "Continue with your account";
const CONTINUE_BODY = "Sign in to continue. If email confirmation is required, check your inbox first.";

// Next.js control flow (a redirect or not-found) that reaches the client is left to the framework, never shown as a
// failure. Only Next's own shapes count: "NEXT_REDIRECT;<replace|push>;<url>;<status>;" and "NEXT_NOT_FOUND".
function isFrameworkSignal(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return false;
  if (digest === "NEXT_NOT_FOUND") return true;
  const [code, type, url, status] = digest.split(";");
  return code === "NEXT_REDIRECT" && (type === "replace" || type === "push") && !!url && /^30[378]$/.test(status ?? "");
}

const FIELD =
  "w-full px-4 py-3.5 bg-black/40 border border-gray-500 rounded-2xl text-white text-base placeholder:text-gray-400 focus:outline-none focus:border-golf-green focus:ring-2 focus:ring-golf-green transition-all";
const LABEL = "block text-xs font-black uppercase tracking-widest text-gray-300 mb-2";

export default function SignupPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // React's form status disables the button once it has rendered; a second submission before then (a fast double
  // press or Enter) is ignored here. Client-side only: other tabs, devices and scripted clients are not deduplicated.
  const inFlight = useRef(false);
  // AG-AUTH-03: the action's completion replaces the form with the fixed next step
  const [completed, setCompleted] = useState(false);

  async function handleSubmit(formData: FormData) {
    if (inFlight.current) return; // an attempt is already running
    inFlight.current = true;
    setLoading(true);
    setError(null);
    let result: Awaited<ReturnType<typeof signupAction>> | undefined;
    try {
      result = await signupAction(formData);
    } catch (error) {
      if (isFrameworkSignal(error)) throw error;
      result = undefined; // thrown or lost: the outcome is unknown
    }
    // Only the action's own fixed answers count. A definite failure is "failed"; anything else (no answer, one the page
    // cannot read, or the action's own "unconfirmed") is not definite.
    const outcome = result?.outcome;
    if (outcome === "continue") setCompleted(true);
    else setError(outcome === "failed" ? SIGN_UP_FAILED : SIGN_UP_UNCONFIRMED);
    setLoading(false);
    inFlight.current = false;
  }

  return (
    <div className="relative min-h-screen bg-golf-dark flex items-center justify-center px-4 py-10">
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:40px_40px]" />

      <main className="relative w-full max-w-md min-w-0">
        <div className="flex flex-col items-center mb-8">
          <div className="w-20 h-20 bg-golf-green/5 border border-golf-green/20 rounded-3xl overflow-hidden mb-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/swingproai_logo.png" alt="SwingProAI" className="w-full h-full object-contain p-1" />
          </div>
          <p aria-hidden="true" className="text-3xl font-black italic tracking-tighter text-white uppercase">
            SWING<span className="text-golf-green">PRO</span>AI
          </p>
          <h1 className="text-sm font-black uppercase tracking-[0.2em] text-gray-300 mt-2">
            Create your account
          </h1>
        </div>

        <div className="bg-golf-surface border border-white/5 rounded-5xl p-6 sm:p-8">
          {completed ? (
            <SignupContinue />
          ) : (
            <>
              <form action={handleSubmit} className="space-y-5">
                <div>
                  <label htmlFor="signup-name" className={LABEL}>
                    Full name
                  </label>
                  <input
                    id="signup-name"
                    type="text"
                    name="fullName"
                    required
                    autoComplete="name"
                    className={FIELD}
                  />
                </div>
                <div>
                  <label htmlFor="signup-email" className={LABEL}>
                    Email address
                  </label>
                  <input
                    id="signup-email"
                    type="email"
                    name="email"
                    required
                    autoComplete="email"
                    className={FIELD}
                    placeholder="you@example.com"
                  />
                </div>
                <div>
                  <label htmlFor="signup-password" className={LABEL}>
                    Password
                  </label>
                  <input
                    id="signup-password"
                    type="password"
                    name="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    aria-describedby="signup-password-hint"
                    className={FIELD}
                  />
                  <p id="signup-password-hint" className="mt-2 text-sm text-gray-400">
                    At least 8 characters.
                  </p>
                </div>

                <SignupSubmit error={error} loading={loading} />
              </form>

              <div className="mt-6 pt-6 border-t border-white/10 text-center">
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                  Already have an account?{" "}
                  <Link
                    href="/login"
                    className="inline-flex items-center justify-center min-h-11 min-w-11 px-2 rounded-lg text-golf-green underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-golf-green"
                  >
                    Sign in
                  </Link>
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-center gap-2 mt-6">
          <Zap aria-hidden="true" size={12} className="text-golf-green" fill="currentColor" />
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">
            Create your free SwingProAI account
          </p>
        </div>
      </main>
    </div>
  );
}

// What the golfer sees and hears while the request is in flight comes from React's form status: the `loading` update
// made inside the form action is held until the action finishes, so on its own it never shows. The button is disabled
// by that effective pending state, so a second press while the request is in flight submits nothing. A message from an
// earlier attempt is hidden while a new one is pending, so each outcome is announced again.
function SignupSubmit({ error, loading }: { error: string | null; loading: boolean }) {
  const { pending } = useFormStatus();
  const busy = loading || pending;
  return (
    <>
      {error && !busy && <SignupError message={error} />}

      <p role="status" className="sr-only">
        {busy ? "Creating account…" : ""}
      </p>

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="w-full min-h-11 py-4 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] disabled:opacity-60 transition-all flex items-center justify-center gap-2 text-sm shadow-[0_0_20px_rgba(74,222,128,0.15)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <UserPlus aria-hidden="true" size={16} />
        {busy ? "Creating account…" : "Create account"}
      </button>
    </>
  );
}

function SignupError({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // When a failure is shown and focus has fallen to the page (some browsers do not focus a pressed button), put it on
  // the message; focus that is still on a field or the button is left where it is.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      id="signup-error"
      role="alert"
      tabIndex={-1}
      className="text-red-300 text-sm font-bold bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-red-300"
    >
      {message}
    </div>
  );
}

// AG-AUTH-03: the fixed next step after a recognized answer. The form, and the button that had focus, are gone, so focus
// that has fallen to the page moves to the heading and the next step is read out; focus anywhere else is left there.
function SignupContinue() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus();
  }, []);
  return (
    <section aria-labelledby="signup-continue-heading" className="text-center">
      <h2
        ref={ref}
        id="signup-continue-heading"
        tabIndex={-1}
        className="text-xl font-black tracking-tight text-white rounded-lg focus:outline focus:outline-2 focus:outline-offset-4 focus:outline-golf-green"
      >
        {CONTINUE_HEADING}
      </h2>
      <p className="mt-3 text-sm text-gray-300">{CONTINUE_BODY}</p>
      <Link
        href="/login"
        className="mt-6 w-full min-h-11 py-4 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] transition-all flex items-center justify-center gap-2 text-sm shadow-[0_0_20px_rgba(74,222,128,0.15)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <LogIn aria-hidden="true" size={16} />
        Sign in
      </Link>
    </section>
  );
}
