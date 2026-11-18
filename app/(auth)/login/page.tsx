"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import Link from "next/link";
import { Zap } from "lucide-react";

// Shown for every returned sign-in failure. It never repeats provider text and never says whether an account exists.
const SIGN_IN_FAILED = "We couldn't sign you in. Check your email and password, or try again in a moment.";
// Shown when the attempt could not be completed or its result is unknown: the client could not be created, or the
// sign-in call threw or gave no usable answer. Fixed text, never provider text, never says whether an account exists.
const SIGN_IN_INTERRUPTED = "We couldn't finish signing you in. Please try again in a moment.";
// Shown until the page's own sign-in handler is ready (scripts still loading, failed, or turned off). Until then the
// form cannot be submitted, so the fields are never sent anywhere by the browser itself.
const SIGN_IN_NOT_READY = "Sign-in needs JavaScript. If the button stays unavailable, check that JavaScript is on and reload this page.";

const FIELD =
  "w-full px-4 py-3.5 bg-black/40 border border-gray-500 rounded-2xl text-white text-base placeholder:text-gray-400 focus:outline-none focus:border-golf-green focus:ring-2 focus:ring-golf-green";
const LABEL = "block text-xs font-black uppercase tracking-widest text-gray-300 mb-2";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  // Set synchronously on submit, before React has re-rendered the disabled button, so a second submit in that moment
  // (a fast double press or Enter) starts no second request. Client-side only: other tabs, devices and scripted
  // clients are not deduplicated.
  const inFlight = useRef(false);
  // False in the server-rendered page and until React has attached the submit handler on this page; the submit button
  // stays disabled until then, so neither a press nor Enter can make the browser submit the form natively.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);

  // Disabling the focused submit button drops focus to the page; when a failure is shown, put it on the message.
  useEffect(() => {
    if (!error) return;
    const active = document.activeElement;
    if (!active || active === document.body) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return; // an attempt is already running
    inFlight.current = true;
    setLoading(true);
    setError(null);

    const form = e.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;

    // Ends this attempt with a fixed message: the button works again and the entered values stay in the form.
    const stop = (message: string) => {
      setError(message);
      setLoading(false);
      inFlight.current = false;
    };

    // Sign in with the browser client. When it returns a session, the installed client has already kept that session in
    // its own cookie (inherited and unchanged here: readable by page scripts and sent with this site's requests), and
    // pages that need a signed-in golfer verify it on the server. So the page makes no further request with the session
    // itself and goes straight to the dashboard.
    try {
      const supabase = createClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError || !data?.session) {
        stop(SIGN_IN_FAILED);
        return;
      }
    } catch {
      // the client could not be created, or the sign-in call threw or gave no usable answer: the attempt did not complete
      stop(SIGN_IN_INTERRUPTED);
      return;
    }

    window.location.href = "/dashboard";
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
            Sign in
          </h1>
        </div>

        <div className="bg-golf-surface border border-white/5 rounded-5xl p-6 sm:p-8">
          {/* method="post": should the form ever be submitted natively, the fields go in the request body, never a URL */}
          <form method="post" onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="login-email" className={LABEL}>
                Email address
              </label>
              <input
                id="login-email"
                type="email"
                name="email"
                required
                autoComplete="username"
                className={FIELD}
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label htmlFor="login-password" className={LABEL}>
                Password
              </label>
              <input
                id="login-password"
                type="password"
                name="password"
                required
                autoComplete="current-password"
                className={FIELD}
              />
            </div>

            {error && (
              <div
                ref={errorRef}
                id="login-error"
                role="alert"
                tabIndex={-1}
                className="text-red-300 text-sm font-bold bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-red-300"
              >
                {error}
              </div>
            )}

            <p role="status" className="sr-only">
              {loading ? "Signing in…" : ""}
            </p>

            <button
              type="submit"
              disabled={loading || !ready}
              aria-busy={loading}
              aria-describedby={ready ? undefined : "login-readiness"}
              className="w-full min-h-11 py-4 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] disabled:opacity-60 transition-all text-sm shadow-[0_0_20px_rgba(74,222,128,0.15)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>

            {!ready && (
              <p id="login-readiness" className="text-sm text-gray-300">
                {SIGN_IN_NOT_READY}
              </p>
            )}
          </form>

          <div className="mt-6 pt-6 border-t border-white/10 text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
              No account?{" "}
              <Link
                href="/signup"
                className="inline-flex items-center justify-center min-h-11 min-w-11 px-2 rounded-lg text-golf-green underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-golf-green"
              >
                Create an account
              </Link>
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 mt-6">
          <Zap aria-hidden="true" size={12} className="text-golf-green" fill="currentColor" />
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">
            AI-Integrated Swing Analysis
          </p>
        </div>
      </main>
    </div>
  );
}
