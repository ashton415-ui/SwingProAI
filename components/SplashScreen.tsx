"use client";

import { useEffect, useRef, useState } from "react";

// The optional branded intro on the landing page.
// - Never rendered by the server or before hydration, so without JavaScript the landing shows as it is.
// - At most once per tab session: one namespaced session-storage flag with a constant value. The intro is skipped, and
//   the landing shown straight away, when reduced motion or reduced data use is requested, session storage is
//   unavailable or throws, the browser has no modal dialog, the page took more than a second to become interactive, or
//   someone has already started using the page (a tap, click or key press, focus moved, or the page scrolled). The same
//   checks run again, without touching storage, right before the dialog opens; if anything changed in between, the
//   intro is given up and the page is left exactly as it is (it still counts as this tab session's intro).
// - A native modal dialog: the page behind it cannot take focus, focus starts on the named Skip intro button and Escape
//   closes it. Whatever ends it, focus goes back to where it was before the intro (the start of the page), so a
//   repeated or held key can never activate anything on the landing. The whole intro, fades included, ends within two
//   seconds of first appearing. The video ending, a video error or blocked autoplay end it sooner, and so does a switch
//   to reduced motion while it is open.
const SEEN_KEY = "swingproai:intro-seen";
const SEEN = "1";
const MAX_MS = 2000;
const FADE_MS = 300;
const START_BUDGET_MS = 1000;
const REDUCE = "(prefers-reduced-motion: reduce)";

type BrowserHints = Navigator & { userActivation?: { hasBeenActive?: boolean }; connection?: { saveData?: boolean } };

// Read-only: is the page still untouched and is an intro still welcome? (Callers catch anything it throws.)
function introReady(): boolean {
  if (typeof window.matchMedia !== "function" || window.matchMedia(REDUCE).matches) return false;
  if (typeof HTMLDialogElement !== "function" || typeof HTMLDialogElement.prototype.showModal !== "function") return false;
  if (window.performance.now() > START_BUDGET_MS) return false;
  const hints = window.navigator as BrowserHints;
  if (hints.userActivation?.hasBeenActive || hints.connection?.saveData) return false;
  const active = document.activeElement;
  return !((active && active !== document.body) || window.scrollY > 0);
}

function introWanted(): boolean {
  try {
    if (!introReady()) return false;
    const store = window.sessionStorage;
    if (store.getItem(SEEN_KEY) === SEEN) return false;
    store.setItem(SEEN_KEY, SEEN);
    return true;
  } catch {
    return false;
  }
}

export default function SplashScreen() {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [fading, setFading] = useState(false);
  const decided = useRef<boolean | null>(null);
  const openedAt = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const endRef = useRef<() => void>(() => {});

  // Decide once, after hydration. The ref means an effect replay (development StrictMode, Fast Refresh) neither reads
  // storage again nor, once the intro has ended, opens it again.
  useEffect(() => {
    if (decided.current === null) decided.current = introWanted();
    if (decided.current) setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const video = videoRef.current;
    const motion = window.matchMedia(REDUCE);
    let over = false;
    let fadeStart: ReturnType<typeof setTimeout> | undefined;
    let cap: ReturnType<typeof setTimeout> | undefined;
    let fadeEnd: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      over = true;
      clearTimeout(fadeStart);
      clearTimeout(cap);
      clearTimeout(fadeEnd);
      motion.removeEventListener("change", onMotion);
      dialog.removeEventListener("close", onClose);
      video?.removeEventListener("ended", onEnded);
      video?.removeEventListener("error", onError);
      endRef.current = () => {};
    };
    // Ends the intro once, whatever ends it first.
    const end = () => {
      if (over) return;
      stop();
      decided.current = false;
      if (dialog.open) dialog.close(); // focus goes back to where it was before the intro
      setOpen(false);
      setShown(false);
      setFading(false);
    };
    const fadeOut = () => {
      if (over || fadeEnd !== undefined) return;
      setFading(true);
      fadeEnd = setTimeout(end, FADE_MS);
    };
    function onEnded() {
      fadeOut();
    }
    function onError() {
      end();
    }
    function onMotion() {
      if (motion.matches) end();
    }
    // Escape, or the platform's back gesture, closed the dialog natively.
    function onClose() {
      if (!dialog?.open) end();
    }

    try {
      // Admission: the decision was made a render ago, and the golfer or the system may have acted since. Only a dialog
      // that is not open is checked, so an effect replay while it is open never takes Skip intro's focus for use of the
      // page; one that has already appeared and is closed again (Escape racing an effect replay) is never reopened.
      // Given up here: no modal, no focus move, no playback.
      if (!dialog.open && (openedAt.current !== null || !introReady())) {
        end();
        return stop;
      }
      // the two-second bound counts from the intro's first appearance, also across an effect replay
      const now = window.performance.now();
      if (openedAt.current === null) openedAt.current = now;
      const left = Math.max(0, MAX_MS - (now - openedAt.current));
      endRef.current = end;
      fadeStart = setTimeout(fadeOut, Math.max(0, left - FADE_MS));
      cap = setTimeout(end, left);
      motion.addEventListener("change", onMotion);
      dialog.addEventListener("close", onClose);
      if (!dialog.open) dialog.showModal();
      skipRef.current?.focus();
      setShown(true);
      if (video) {
        video.addEventListener("ended", onEnded);
        video.addEventListener("error", onError);
        if (video.error) {
          end();
          return stop;
        }
        const playing = video.play();
        if (playing && typeof playing.catch === "function") playing.catch(end);
      }
    } catch {
      end();
    }
    return stop;
  }, [open]);

  if (!open) return null;

  const LOGO =
    "h-[min(18rem,60vw,calc(100vh_-_14rem))] w-[min(18rem,60vw,calc(100vh_-_14rem))] supports-[height:100dvh]:h-[min(18rem,60vw,calc(100dvh_-_14rem))] supports-[height:100dvh]:w-[min(18rem,60vw,calc(100dvh_-_14rem))]";

  return (
    <dialog
      ref={dialogRef}
      aria-label="SwingProAI intro"
      className={`fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-y-auto overscroll-contain border-0 bg-golf-dark p-0 text-white backdrop:bg-transparent transition-opacity ease-out motion-reduce:transition-none ${
        fading ? "opacity-0 duration-300" : shown ? "opacity-100 duration-200" : "opacity-0 duration-200"
      }`}
    >
      {/* Subtle grid */}
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:40px_40px]" />

      <div className="relative flex min-h-full flex-col items-center justify-center gap-4 px-4 py-6">
        {/* Animated logo video (decorative); the existing logo image shows until its first frame */}
        <div className={`${LOGO} shrink-0 overflow-hidden rounded-[3rem] border border-golf-green/20 shadow-[0_0_80px_rgba(74,222,128,0.2)]`}>
          <video
            ref={videoRef}
            src="/logo-animation.mp4"
            poster="/swingproai_logo.png"
            muted
            playsInline
            preload="auto"
            aria-hidden="true"
            className="h-full w-full object-cover"
          />
        </div>

        {/* Wordmark (the dialog's own name says it) */}
        <div aria-hidden="true" className="text-center">
          <p className="text-3xl sm:text-4xl font-black italic tracking-tighter text-white uppercase">
            Swing<span className="text-golf-green">Pro</span>AI
          </p>
          <p className="mt-1 text-xs font-bold uppercase tracking-[0.3em] text-gray-400">
            Golf Swing Analyzer
          </p>
        </div>

        <button
          ref={skipRef}
          type="button"
          onClick={() => endRef.current()}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-white/50 px-5 text-sm font-bold text-white hover:bg-white/10 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-golf-green"
        >
          Skip intro
        </button>
      </div>
    </dialog>
  );
}
