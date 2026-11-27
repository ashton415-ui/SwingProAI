"use client";

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Upload, Target, CheckCircle2, AlertCircle, Loader2,
  Play, Info, Maximize2, X, Activity, Zap,
  Lock, BarChart2, FileUp, Camera, Square,
} from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { sessionUnverifiedReason } from "@/utils/supabase/session-storage";
import {
  sessionEndPending,
  watchLineageEnd,
  watchSessionEnd,
  type OwnerRefusal,
} from "@/utils/supabase/session-publication";
import { confirmOwnerSession, ownerBearer, ownerBoundClient } from "@/lib/drill-hub-session";
import { useRenderedSession } from "@/components/navigation/SessionKeeper";
import { CHECKOUT_AVAILABLE } from "@/lib/billing/checkout-availability";
import { ASSESSMENT_LABEL, SCORE_BASIS, UNSCORED_COPY, UNSCORED_LABEL } from "@/lib/swing-metric-presentation";
import {
  canonicalUploadFileName,
  MAX_ANALYSIS_VIDEO_BYTES,
  MIN_VIDEO_BYTES,
  VIDEO_UNUSABLE_STATUS,
} from "@/lib/swing-video-source";
import {
  canUseLaunchMonitor,
  canUsePuttingAnalysis,
  getAnalysisModeForTier,
  getTierDisplayName,
  getUpsellTier,
  type SubscriptionTier,
} from "@/lib/entitlements";
import ClubSelector from "@/components/equipment/ClubSelector";
import {
  querySavedClubs,
  type SavedClubsResult,
} from "@/lib/equipment/saved-clubs";
import {
  isPuttingCapturePresentation,
  isSelectionStillValid,
  resolveInitialClubId,
} from "@/lib/equipment/analyze-club-selection";
import {
  CAMERA_RECORDING_TOO_LARGE_MESSAGE,
  CAMERA_RECORDING_UNAVAILABLE_MESSAGE,
  CAMERA_UNSUPPORTED_MESSAGE,
  cameraFileExtensionForMime,
  classifyCameraStartError,
  hasCameraRecordingCapability,
  selectCameraRecorderMimeType,
} from "@/lib/analyze-camera-capture";
import type { DeficiencyItem, HighlightItem } from "@/types/database";
import {
  TUS_RESUMABLE_VERSION,
  UPLOAD_CHUNK_SIZE,
  buildResumableEndpoint,
  buildTusUploadMetadata,
  buildUploadObjectPath,
  isUploadMimeType,
  parseSignedUploadGrant,
  resolveTusUploadUrl,
  type UploadMimeType,
} from "@/lib/api/v1-upload-dto";
import { ADMISSION_DECLARATION_HEADER, ADMISSION_DECLARATION_VALUE } from "@/lib/analysis-attempt-precedence";

/** Browsers open a file input on Space but not on Enter, which is what a
 *  keyboard user presses on a button-like control. Enter opens it too. */
function openFileChooserOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.click();
  }
}

/** Read the tier injected by the server layout */
function getUserTier(): SubscriptionTier {
  if (typeof document === "undefined") return "par";
  const el = document.getElementById("__swingpro_tier");
  return (el?.dataset?.tier as SubscriptionTier) ?? "par";
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
// Session acquisition, refresh and identity events are owned entirely by the
// managed browser client in utils/supabase/client.ts. This page never reads the
// auth cookie itself and never disables session persistence or auto-refresh — a
// token frozen at page load cannot be refreshed and eventually reaches its `exp`,
// which Storage rejects mid-submission.
//
// A3. The page belongs to the account the dashboard layout was rendered for
// (the server-verified owner: components/navigation/SessionKeeper.tsx), never
// to whichever session the browser holds when the page first looks. Every
// owner-specific request carries a credential confirmed for that owner at the
// moment it is sent: the data client re-confirms the managed session for every
// PostgREST and Storage request (lib/drill-hub-session.ts ownerBoundClient);
// the analysis-request doorway and (A4) the analysis call, whose routes verify
// a Bearer token themselves and then read no cookie, each get the owner's token
// confirmed immediately before they are sent (ownerBearer) and go with
// `credentials: "omit"`, so no cookie — possibly another sign-in's, written by
// any writer after the confirmation — travels with them. A request whose owner
// is not confirmed is never sent with another account's credential — it is not
// sent at all.
const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";
// A2. The managed client refuses a session read it cannot confirm (another
// sign-in's write not visible here yet, a write from outside the browser's own
// writer, an unreadable lineage store: utils/supabase/session-storage.ts), and a
// read can fail outright (Auth unreachable). Neither is a sign-out, and neither
// reaches the golfer as SDK text: each has fixed copy that says what to do.
const SESSION_UNCONFIRMED_MESSAGE =
  "We couldn't confirm which account is signed in on this device, so your swing wasn't analyzed. Your video is still selected — try again, or sign in again.";
const SESSION_UNAVAILABLE_MESSAGE =
  "We couldn't check your sign-in just now, so your swing wasn't analyzed. Your video is still selected — try again in a moment.";
// A sign-out or account change noticed while an analysis runs stops it before
// its next step; it is never continued for another account.
const ACCOUNT_CHANGED_MESSAGE =
  "This browser is now signed in to a different account, so this analysis was stopped. Refresh the page before you try again.";
// A result that arrives after the page's sign-in changed belongs to the earlier
// sign-in: it is not shown here and nothing navigates.
const ANALYSIS_AFTER_CHANGE_MESSAGE =
  "This browser's sign-in changed while your swing was being analyzed, so the result isn't shown here. Refresh the page to continue with the account that's signed in now.";
// Anything else that is not one of this page's own messages (or the analysis
// server's own explanation) is never shown as it is.
const ANALYSIS_FAILED_MESSAGE = "We couldn't finish this analysis. Please try again.";
/** The submission's session read is given this long before it is reported as unavailable. */
const SESSION_READ_DEADLINE_MS = 12_000;

/** `work()`'s result, or null when it has not settled within `ms` (it keeps running; its late result is ignored). */
function settleWithin<T>(work: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work(), late]).finally(() => clearTimeout(timer));
}

// ─── Equipment context ─────────────────────────────────────────────────────────
// Choosing a club is optional. Every message below is fixed copy: the saved-club
// reader already discards the underlying database text, and the golfer is told
// what to do rather than what failed.
const CLUBS_LOADING_MESSAGE = "Loading your bag…";
// A failed load is not an empty bag. Saying "no clubs" here would tell a golfer
// who owns fourteen clubs that their bag is empty.
const CLUBS_AUTH_MESSAGE =
  "We couldn't confirm your session, so your clubs aren't available. You can still analyze without a club.";
const CLUBS_UNAVAILABLE_MESSAGE =
  "We couldn't load your clubs right now. You can still analyze without a club.";
// A2. Why the clubs could not be shown when it is the session read itself, not
// the clubs query: fixed copy, each with the one action that can help.
const CLUBS_UNCONFIRMED_MESSAGE =
  "We couldn't confirm which account is signed in on this device, so your clubs aren't shown. Try again, or sign in again.";
const CLUBS_SESSION_UNAVAILABLE_MESSAGE =
  "We couldn't check your sign-in just now, so your clubs aren't shown. Try again in a moment.";
const CLUBS_ACCOUNT_CHANGED_MESSAGE =
  "This browser is now signed in to a different account, so the clubs shown here were cleared. Refresh the page to continue with the account that's signed in now.";
/** A load (session read and clubs query together) that has not finished by then is reported as unavailable. */
const CLUBS_LOAD_DEADLINE_MS = 12_000;
type ClubsIssue = "unconfirmed" | "unavailable" | "signed_out" | "account_changed";
type IdentityEnd = "signed_out" | "account_changed";

/** The user id a session object from the managed client states, or null. Never throws. */
function sessionUserId(session: unknown): string | null {
  if (session === null || typeof session !== "object") return null;
  try {
    const user = (session as { user?: unknown }).user;
    const id = user !== null && typeof user === "object" ? (user as { id?: unknown }).id : undefined;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * What a managed-client event means for a page showing `shownUserId`'s clubs (null: none shown yet): SIGNED_OUT ends
 * it; an event carrying another golfer's session is an account change. A null session on any other event is not a
 * sign-out (the client reports an unconfirmed start-up read that way).
 */
function identityEndFromEvent(shownUserId: string | null, event: string, session: unknown): IdentityEnd | null {
  if (event === "SIGNED_OUT") return "signed_out";
  if (shownUserId === null) return null;
  const id = sessionUserId(session);
  return id !== null && id !== shownUserId ? "account_changed" : null;
}

/** The fixed copy for why the clubs cannot be shown because of the session. */
function clubsNoticeMessage(issue: ClubsIssue | null): string {
  return issue === "unconfirmed" ? CLUBS_UNCONFIRMED_MESSAGE
    : issue === "unavailable" ? CLUBS_SESSION_UNAVAILABLE_MESSAGE
      : issue === "account_changed" ? CLUBS_ACCOUNT_CHANGED_MESSAGE
        : CLUBS_AUTH_MESSAGE;
}

/**
 * The club panel's notice when the clubs cannot be shown because of the session, with its one recovery action. Its
 * text is announced by the panel's persistent status region (a region mounted together with its text is often missed).
 */
function ClubsSessionNotice({ issue, onRetry }: { issue: ClubsIssue | null; onRetry: () => void }) {
  const message = clubsNoticeMessage(issue);
  const action = "min-h-11 px-4 rounded-xl border border-white/15 text-xs font-bold text-white hover:bg-white/5 inline-flex items-center justify-center";
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">{message}</p>
      <div className="flex flex-wrap gap-2">
        {(issue === "unconfirmed" || issue === "unavailable") && (
          <button type="button" onClick={onRetry} className={action}>Try again</button>
        )}
        {issue === "account_changed" ? (
          <button type="button" onClick={() => window.location.reload()} className={action}>Refresh page</button>
        ) : issue !== "unavailable" && (
          <Link href="/login" className={action}>Sign in again</Link>
        )}
      </div>
    </div>
  );
}
// Raised when a club that was selectable when the page loaded is no longer in
// the golfer's active bag at submission time. The analysis is refused rather
// than quietly recorded against a different club, or against no club at all.
const CLUB_UNAVAILABLE_MESSAGE =
  "We couldn't confirm that club is still available in your bag. Remove it from this analysis or choose another club, then run the analyzer again.";
// The database is the final authority on whether a club may be captured into an
// analysis, so its rejection reaches the golfer as fixed copy; the raw reason is
// logged for diagnosis instead of being rendered.
const ANALYSIS_CREATE_FAILED_MESSAGE =
  "We couldn't create this analysis. Please try again.";
// EQ5C-D. Putting analysis exists and runs on the server; what it is not is
// free. A golfer whose plan does not include it is told so here rather than
// being walked through a preprocess-upload-insert sequence the server will
// refuse anyway.
//
// This is client UX and defence in depth — it is NOT the authorization. The
// tier this page holds came from the server layout at page load and can be
// stale by the time the golfer presses the button. Before any putting work
// runs, the analysis route rereads the current subscription_tier from the
// golfer's own database row and decides again. The copy is deliberately
// identical to that server refusal so the two boundaries never appear to
// disagree about why.
const PUTTING_ANALYSIS_LOCKED_MESSAGE =
  "Putting analysis isn't included with your current plan.";

// ENT-1D. Upload and video-file failures reach the golfer as fixed copy that
// says what to do; the browser's own network text ("Failed to fetch") and raw
// Storage errors never do. These checks only spare a pointless upload: the
// analysis route reads the stored bytes and refuses an unusable video itself.
const NOT_A_VIDEO_MESSAGE = "That file isn't a video. Choose an MP4, MOV or WebM video of your swing.";
const EMPTY_VIDEO_MESSAGE = "That video file is empty. Choose or record the swing again.";
const CLIP_TOO_LARGE_MESSAGE =
  "This clip is too large to analyse. Trim it to just the swing — a few seconds — and try again.";
const UPLOAD_FAILED_MESSAGE =
  "We couldn't upload your video. Check your connection, then tap Run Analyzer again — your video is still selected.";
const ANALYSIS_CONNECTION_LOST_MESSAGE =
  "We lost the connection while your swing was being analysed. Check History in a moment; if it isn't there, run it again.";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface SwingDrill { name: string; why: string; how: string; feel: string; videoUrl: string; }
interface OverlayMetric { feedback: string; overlay: { x1: number; y1: number; x2: number; y2: number }; }
interface AnalysisResult {
  /** S6-R1: null when the analysis could not be scored; never replaced by 0. */
  feedback: string; score: number | null; weakSpots: string[];
  drills: SwingDrill[];
  metrics: {
    swingSpeed: number; ballSpeed: number; launchAngle: number; smashFactor: number;
    wristHinge?: OverlayMetric; hipRotation?: OverlayMetric;
    shoulderRotation?: OverlayMetric; headStability?: OverlayMetric;
    [key: string]: unknown;
  };
  scoring_breakdown?: string;
  // v4 granular telemetry (persisted into swing_analysis)
  swing_highlights?: HighlightItem[];
  mechanical_deficiencies?: DeficiencyItem[];
  detailed_summary_html?: string | null;
  tempo_ratio?: number | null;
  swing_speed_mph?: number | null;
  // Server-injected routing fields
  _tier?: string;
  _mode?: "basic" | "advanced" | "ultra";
  _model?: string;
  _upgradeMessage?: string;
}

const MAX_FILE_MB = 250;
const MAX_SEGMENT_SECONDS = 15;

// ── AG-WEB-READY-10-P2: one stable upload identity per deliberate clip selection ─────────────────────────────────
// The selection is the signed-in owner, the chosen file, its trim and its club. Pressing Run again for the SAME
// selection (after a lost answer, a dropped connection or a refusal) re-sends the SAME upload id through the V1 upload
// contract's object key, so Storage (one immutable object key), swing_videos (the id is the primary key), the analysis request (one
// per video) and the admission (one attempt per analysis) all answer the existing records: no second upload, video,
// analysis or reservation. Any new selection, or another account, gets a new id. Held in memory for this page only.
interface UploadIntent {
  readonly ownerId: string | null;
  readonly file: File;
  readonly trimStart: number;
  readonly trimEnd: number;
  readonly clubId: string | null;
  readonly uploadId: string;
  /** The prepared clip, kept so a repeat sends the identical bytes. */
  blob: Blob | null;
  /** An upload of this selection was sent: a repeat asks finalize first whether the object is already stored. */
  sent: boolean;
  /** A1: this selection's signed resumable transfer (page memory only), so a repeat resumes it rather than re-sending. */
  transfer: SignedTransfer | null;
}

function sameSelection(
  intent: UploadIntent | null,
  selection: Pick<UploadIntent, "ownerId" | "file" | "trimStart" | "trimEnd" | "clubId">,
): intent is UploadIntent {
  return intent !== null && intent.ownerId !== null && intent.ownerId === selection.ownerId && intent.file === selection.file
    && intent.trimStart === selection.trimStart && intent.trimEnd === selection.trimEnd && intent.clubId === selection.clubId;
}

/** The V1 content type of a clip: its MIME base type, or (when a platform reports none) its name's extension; or null. */
function uploadMimeTypeOf(blob: Blob, fileName: string): UploadMimeType | null {
  const base = blob.type.split(";")[0].trim().toLowerCase();
  if (isUploadMimeType(base)) return base;
  if (base === "") {
    if (/\.(mp4|m4v)$/i.test(fileName)) return "video/mp4";
    if (/\.mov$/i.test(fileName)) return "video/quicktime";
    if (/\.webm$/i.test(fileName)) return "video/webm";
  }
  return null;
}

// ── AG-WEB-READY-10-P2-A1: the V1 signed resumable transfer of one selection ─────────────────────────────────────
// The first transfer of a selection uses exactly what POST /api/v1/uploads/authorize answered: its endpoint (the
// project's direct Storage host) and its short-lived, path-scoped signature, over the resumable (TUS) protocol, in the
// fixed 6 MiB chunks the contract names. Nothing else is trusted: the answer must name this upload id, this owner's
// object key, this content type and no upsert, at exactly the endpoint this deployment's project URL implies
// (parseSignedUploadGrant), and the transfer address must stay on the endpoint's own origin and path
// (resolveTusUploadUrl); no redirect is followed. The signature is kept in page memory for this selection only and is
// never logged or stored.
interface SignedTransfer {
  readonly uploadUrl: string;
  readonly signature: string;
  /** When the signature stops being usable (its lifetime less a minute), in epoch ms. */
  readonly usableUntil: number;
}

/** What one transfer pass left: the clip is stored; signing or creation was refused (the key may already be stored,
 *  which V1 finalize decides); or the transfer failed. */
type TransferResult = "stored" | "maybe_stored" | "failed";

/** Chunks re-read and re-sent after a failed one, per pass. */
const TRANSFER_RETRIES = 3;

function signedTransferHeaders(signature: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    "Tus-Resumable": TUS_RESUMABLE_VERSION,
    "x-signature": signature,
    apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    ...extra,
  };
}

/** The stored offset of an earlier transfer (HEAD), or null when the server has none to resume. */
async function signedTransferOffset(transfer: SignedTransfer, size: number, signal: AbortSignal): Promise<number | null> {
  try {
    const r = await fetch(transfer.uploadUrl, {
      method: "HEAD", credentials: "omit", cache: "no-store", redirect: "error", signal, headers: signedTransferHeaders(transfer.signature),
    });
    if (r.status !== 200) return null;
    const offset = Number(r.headers.get("upload-offset"));
    return Number.isSafeInteger(offset) && offset >= 0 && offset <= size ? offset : null;
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

/** Sends the clip from `start` in chunks; after a failed chunk the server's offset is read again (bounded retries). */
async function sendSignedChunks(
  transfer: SignedTransfer, blob: Blob, start: number, chunkSize: number, signal: AbortSignal, between: () => void,
): Promise<boolean> {
  let offset = start;
  let retries = 0;
  while (offset < blob.size) {
    between();
    let next: number | null = null;
    try {
      const r = await fetch(transfer.uploadUrl, {
        method: "PATCH", credentials: "omit", cache: "no-store", redirect: "error", signal,
        headers: signedTransferHeaders(transfer.signature, { "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" }),
        body: blob.slice(offset, Math.min(blob.size, offset + chunkSize)),
      });
      const answered = Number(r.headers.get("upload-offset"));
      if (r.status === 204 && Number.isSafeInteger(answered) && answered > offset && answered <= blob.size) next = answered;
    } catch (e) {
      if (signal.aborted) throw e;
    }
    if (next === null) {
      retries += 1;
      if (retries > TRANSFER_RETRIES) return false;
      next = await signedTransferOffset(transfer, blob.size, signal);
      if (next === null) return false;
    }
    offset = next;
  }
  return true;
}

/**
 * One transfer pass for this selection: resumes the selection's own transfer while its signature is usable;
 * otherwise asks V1 authorize (the page's own request) for a new signature and creates the transfer.
 */
async function transferSelection(args: {
  readonly intent: UploadIntent;
  readonly blob: Blob;
  readonly mimeType: UploadMimeType;
  readonly objectPath: string;
  /** POST /api/v1/uploads/authorize with the page's confirmed Bearer (it throws when the owner is not confirmed) */
  readonly authorize: () => Promise<Response>;
  readonly signal: AbortSignal;
  /** called before every request: stops the pass when the page's sign-in changed */
  readonly between: () => void;
}): Promise<TransferResult> {
  const { intent, blob, signal, between } = args;
  if (intent.transfer !== null && Date.now() < intent.transfer.usableUntil) {
    between();
    const offset = await signedTransferOffset(intent.transfer, blob.size, signal);
    if (offset !== null) {
      return (await sendSignedChunks(intent.transfer, blob, offset, UPLOAD_CHUNK_SIZE, signal, between)) ? "stored" : "failed";
    }
  }
  intent.transfer = null;
  const answer = await args.authorize();
  // Storage refuses to sign a key that is already stored (no upsert): V1 finalize decides whether this one is
  if (answer.status === 503) return "maybe_stored";
  if (!answer.ok) return "failed";
  const body = (await answer.json().catch(() => null)) as { data?: unknown } | null;
  // the endpoint must be exactly the one this deployment's own project URL implies (the server's own rule)
  const authorization = parseSignedUploadGrant(body?.data, {
    uploadId: intent.uploadId,
    objectPath: args.objectPath,
    contentType: args.mimeType,
    endpoint: buildResumableEndpoint(process.env.NEXT_PUBLIC_SUPABASE_URL, { allowLoopback: true }),
  });
  if (authorization === null) return "failed";
  between();
  let created: Response;
  try {
    created = await fetch(authorization.endpoint, {
      method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal,
      headers: signedTransferHeaders(authorization.signature, {
        "Upload-Length": String(blob.size),
        "Upload-Metadata": buildTusUploadMetadata(authorization),
        "x-upsert": "false",
      }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    return "failed";
  }
  if (created.status === 409) return "maybe_stored";
  const uploadUrl = created.status === 201 ? resolveTusUploadUrl(created.headers.get("location"), authorization.endpoint) : null;
  if (uploadUrl === null) return "failed";
  intent.transfer = {
    uploadUrl,
    signature: authorization.signature,
    usableUntil: Date.now() + Math.max(0, authorization.expiresInSeconds - 60) * 1000,
  };
  return (await sendSignedChunks(intent.transfer, blob, 0, authorization.chunkSize, signal, between)) ? "stored" : "failed";
}

// ─── EQ4-S2 mobile camera capture ─────────────────────────────────────────────
/** Every member is `ideal`: preferences, never requirements. An `exact` rear
 *  camera or a mandatory resolution can make the request fail outright on a
 *  device that could otherwise film a perfectly usable swing. */
const CAMERA_CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60 },
  },
};

type CameraPhase = "idle" | "starting" | "ready" | "recording" | "finalizing";

/** Stops every track on a stream. Module-level so it is stable across renders
 *  and callable from cleanup that must not depend on component identity. */
function releaseCameraTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already ended; releasing twice is not an error worth surfacing.
    }
  }
}

const CAMERA_FULL_SWING_GUIDANCE =
  "Set your phone steady at about hand height. Rear camera preferred. Use a Face-On or Down-the-Line view and keep your feet, ball, body, and full club arc in frame. Landscape is preferred.";
const CAMERA_PUTTING_GUIDANCE =
  "Set your phone steady at about hand height. Rear camera preferred. Use a Face-On or Down-the-Line view and keep the ball, putter head, hands, and complete stroke in frame. Landscape is preferred.";

/** Shown when the browser cannot produce the requested trimmed/compressed clip.
 *  We fail closed here: uploading the original file instead would analyze a
 *  different clip than the golfer asked for, and report it as a success. */
const PREPROCESSING_FAILED_MESSAGE =
  "Your browser couldn't prepare this clip for analysis. Try a shorter or smaller clip, or use another browser or device.";

/** A2. This page's own fixed messages: the only error text a failed analysis shows as it is. */
const PAGE_MESSAGES: ReadonlySet<string> = new Set([
  SESSION_EXPIRED_MESSAGE,
  SESSION_UNCONFIRMED_MESSAGE,
  SESSION_UNAVAILABLE_MESSAGE,
  ACCOUNT_CHANGED_MESSAGE,
  ANALYSIS_AFTER_CHANGE_MESSAGE,
  CLUB_UNAVAILABLE_MESSAGE,
  ANALYSIS_CREATE_FAILED_MESSAGE,
  EMPTY_VIDEO_MESSAGE,
  CLIP_TOO_LARGE_MESSAGE,
  UPLOAD_FAILED_MESSAGE,
  PREPROCESSING_FAILED_MESSAGE,
]);

/** A3. The fixed copy for a request of this page that was not sent because its account could not be confirmed. */
const OWNER_REFUSAL_MESSAGES: Readonly<Record<OwnerRefusal, string>> = {
  signed_out: SESSION_EXPIRED_MESSAGE,
  ended: SESSION_EXPIRED_MESSAGE,
  unconfirmed: SESSION_UNCONFIRMED_MESSAGE,
  unavailable: SESSION_UNAVAILABLE_MESSAGE,
  account_changed: ACCOUNT_CHANGED_MESSAGE,
};

/** A3. This page's data client: the shared managed client's Auth, with every data request bound to `ownerId`. */
function analyzeClientFor(ownerId: string | null) {
  return ownerBoundClient(createClient(), ownerId, process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

/**
 * A2. What a failed analysis shows: one of this page's fixed messages; the analysis server's own explanation (a plain
 * Error thrown from its refusal, after the analysis started); a fixed "unconfirmed" message for a session read the
 * managed client refused inside a request; otherwise fixed copy — never an SDK, Storage or runtime error's own text.
 */
function golferMessage(failure: unknown, analysisStarted: boolean): string {
  if (sessionUnverifiedReason(failure) !== null) return SESSION_UNCONFIRMED_MESSAGE;
  if (!(failure instanceof Error)) return ANALYSIS_FAILED_MESSAGE;
  if (PAGE_MESSAGES.has(failure.message)) return failure.message;
  if (analysisStarted && failure.constructor === Error && failure.message.length > 0) return failure.message;
  return ANALYSIS_FAILED_MESSAGE;
}

function formatYt(url: string) {
  if (!url) return "";
  if (url.includes("watch?v=")) return url.replace("watch?v=", "embed/");
  if (url.includes("youtu.be/")) return `https://www.youtube.com/embed/${url.split("youtu.be/")[1]}`;
  return url;
}

// ─── Component ─────────────────────────────────────────────────────────────────
export default function AnalyzePage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  // P2: the current selection's stable upload identity (see UploadIntent)
  const uploadIntentRef = useRef<UploadIntent | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // A2. Set synchronously: a second Run press before the busy overlay renders starts nothing.
  const analyzingRef = useRef(false);
  // A3 review. The running analysis's cancellation: leaving the page cancels an
  // analysis call it has not sent yet (one already sent runs on, as before).
  const runAbortRef = useRef<AbortController | null>(null);
  const [isTrimming, setIsTrimming] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeDrillVideo, setActiveDrillVideo] = useState<string | null>(null);
  const [lmFile, setLmFile] = useState<File | null>(null);
  const [userTier, setUserTier] = useState<SubscriptionTier>("par");

  // A3. The account this page belongs to: the one the dashboard layout was
  // rendered for, as the server verified it — taken once, when the page first
  // renders, and never replaced by a session the browser holds. No account
  // (a page rendered outside the dashboard layout): nothing is read or sent.
  const rendered = useRenderedSession();
  const ownerRef = useRef<string | null>(rendered?.ownerId ?? null);
  const renderedLineageRef = useRef<string | null>(rendered?.lineage ?? null);

  // One client for the lifetime of this mounted page: the managed browser
  // client's Auth, with every data request bound to the page's account (A3). A
  // lazy ref is used rather than a memo because this is an identity that must
  // not be recreated, not a value derived from props: memoization is a cache
  // the runtime is free to discard, which would silently hand the selector and
  // the submission two different clients. Selector loading and submission below
  // both use this exact binding.
  const supabaseRef = useRef<ReturnType<typeof analyzeClientFor> | null>(null);
  if (supabaseRef.current === null) {
    supabaseRef.current = analyzeClientFor(ownerRef.current);
  }
  const supabase = supabaseRef.current;

  const router = useRouter();
  const searchParams = useSearchParams();

  // null means "still loading". Every other state is a real SavedClubsResult,
  // so a failed load can never be rendered as an empty bag.
  const [savedClubs, setSavedClubs] = useState<SavedClubsResult | null>(null);
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null);
  // The URL hint is applied at most once, so a later re-resolution cannot
  // overwrite a choice the golfer has since made in the selector.
  const clubHintApplied = useRef(false);
  // A2. Why the clubs are not shown when the session read itself failed (shown
  // with the auth_error state); a deliberate Try again bumps the load key.
  const [clubsIssue, setClubsIssue] = useState<ClubsIssue | null>(null);
  const [clubsLoadKey, setClubsLoadKey] = useState(0);
  // A load is running (a second Try again press before React re-renders starts nothing).
  const clubsLoadingRef = useRef(false);
  // False once the page has left: an analysis finishing afterwards shows nothing and navigates nowhere.
  const mountedRef = useRef(true);
  // Identity generation: bumped by a sign-out or account change, so a clubs load or an analysis started for the
  // earlier account stops at its next step and never shows or sends anything afterwards.
  const identityRef = useRef(0);
  const identityEndRef = useRef<IdentityEnd | null>(null);
  const endIdentityRef = useRef<(why: IdentityEnd) => void>(() => undefined);
  const stopLineageWatchRef = useRef<() => void>(() => undefined);

  // EQ4-S2 camera capture. `cameraError` is separate from the page-wide `error`
  // banner on purpose: that banner renders inside the preview branch, so it is
  // invisible while previewUrl is null — exactly when camera failures happen.
  const [cameraPhase, setCameraPhase] = useState<CameraPhase>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRecorderRef = useRef<MediaRecorder | null>(null);
  /** Async generation. Bumped on every start and every abandon, so a late
   *  getUserMedia or a stale recorder callback can tell it is obsolete. */
  const cameraRequestRef = useRef(0);
  const cameraDiscardRef = useRef(false);

  // EQ3-S2. Layer 1 classifies the current selection and nothing else; it is
  // presentation only and never an authority for the database analysis family,
  // for routing, or for persistence.
  const selectedPutter = isPuttingCapturePresentation(savedClubs, selectedClubId);
  // Layer 2 decides whether that classification may change the screen. A
  // completed report is evidence about a swing that was already analyzed, so
  // moving the selector afterwards must never relabel or suppress it — capture
  // presentation applies only while no result exists.
  const isPuttingCapture = selectedPutter && result === null;

  useEffect(() => {
    setUserTier(getUserTier());
  }, []);

  /**
   * A2. Whether the browser is still signed in as `userId`, by a fresh read
   * through the same managed client. Never rejects.
   */
  const confirmSignedInAs = useCallback(
    async (userId: string): Promise<"same" | IdentityEnd | "unconfirmed" | "unavailable"> => {
      try {
        const { data, error: readError } = await supabase.auth.getSession();
        if (readError) return "unavailable";
        const id = sessionUserId(data.session);
        if (id === null) return "signed_out";
        return id === userId ? "same" : "account_changed";
      } catch (readFailure) {
        return sessionUnverifiedReason(readFailure) !== null ? "unconfirmed" : "unavailable";
      }
    },
    [supabase],
  );

  useEffect(() => {
    let cancelled = false;
    const generation = identityRef.current;
    clubsLoadingRef.current = true;

    // A2. Every load settles exactly once: with the clubs, with a classified
    // reason (Try again or Sign in again), or — when an identity change ended
    // the page's view meanwhile — with nothing, leaving that change's notice.
    const finish = () => {
      cancelled = true;
      clearTimeout(deadline);
      clubsLoadingRef.current = false;
    };
    const settle = (issue: ClubsIssue) => {
      finish();
      if (identityRef.current !== generation) return;
      // another account than the page's golfer: the page's view ends for good (an analysis then refuses to run)
      if (issue === "account_changed") return endIdentityRef.current("account_changed");
      setSavedClubs({ status: "auth_error", clubs: [] });
      setClubsIssue(issue);
    };
    // A load still running after CLUBS_LOAD_DEADLINE_MS is reported as
    // unavailable, and whatever it returns afterwards is dropped.
    const deadline = setTimeout(() => {
      if (!cancelled) settle("unavailable");
    }, CLUBS_LOAD_DEADLINE_MS);

    void (async () => {
      let sessionRead: Awaited<ReturnType<typeof supabase.auth.getSession>>;
      try {
        sessionRead = await supabase.auth.getSession();
      } catch (readFailure) {
        if (cancelled) return;
        // A refused read is "unconfirmed", a failed one "unavailable": never a
        // sign-out, never SDK text, and nothing is read without a session.
        settle(sessionUnverifiedReason(readFailure) !== null ? "unconfirmed" : "unavailable");
        return;
      }
      const { data: { session }, error: sessionError } = sessionRead;
      const clubsUserId = session?.user?.id;
      if (cancelled) return;

      if (sessionError || !session || !clubsUserId) {
        // Classified, never surfaced raw. A returned error is a read that
        // failed (Auth unreachable); no session at all is a genuine sign-out.
        settle(sessionError ? "unavailable" : "signed_out");
        return;
      }
      if (identityRef.current !== generation) return finish();
      // A3. Only the account the page was rendered for: another account's
      // session is never adopted (it ends the view), and without an account
      // nothing is read.
      const owner = ownerRef.current;
      if (owner === null) {
        settle("unconfirmed");
        return;
      }
      if (clubsUserId !== owner) {
        settle("account_changed");
        return;
      }

      // The one saved-club reader. It scopes to this user id alongside RLS and
      // excludes archived rows in the query itself; its request carries the
      // page's account's confirmed token, or is not sent (A3).
      const result = await querySavedClubs(supabase, { userId: clubsUserId });
      if (cancelled) return;
      // A2. Shown only while that golfer is still the one signed in here: an
      // answer from a read that went out after a sign-out or account change
      // (the managed client attaches whatever session is current) is dropped.
      const still = await confirmSignedInAs(clubsUserId);
      if (cancelled) return;
      if (identityRef.current !== generation) return finish();
      if (still !== "same") {
        settle(still);
        return;
      }
      finish();

      setClubsIssue(null);
      setSavedClubs(result);
      // End Session of this session (here or in another tab) ends what is shown.
      stopLineageWatchRef.current();
      stopLineageWatchRef.current = watchSessionEnd(session, () => endIdentityRef.current("signed_out"));

      if (!clubHintApplied.current) {
        clubHintApplied.current = true;
        // Accepted only when it exactly matches a club in this active, owned
        // result. Malformed, unknown, foreign and archived ids all yield null.
        const hinted = resolveInitialClubId(result, searchParams.get("club_id"));
        if (hinted !== null) setSelectedClubId(hinted);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(deadline);
      clubsLoadingRef.current = false;
    };
  }, [supabase, searchParams, clubsLoadKey, confirmSignedInAs]);

  /** A2. A deliberate Try again after a failed clubs load: one load at a time. */
  const retryClubs = useCallback(() => {
    if (clubsLoadingRef.current || identityEndRef.current === "account_changed") return;
    clubsLoadingRef.current = true;
    setSavedClubs(null);
    setClubsIssue(null);
    setClubsLoadKey((key) => key + 1);
  }, []);

  // A2. A sign-out or account change noticed while the page is open (managed
  // client events, which also bring other tabs' sign-ins and sign-outs, and an
  // End Session of this session anywhere in the browser) ends what was shown
  // for the earlier account: the clubs and the club choice are cleared, a load
  // or analysis still running for it stops before its next step, and the
  // panel says what happened. The golfer's chosen video stays selected.
  useEffect(() => {
    const end = (why: IdentityEnd) => {
      if (identityEndRef.current === "account_changed") return;
      identityEndRef.current = why;
      identityRef.current += 1;
      clubsLoadingRef.current = false;
      stopLineageWatchRef.current();
      stopLineageWatchRef.current = () => undefined;
      setSelectedClubId(null);
      setSavedClubs({ status: "auth_error", clubs: [] });
      setClubsIssue(why);
    };
    endIdentityRef.current = end;
    let unsubscribe = () => {};
    try {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        // A3: measured against the account the page was rendered for, from the moment it mounts
        const why = identityEndFromEvent(ownerRef.current, event, session);
        if (why !== null) end(why);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      // no events: the next session read decides
    }
    // A3: End Session of the sign-in the page was rendered for (here or in another tab) ends the view at once
    const stopRenderedWatch = watchLineageEnd(renderedLineageRef.current, () => end("signed_out"));
    return () => {
      unsubscribe();
      stopRenderedWatch();
      stopLineageWatchRef.current();
      endIdentityRef.current = () => undefined;
    };
  }, [supabase]);

  // A3. The layout re-rendered for another account while this page stays
  // mounted (a refresh after another sign-in): this page's view ends; a reload
  // shows the account signed in now.
  const renderedOwner = rendered?.ownerId ?? null;
  useEffect(() => {
    if (renderedOwner !== ownerRef.current) endIdentityRef.current("account_changed");
  }, [renderedOwner]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runAbortRef.current?.abort();
    };
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const applyMeta = () => {
      if (video.duration && isFinite(video.duration)) {
        setDuration(video.duration);
        setTrimEnd(video.duration);
        setVideoAspect(video.videoWidth / video.videoHeight);
      }
    };

    const onTime = () => setCurrentTime(video.currentTime);

    video.addEventListener("loadedmetadata", applyMeta);
    video.addEventListener("durationchange", applyMeta);
    video.addEventListener("timeupdate", onTime);

    // Blob URLs load instantly — metadata may already be available
    if (video.readyState >= 1) applyMeta();

    return () => {
      video.removeEventListener("loadedmetadata", applyMeta);
      video.removeEventListener("durationchange", applyMeta);
      video.removeEventListener("timeupdate", onTime);
    };
  }, [previewUrl]);

  const handleFile = useCallback((f: File) => {
    // Some platforms report no type for a video; its extension then decides.
    // A refused file also clears any earlier selection, so Run Analyzer can
    // never send a different video from the one the golfer just chose.
    const refuse = (message: string) => {
      setFile(null); setPreviewUrl(null); setResult(null); setError(message);
    };
    if (!(f.type.startsWith("video/") || (f.type === "" && /\.(mp4|m4v|mov|webm|3gp)$/i.test(f.name)))) {
      refuse(NOT_A_VIDEO_MESSAGE);
      return;
    }
    if (f.size < MIN_VIDEO_BYTES) {
      refuse(EMPTY_VIDEO_MESSAGE);
      return;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`Video too large (max ${MAX_FILE_MB}MB).`);
      return;
    }
    setFile(f); setPreviewUrl(URL.createObjectURL(f));
    setResult(null); setError(null); setVideoAspect(null);
    setTrimStart(0); setTrimEnd(0); setDuration(0);
  }, []);

  // ── Browser-side trim + compress (Canvas + MediaRecorder) ──────────────────
  const getTrimmedBlob = async (): Promise<Blob> => {
    const video = videoRef.current;
    if (!video || !file) throw new Error("No video loaded");

    // Skip transcode if already small and no trim needed. This fast path is
    // deliberate — it must never be gated on MediaRecorder/captureStream.
    const preprocessingRequired = !(
      trimStart === 0 && Math.abs(trimEnd - duration) < 0.1 && file.size <= MAX_ANALYSIS_VIDEO_BYTES
      // P2: and a content type the V1 upload contract accepts (otherwise the clip is transcoded to WebM)
      && uploadMimeTypeOf(file, file.name) !== null
    );
    if (!preprocessingRequired) {
      return file;
    }

    setIsTrimming(true);

    // Preprocessing IS required below. Every exit must either deliver the
    // processed clip or reject — never silently substitute the original file.
    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let check: ReturnType<typeof setInterval> | undefined;
      let raf: number | undefined;
      // Cleanup-owned handles. Declared here so terminal cleanup can reach the
      // seeked listener and the recorder, both of which are created below.
      let activeRecorder: MediaRecorder | undefined;
      let seekedHandler: (() => void) | undefined;

      const cleanup = () => {
        // 1. Drop the pending seeked listener FIRST, so the currentTime
        //    restoration at the end of this function cannot re-trigger it.
        if (seekedHandler !== undefined) {
          video.removeEventListener("seeked", seekedHandler);
          seekedHandler = undefined;
        }
        // 2. Cancel every scheduled continuation.
        if (timeout !== undefined) clearTimeout(timeout);
        if (watchdog !== undefined) clearTimeout(watchdog);
        if (check !== undefined) clearInterval(check);
        if (raf !== undefined) cancelAnimationFrame(raf);
        // 3. Stop preprocessing playback.
        video.pause();
        // 4. Terminate a still-running recorder. `settled` is already true when
        //    this runs, so any resulting onstop is inert and cannot turn a
        //    failure into a success.
        if (activeRecorder !== undefined && activeRecorder.state !== "inactive") {
          try { activeRecorder.stop(); } catch { /* stop is best-effort during cleanup */ }
        }
        // 5. Clear the busy state.
        setIsTrimming(false);
        // 6. Restore playback state last.
        if (videoRef.current) { videoRef.current.playbackRate = 1; videoRef.current.currentTime = trimStart; }
      };

      const succeed = (blob: Blob) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(blob);
      };

      /** Fail closed — the requested clip could not be produced. */
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(PREPROCESSING_FAILED_MESSAGE));
      };

      try {
        const aspect = video.videoWidth / video.videoHeight;
        let w = aspect < 1 ? Math.round(848 * aspect) : 848;
        let h = aspect < 1 ? 848 : Math.round(848 / aspect);
        if (w % 2 !== 0) w--;
        if (h % 2 !== 0) h--;

        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) { fail(); return; }

        const stream = (canvas as any).captureStream?.(30);
        if (!stream) { fail(); return; }

        const recorder = new MediaRecorder(stream, {
          mimeType: "video/webm",
          videoBitsPerSecond: 800_000,
        });
        activeRecorder = recorder;
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

        // Asynchronous recorder failure — without this the promise could never
        // settle, leaving the UI stuck in the compressing state.
        recorder.onerror = () => { fail(); };

        recorder.onstop = () => {
          if (chunks.length === 0) { fail(); return; }
          succeed(new Blob(chunks, { type: "video/webm" }));
        };

        const drawFrame = () => {
          if (video.paused || video.ended || video.currentTime > trimEnd) return;
          ctx.drawImage(video, 0, 0, w, h);
          raf = requestAnimationFrame(drawFrame);
        };

        video.currentTime = trimStart;
        video.playbackRate = 2.0;
        video.muted = true;

        // Absolute backstop, strictly later than the normal stop timeout, so no
        // recorder path can leave this promise unsettled.
        watchdog = setTimeout(fail, ((trimEnd - trimStart) / 2.0) * 3000 + 15000);

        const onSeeked = () => {
          if (settled) return;
          video.removeEventListener("seeked", onSeeked);
          seekedHandler = undefined;
          video.play().then(() => {
            // play() may still have been pending when the operation settled.
            if (settled) return;
            recorder.start(100);
            drawFrame();
            check = setInterval(() => {
              if (video.currentTime >= trimEnd || video.ended) {
                if (check !== undefined) clearInterval(check);
                video.pause();
                if (recorder.state !== "inactive") recorder.stop();
              }
            }, 50);
            timeout = setTimeout(() => {
              if (check !== undefined) clearInterval(check);
              if (recorder.state !== "inactive") recorder.stop();
            }, ((trimEnd - trimStart) / 2.0) * 3000 + 4000);
          }).catch(() => { fail(); });
        };
        seekedHandler = onSeeked;
        video.addEventListener("seeked", onSeeked);
      } catch { fail(); }
    });
  };

  // ── Map the DB row returned by /api/analyze-swing to the AnalysisResult shape ──
  function dbRowToResult(row: Record<string, unknown>): AnalysisResult {
    const m = (row.metrics as Record<string, unknown>) ?? {};
    const defs = (row.mechanical_deficiencies as DeficiencyItem[]) ?? [];
    const rawDrills = (Array.isArray(m.drills) ? m.drills : []) as Record<string, string>[];
    const mode = (() => {
      if (userTier === "eagle" || userTier === "coach_pro") return "ultra" as const;
      if (userTier === "birdie" || userTier === "coach_starter") return "advanced" as const;
      return "basic" as const;
    })();
    return {
      feedback:          String(row.feedback ?? ""),
      score:             typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
      scoring_breakdown: typeof m.scoring_breakdown === "string" ? m.scoring_breakdown : undefined,
      weakSpots:  defs.slice(0, 4).map((d) => d.fault_description ?? "").filter(Boolean),
      drills:     rawDrills.map((d) => ({
        name:     d.name     ?? "",
        why:      d.the_why  ?? "",
        how:      d.the_how  ?? "",
        feel:     d.the_feel ?? "",
        videoUrl: "",
      })),
      // Launch monitor data is not available in this flow — render shows "Not Connected"
      metrics: { swingSpeed: 0, ballSpeed: 0, launchAngle: 0, smashFactor: 0 },
      swing_highlights:       (row.swing_highlights as HighlightItem[]) ?? [],
      mechanical_deficiencies: defs,
      detailed_summary_html:  null,
      tempo_ratio:            typeof row.tempo_ratio === "number" ? row.tempo_ratio : null,
      swing_speed_mph:        null,
      _mode:                  mode,
    };
  }

  // ── Analysis flow ──────────────────────────────────────────────────────────
  const startAnalysis = async () => {
    if (!file) return;
    // EQ5C-D defence in depth. An unentitled Putter is not given an executable
    // action, but a stale handler or a programmatic call must not spend the
    // golfer's bandwidth and a database row on work the server will refuse.
    // Refuse here — before trim validation, before preprocessing, before
    // session resolution, before Storage, before both database inserts and
    // before /api/analyze-swing — so nothing is mutated.
    //
    // The entitlement question is asked through the one central helper, so this
    // page never carries its own copy of the plan matrix. `userTier` is the
    // value the server layout rendered at page load: good enough to keep an
    // unentitled golfer out of a pointless upload, and never the authority. The
    // route rereads the live tier before it executes anything.
    if (
      isPuttingCapturePresentation(savedClubs, selectedClubId) &&
      !canUsePuttingAnalysis(userTier)
    ) {
      setError(PUTTING_ANALYSIS_LOCKED_MESSAGE);
      return;
    }
    if (trimEnd - trimStart > MAX_SEGMENT_SECONDS) {
      setError(`Trim your segment to under ${MAX_SEGMENT_SECONDS}s for best results.`);
      return;
    }
    // A2. After the page's view ended for another account, nothing runs here
    // until the page is refreshed for the account signed in now.
    if (identityEndRef.current === "account_changed") {
      setError(ACCOUNT_CHANGED_MESSAGE);
      return;
    }
    // A2. One analysis at a time: a second press before React re-renders the
    // busy overlay starts nothing.
    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setIsAnalyzing(true); setError(null);
    const runAbort = new AbortController();
    runAbortRef.current = runAbort;

    // A2. The analysis belongs to the golfer this page is showing. A sign-out
    // or account change noticed while it runs stops it before its next step.
    const generation = identityRef.current;
    const stopIfIdentityChanged = () => {
      if (identityRef.current === generation) return;
      throw new Error(identityEndRef.current === "signed_out" ? SESSION_EXPIRED_MESSAGE : ACCOUNT_CHANGED_MESSAGE);
    };
    // A3 review. A request refused because the browser now holds another
    // account also ends the page's view (as the clubs re-check does).
    const refusedFor = (reason: OwnerRefusal): string => {
      if (reason === "account_changed") endIdentityRef.current("account_changed");
      return OWNER_REFUSAL_MESSAGES[reason];
    };
    // A3. Why a data step failed when the page's account can no longer be
    // confirmed (its request was then not sent at all); null otherwise.
    const ownerNoLongerConfirmed = async (): Promise<string | null> => {
      const now = await confirmOwnerSession(() => supabase, ownerRef.current, SESSION_READ_DEADLINE_MS);
      return now.status === "ready" ? null : refusedFor(now.status);
    };

    // Which step a network failure interrupted decides what the golfer is told.
    let analysisStarted = false;
    try {
      // P2: the selection's stable upload identity, and its clip prepared once (a repeat sends the identical bytes).
      const selection = { ownerId: ownerRef.current, file, trimStart, trimEnd, clubId: selectedClubId };
      const intent: UploadIntent = sameSelection(uploadIntentRef.current, selection)
        ? uploadIntentRef.current
        : { ...selection, uploadId: crypto.randomUUID(), blob: null, sent: false, transfer: null };
      uploadIntentRef.current = intent;
      const blob = intent.blob ?? await getTrimmedBlob();
      intent.blob = blob;
      // The route sends at most MAX_ANALYSIS_VIDEO_BYTES to the AI and refuses
      // anything larger, so a clip that is still too large is not uploaded.
      if (blob.size < MIN_VIDEO_BYTES) throw new Error(EMPTY_VIDEO_MESSAGE);
      if (blob.size > MAX_ANALYSIS_VIDEO_BYTES) throw new Error(CLIP_TOO_LARGE_MESSAGE);

      // Auth is required upfront — we need to upload the video before calling the
      // API. Resolve the CURRENT session from the managed browser client here,
      // after preprocessing and before any Storage/database/API mutation:
      // preprocessing can take long enough for a previously valid access token to
      // expire. getSession() returns the stored session and refreshes it when it
      // is at (or near) expiry, persisting the rotated tokens through the managed
      // client's own cookie storage. Refreshing is deliberately NOT forced on
      // every submission.
      let sessionAnswer: Awaited<ReturnType<typeof supabase.auth.getSession>> | null;
      try {
        // bounded: a read with no answer in time is unavailable, never a run left busy
        sessionAnswer = await settleWithin(async () => await supabase.auth.getSession(), SESSION_READ_DEADLINE_MS);
      } catch (readFailure) {
        // A2. A refused read (unconfirmed) or a failed one: fixed copy, the
        // video stays selected, nothing is sent.
        throw new Error(sessionUnverifiedReason(readFailure) !== null ? SESSION_UNCONFIRMED_MESSAGE : SESSION_UNAVAILABLE_MESSAGE);
      }
      if (sessionAnswer === null) throw new Error(SESSION_UNAVAILABLE_MESSAGE);
      const { data: { session }, error: sessionError } = sessionAnswer;
      const userId = session?.user?.id;
      // A returned error is a read that failed (Auth unreachable), not a sign-out.
      const sessionGuardMessage = sessionError ? SESSION_UNAVAILABLE_MESSAGE : SESSION_EXPIRED_MESSAGE;
      // Fail here — before Storage, before swing_videos, before swing_analysis,
      // and before /api/analyze-swing. The raw Supabase error is not surfaced to
      // the golfer; they get an actionable instruction instead.
      if (sessionError || !session || !userId) throw new Error(sessionGuardMessage);
      // A3. Only the account the page was rendered for: never another, and
      // never one adopted because it was the first seen (another account's
      // session ends the page's view; without an account nothing is sent).
      if (ownerRef.current === null) throw new Error(SESSION_UNCONFIRMED_MESSAGE);
      if (userId !== ownerRef.current) {
        endIdentityRef.current("account_changed");
        throw new Error(ACCOUNT_CHANGED_MESSAGE);
      }
      stopIfIdentityChanged();
      // A2. A session the server already ended (its removal from this browser is still pending) is not used.
      if (await sessionEndPending(session)) throw new Error(SESSION_EXPIRED_MESSAGE);
      stopIfIdentityChanged();

      // Re-check the chosen club against a freshly read active bag, using the
      // session just resolved. A club removed from the bag since the selector
      // loaded must not reach Storage, swing_videos or swing_analysis, so this
      // runs before any of them. It is defence in depth, not the last word: the
      // database's own active-row guard on the snapshot producer still decides
      // an archive that lands after this point, and refuses the insert.
      let validatedClubId: string | null = null;
      if (selectedClubId !== null) {
        const currentClubs = await querySavedClubs(supabase, { userId });
        if (!isSelectionStillValid(currentClubs, selectedClubId)) {
          // A3: a re-check not sent because the page's account could not be confirmed says why
          if (currentClubs.status === "auth_error") {
            const notConfirmed = await ownerNoLongerConfirmed();
            if (notConfirmed !== null) throw new Error(notConfirmed);
          }
          // No substitution and no fallback — recording a club the golfer did
          // not choose would corrupt the analysis record.
          throw new Error(CLUB_UNAVAILABLE_MESSAGE);
        }
        validatedClubId = selectedClubId;
      }

      // 1. Upload the clip (AG-WEB-READY-10-P2; A1: through V1 authorize and its signed transport). The object key is
      // the V1 upload contract's deterministic key for the verified owner and this selection's upload id
      // (lib/api/v1-upload-dto.ts buildUploadObjectPath, the same builder authorize signs and V1 finalize verifies
      // against), so a repeat of the same selection names the same immutable object: Storage refuses to sign or
      // overwrite it and finalize proves the stored object. ENT-1D: the display file name is canonical.
      const safeFilename = canonicalUploadFileName(file.name);
      const mimeType = uploadMimeTypeOf(blob, file.name);
      if (mimeType === null) throw new Error(PREPROCESSING_FAILED_MESSAGE);
      const objectPath = buildUploadObjectPath(userId, intent.uploadId, mimeType);
      // A repeat of this selection asks finalize (step 2) first: its object may already be stored, and a refused
      // duplicate upload is never sent before finalize. Only "not stored" sends the upload, once (at most two passes).
      let skipUpload = intent.sent;
      for (let pass = 0; ; pass++) {
        if (!skipUpload) {
          stopIfIdentityChanged();
          intent.sent = true;
          const transferred = await transferSelection({
            intent,
            blob,
            mimeType,
            objectPath,
            authorize: async () => {
              // the page's own account's token, confirmed now: the signature is minted for this owner's key only
              const authorizeSession = await confirmOwnerSession(() => supabase, ownerRef.current, SESSION_READ_DEADLINE_MS);
              if (authorizeSession.status !== "ready") throw new Error(refusedFor(authorizeSession.status));
              stopIfIdentityChanged();
              return fetch("/api/v1/uploads/authorize", {
                method: "POST",
                // the Bearer alone identifies the request; no cookie (possibly another sign-in's) goes with it
                credentials: "omit",
                headers: { "Content-Type": "application/json", ...ownerBearer(authorizeSession.session) },
                body: JSON.stringify({ uploadId: intent.uploadId, mimeType, fileSize: blob.size }),
              });
            },
            signal: runAbort.signal,
            between: stopIfIdentityChanged,
          });
          if (transferred === "failed") {
            console.error("Video upload failed");
            // A3: an upload not sent because the page's account could not be confirmed says why
            const notConfirmed = await ownerNoLongerConfirmed();
            if (notConfirmed !== null) throw new Error(notConfirmed);
            throw new Error(UPLOAD_FAILED_MESSAGE);
          }
        }

        // 2. Finalize: exactly one canonical swing_videos row for this upload id (idempotent; V1 finalize derives the
        // owner, path, size and type on the server), with the clip's display name and trim as this page has always
        // recorded them.
        stopIfIdentityChanged();
        const finalizeSession = await confirmOwnerSession(() => supabase, ownerRef.current, SESSION_READ_DEADLINE_MS);
        if (finalizeSession.status !== "ready") throw new Error(refusedFor(finalizeSession.status));
        stopIfIdentityChanged();
        const finalizeRes = await fetch("/api/v1/uploads/finalize", {
          method:  "POST",
          // the Bearer alone identifies the request; no cookie (possibly another sign-in's) goes with it
          credentials: "omit",
          headers: { "Content-Type": "application/json", ...ownerBearer(finalizeSession.session) },
          body:    JSON.stringify({
            uploadId: intent.uploadId,
            mimeType,
            originalFilename: safeFilename,
            ...(trimEnd > trimStart ? { trimStart, trimEnd } : {}),
          }),
        });
        const finalized = await finalizeRes.json().catch(() => null) as
          { data?: { swingVideoId?: unknown }; error?: { code?: unknown } } | null;
        if (finalizeRes.ok && finalized?.data?.swingVideoId === intent.uploadId) break;
        // a repeat whose object was never stored: upload it now (once)
        if (skipUpload && pass === 0 && finalizeRes.status === 409 && finalized?.error?.code === "UPLOAD_NOT_FOUND_OR_NOT_READY") {
          skipUpload = false;
          continue;
        }
        console.error("Failed to register video:", finalizeRes.status);
        const notConfirmed = await ownerNoLongerConfirmed();
        if (notConfirmed !== null) throw new Error(notConfirmed);
        throw new Error(UPLOAD_FAILED_MESSAGE);
      }
      const videoRow = { id: intent.uploadId };

      // 3. Ask the server to create the pending analysis request. The browser
      // holds no INSERT privilege on swing_analysis: the owner, readiness, club
      // and entitlement are all decided by /api/v1/analyses, the same doorway
      // native clients use. The club id is the only equipment fact sent; the
      // derived analysis family and the immutable equipment snapshot are
      // produced by the database trigger and are never sent from here.
      // A3. That doorway verifies a Bearer token itself and then reads no
      // cookie, so the request carries the page's account's token, confirmed
      // now: it can only ever be that account's request.
      stopIfIdentityChanged();
      const requestSession = await confirmOwnerSession(() => supabase, ownerRef.current, SESSION_READ_DEADLINE_MS);
      if (requestSession.status !== "ready") throw new Error(refusedFor(requestSession.status));
      stopIfIdentityChanged();
      const createRes = await fetch("/api/v1/analyses", {
        method:  "POST",
        // A3 review: the Bearer alone identifies the request; no cookie (possibly another sign-in's) goes with it
        credentials: "omit",
        headers: { "Content-Type": "application/json", ...ownerBearer(requestSession.session) },
        body:    JSON.stringify({ swingVideoId: videoRow.id, clubId: validatedClubId }),
      });
      const created = await createRes.json().catch(() => null) as
        { data?: { analysisId?: unknown } } | null;
      const createdId = created?.data?.analysisId;
      const analysisRow = createRes.ok && typeof createdId === "string" ? { id: createdId } : null;
      if (!analysisRow) {
        // This branch also covers the server refusing a club archived between
        // the check above and the request. Server error text must not become
        // golfer-facing copy, so only the status is logged and a fixed message
        // is thrown instead.
        console.error("Failed to create analysis record:", createRes.status);
        throw new Error(ANALYSIS_CREATE_FAILED_MESSAGE);
      }

      // 4. Call the direct Gemini pipeline — it fetches the video from Storage itself
      // A4 (C1). The route verifies a Bearer token itself (resolveRouteAuth) and
      // then reads no cookie, so the request carries the page's account's
      // token, confirmed now, and no cookie at all: whatever any writer puts in
      // the jar after this confirmation, the request can only be this account's.
      // No lease is held, and nothing waits on the analysis. Leaving the page
      // before it is sent cancels it; once sent it runs on, as before.
      stopIfIdentityChanged();
      const analysisSession = await confirmOwnerSession(() => supabase, ownerRef.current, SESSION_READ_DEADLINE_MS);
      if (analysisSession.status !== "ready") throw new Error(refusedFor(analysisSession.status));
      stopIfIdentityChanged();
      if (runAbort.signal.aborted || !mountedRef.current) return;
      analysisStarted = true;
      const analysisRes = await fetch("/api/analyze-swing", {
        method:  "POST",
        // the Bearer alone identifies the request; no cookie (possibly another sign-in's) goes with it
        credentials: "omit",
        // P2: this page understands a 202 acceptance (not a security control; the server decides)
        headers: { "Content-Type": "application/json", ...ownerBearer(analysisSession.session), [ADMISSION_DECLARATION_HEADER]: ADMISSION_DECLARATION_VALUE },
        body:    JSON.stringify({ analysisId: analysisRow.id }),
      });
      // A2. Finished after the golfer left the page, or after the page's
      // sign-in changed: nothing of it is shown here and nowhere is navigated.
      if (!mountedRef.current) return;
      if (identityRef.current !== generation) throw new Error(ANALYSIS_AFTER_CHANGE_MESSAGE);

      // P2: accepted and saved durably (202). The analysis runs in the background; the saved report shows the queued
      // attempt and can be closed and reopened. Nothing waits here.
      if (analysisRes.status === 202) {
        await analysisRes.json().catch(() => null);
        if (!mountedRef.current) return;
        if (identityRef.current !== generation) throw new Error(ANALYSIS_AFTER_CHANGE_MESSAGE);
        router.push(`/analyze/${analysisRow.id}`);
        return;
      }

      if (!analysisRes.ok) {
        const err = await analysisRes.json().catch(() => ({}));
        // A3 (F2). The error body can finish after the golfer left the page or
        // the page's sign-in changed: nothing of it is acted on then.
        if (!mountedRef.current) return;
        if (identityRef.current !== generation) throw new Error(ANALYSIS_AFTER_CHANGE_MESSAGE);
        // ENT-1D. Already running for this swing: hand over to its report page,
        // which shows the in-progress state and can check again. A synchronous
        // stall falls through to the error banner below, which offers no retry,
        // with the server's explanation (A1: an attempt that stopped reporting is
        // handed over below instead).
        if (analysisRes.status === 409 && err.status === "processing") {
          router.push(`/analyze/${analysisRow.id}`);
          return;
        }
        // P2: this swing already has an attempt that finished without a result (or a retry refers to an earlier one):
        // its report shows that attempt and offers the right next step.
        if (analysisRes.status === 409 && (err.status === "failed" || err.status === "superseded")) {
          router.push(`/analyze/${analysisRow.id}`);
          return;
        }
        // A1: an answer describing an attempt that stopped reporting (`current ?? attempt`; its outcome is not
        // confirmed yet; only a job's stall names one) hands over to its report, which shows it and offers a status
        // read. Nothing is retried; a synchronous stall (no interrupted attempt) stays on this page's banner.
        if (analysisRes.status === 409 && (err.current ?? err.attempt)?.state === "interrupted") {
          router.push(`/analyze/${analysisRow.id}`);
          return;
        }
        // ENT-1D D1. The stored video could not be read and nothing was
        // analysed. Uploading the same file again cannot help, so the
        // selection is cleared and the golfer chooses or records again.
        if (err.status === VIDEO_UNUSABLE_STATUS) {
          setFile(null); setPreviewUrl(null);
        }
        throw new Error(err.error ?? `Analysis failed (${analysisRes.status})`);
      }

      const { data: updatedRow } = await analysisRes.json() as { data: Record<string, unknown> };
      if (!mountedRef.current) return;
      if (identityRef.current !== generation) throw new Error(ANALYSIS_AFTER_CHANGE_MESSAGE);

      // EQ5C-D. Which report this is was decided by the database at insert and
      // returned by the server on the completed row — not by the selector the
      // golfer was looking at, not by their tier, and not by anything this page
      // inferred before submitting. A putt has no full-swing score, no
      // biomechanics and no drills, so it must never be poured into the
      // full-swing mapper below. It goes instead to the canonical family-aware
      // result page, which already owns putting rendering and its own
      // entitlement check. Strict equality: every other family keeps the
      // inline flow exactly as it was.
      if (updatedRow.analysis_family === "putting") {
        router.push(`/swings/${analysisRow.id}`);
        return;
      }

      setResult(dbRowToResult(updatedRow));

    } catch (err: unknown) {
      // fetch() rejects with a TypeError when the request never completed; its
      // text differs between browser engines.
      if (err instanceof TypeError && /Failed to fetch|NetworkError|Load failed/.test(err.message)) {
        setError(analysisStarted ? ANALYSIS_CONNECTION_LOST_MESSAGE : UPLOAD_FAILED_MESSAGE);
      } else {
        setError(golferMessage(err, analysisStarted));
      }
    } finally {
      setIsAnalyzing(false);
      analyzingRef.current = false;
    }
  };

  const setTime = (t: number) => { if (videoRef.current) videoRef.current.currentTime = t; };

  // ─── EQ4-S2 camera lifecycle ──────────────────────────────────────────────
  // Declared here, after the submission and preprocessing regions, so camera
  // code never lands inside the source slices those suites isolate.

  /** Idempotent teardown. Invalidates the generation first so any callback
   *  still in flight sees itself as stale before it can touch newer state. */
  const abandonCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    cameraDiscardRef.current = true;

    const recorder = cameraRecorderRef.current;
    cameraRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Best effort: a recorder that cannot stop must not block teardown.
      }
    }

    const stream = cameraStreamRef.current;
    cameraStreamRef.current = null;
    releaseCameraTracks(stream);
    if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
    setCameraPhase("idle");
  }, []);

  /** Releases the camera before handing a chosen file to the one file
   *  lifecycle owner, so a live stream can never outlive a file selection. */
  const handleFileReleasingCamera = useCallback(
    (f: File) => {
      abandonCamera();
      setCameraError(null);
      handleFile(f);
    },
    [abandonCamera, handleFile],
  );

  /** The ONLY place this page calls getUserMedia. Reached exclusively from the
   *  golfer tapping Record with Camera — never from an effect, a club change,
   *  hydration, hover or focus. */
  const startCameraCapture = useCallback(async () => {
    setCameraError(null);

    const mediaDevices =
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    const canOpenCamera = typeof mediaDevices?.getUserMedia === "function";
    const canRecord = typeof MediaRecorder !== "undefined";

    // Capability is settled BEFORE any request, so an unusable browser never
    // prompts the golfer for a permission that could not be acted on.
    if (!hasCameraRecordingCapability({ getUserMedia: canOpenCamera, mediaRecorder: canRecord })) {
      setCameraError(
        canOpenCamera ? CAMERA_RECORDING_UNAVAILABLE_MESSAGE : CAMERA_UNSUPPORTED_MESSAGE,
      );
      return;
    }

    setCameraPhase("starting");
    const requestId = ++cameraRequestRef.current;
    cameraDiscardRef.current = false;

    let stream: MediaStream;
    try {
      stream = await mediaDevices!.getUserMedia(CAMERA_CAPTURE_CONSTRAINTS);
    } catch (err) {
      // Only the exception NAME is read. The message never reaches the golfer.
      const rawName = (err as { name?: unknown } | null)?.name;
      if (cameraRequestRef.current === requestId) {
        setCameraError(
          classifyCameraStartError(typeof rawName === "string" ? rawName : undefined),
        );
        setCameraPhase("idle");
      }
      return;
    }

    // The golfer may have cancelled or unmounted while the prompt was open.
    if (cameraRequestRef.current !== requestId) {
      releaseCameraTracks(stream);
      return;
    }

    // isTypeSupported is itself feature-detected: calling it blindly would
    // throw on a browser that exposes MediaRecorder without it.
    if (typeof MediaRecorder.isTypeSupported !== "function") {
      releaseCameraTracks(stream);
      setCameraError(CAMERA_RECORDING_UNAVAILABLE_MESSAGE);
      setCameraPhase("idle");
      return;
    }

    const supportedMime = selectCameraRecorderMimeType(
      MediaRecorder.isTypeSupported.bind(MediaRecorder),
    );
    if (supportedMime === null) {
      releaseCameraTracks(stream);
      setCameraError(CAMERA_RECORDING_UNAVAILABLE_MESSAGE);
      setCameraPhase("idle");
      return;
    }

    cameraStreamRef.current = stream;
    setCameraPhase("ready");
  }, []);

  const startCameraRecording = useCallback(() => {
    const stream = cameraStreamRef.current;
    if (!stream) return;

    const releaseAsUnrecordable = () => {
      cameraStreamRef.current = null;
      releaseCameraTracks(stream);
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
      setCameraError(CAMERA_RECORDING_UNAVAILABLE_MESSAGE);
      setCameraPhase("idle");
    };

    if (
      typeof MediaRecorder === "undefined" ||
      typeof MediaRecorder.isTypeSupported !== "function"
    ) {
      releaseAsUnrecordable();
      return;
    }

    const selectedMime = selectCameraRecorderMimeType(
      MediaRecorder.isTypeSupported.bind(MediaRecorder),
    );
    if (selectedMime === null) {
      releaseAsUnrecordable();
      return;
    }

    const requestId = cameraRequestRef.current;
    cameraDiscardRef.current = false;
    const chunks: BlobPart[] = [];

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: selectedMime });
    } catch {
      releaseAsUnrecordable();
      return;
    }

    // Handlers are registered before start() so no early chunk or failure can
    // arrive unobserved.
    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunks.push(e.data);
    };

    recorder.onerror = () => {
      if (cameraRequestRef.current !== requestId) return;
      cameraRequestRef.current += 1;
      cameraDiscardRef.current = true;
      if (cameraRecorderRef.current === recorder) cameraRecorderRef.current = null;
      const owned = cameraStreamRef.current;
      cameraStreamRef.current = null;
      releaseCameraTracks(owned);
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
      setCameraError(CAMERA_RECORDING_UNAVAILABLE_MESSAGE);
      setCameraPhase("idle");
    };

    recorder.onstop = () => {
      const stale =
        cameraRequestRef.current !== requestId || cameraDiscardRef.current === true;
      if (cameraRecorderRef.current === recorder) cameraRecorderRef.current = null;

      // A cancelled or superseded recording must never reach handleFile, and
      // must never disturb a newer camera session's state.
      if (stale) return;

      const owned = cameraStreamRef.current;
      cameraStreamRef.current = null;
      releaseCameraTracks(owned);
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;

      if (chunks.length === 0) {
        setCameraError(CAMERA_RECORDING_UNAVAILABLE_MESSAGE);
        setCameraPhase("idle");
        return;
      }

      const recordedMime = recorder.mimeType || selectedMime;
      const blob = new Blob(chunks, { type: recordedMime });

      // Checked here rather than in handleFile: handleFile's own rejection
      // renders in the preview branch, which is not on screen yet.
      if (blob.size > MAX_FILE_MB * 1024 * 1024) {
        setCameraError(CAMERA_RECORDING_TOO_LARGE_MESSAGE);
        setCameraPhase("idle");
        return;
      }

      const extension = cameraFileExtensionForMime(recordedMime);
      const recordedFile = new File(
        [blob],
        `swingpro-camera-${Date.now()}.${extension}`,
        { type: recordedMime, lastModified: Date.now() },
      );

      setCameraError(null);
      setCameraPhase("idle");
      // The existing file lifecycle owner. No parallel preview, upload,
      // database write or analysis call happens on stop.
      handleFile(recordedFile);
    };

    // start() can throw synchronously — a track that ended between
    // construction and here, or an invalid state. Ownership and the recording
    // phase are therefore claimed only once it has actually returned, so a
    // throw cannot strand a live stream behind a UI that says "Recording".
    try {
      recorder.start();
    } catch {
      cameraRequestRef.current += 1;
      cameraDiscardRef.current = true;
      if (cameraRecorderRef.current === recorder) cameraRecorderRef.current = null;
      releaseAsUnrecordable();
      return;
    }

    cameraRecorderRef.current = recorder;
    setCameraPhase("recording");
  }, [handleFile]);

  const stopCameraRecording = useCallback(() => {
    const recorder = cameraRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    try {
      recorder.stop();
    } catch {
      // A stop() that throws may never fire onstop, so finalizing would stand
      // forever. Fail closed here instead: discard first so any late callback
      // from this recorder cannot hand off, then release and return to idle.
      cameraRequestRef.current += 1;
      cameraDiscardRef.current = true;
      if (cameraRecorderRef.current === recorder) cameraRecorderRef.current = null;
      const owned = cameraStreamRef.current;
      cameraStreamRef.current = null;
      releaseCameraTracks(owned);
      if (cameraPreviewRef.current) cameraPreviewRef.current.srcObject = null;
      setCameraError(CAMERA_RECORDING_UNAVAILABLE_MESSAGE);
      setCameraPhase("idle");
      return;
    }

    // Only a stop() that actually returned may claim the finalizing phase.
    setCameraPhase("finalizing");
  }, []);

  // Binds an ALREADY-OWNED stream once the camera <video> has actually
  // rendered. Never requests permission and never creates a stream: the ref is
  // not populated synchronously by setCameraPhase, so binding cannot be done
  // inline in the start handler.
  useEffect(() => {
    const element = cameraPreviewRef.current;
    if (!element) return;
    if (cameraPhase === "idle") {
      if (element.srcObject) element.srcObject = null;
      return;
    }
    const stream = cameraStreamRef.current;
    if (stream && element.srcObject !== stream) {
      element.srcObject = stream;
    }
  }, [cameraPhase]);

  // Unmount teardown. Acquires nothing; it only guarantees no camera survives
  // the page, including a getUserMedia still resolving, which will find its
  // generation stale and stop its own tracks.
  useEffect(() => {
    return () => {
      cameraRequestRef.current += 1;
      cameraDiscardRef.current = true;
      const recorder = cameraRecorderRef.current;
      cameraRecorderRef.current = null;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Best effort during teardown.
        }
      }
      const stream = cameraStreamRef.current;
      cameraStreamRef.current = null;
      releaseCameraTracks(stream);
    };
  }, []);

  // A2: what the club panels' persistent status region announces
  const clubsStatus =
    savedClubs === null ? CLUBS_LOADING_MESSAGE
      : savedClubs.status === "auth_error" ? clubsNoticeMessage(clubsIssue)
        : savedClubs.status === "database_error" || savedClubs.status === "malformed_data" ? CLUBS_UNAVAILABLE_MESSAGE
          : "";

  const cameraGuidance = isPuttingCapture
    ? CAMERA_PUTTING_GUIDANCE
    : CAMERA_FULL_SWING_GUIDANCE;

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col lg:h-screen lg:flex-row lg:overflow-hidden">

      {/* ── LEFT: Video workspace ── */}
      <div className="w-full lg:w-[600px] flex flex-col border-r border-white/10 bg-black flex-shrink-0 relative">

        {/* ── EQ4-S1 Mobile Club Context Panel ── */}
        <div className="lg:hidden border-b border-white/5 p-4">
          <div className="bg-golf-surface border border-white/5 rounded-3xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 bg-emerald-500/10 rounded-xl flex items-center justify-center shrink-0">
                <Target size={16} className="text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Club</p>
                <p className="text-[11px] text-gray-500">Optional — analyze with or without one</p>
              </div>
            </div>

            {/* A2: one persistent live region per panel, so every change of the clubs' state is announced */}
            <p role="status" aria-live="polite" className="sr-only">{clubsStatus}</p>
            {savedClubs === null ? (
              <p className="text-sm text-gray-400">{CLUBS_LOADING_MESSAGE}</p>
            ) : savedClubs.status === "auth_error" ? (
              <ClubsSessionNotice issue={clubsIssue} onRetry={retryClubs} />
            ) : savedClubs.status === "database_error" || savedClubs.status === "malformed_data" ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-400">{CLUBS_UNAVAILABLE_MESSAGE}</p>
                {savedClubs.status === "database_error" && (
                  <button type="button" onClick={retryClubs}
                    className="min-h-11 px-4 rounded-xl border border-white/15 text-xs font-bold text-white hover:bg-white/5">
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <ClubSelector
                clubs={savedClubs.clubs}
                selectedClubId={selectedClubId}
                onChange={setSelectedClubId}
                disabled={isAnalyzing}
                label="Club used for this swing"
              />
            )}
          </div>
        </div>

        {!previewUrl ? (
        <div className="flex-1 flex flex-col">

          {/* ENT-1D. A file refused before any preview exists (not a video,
              empty) is explained here; the page banner below renders only
              inside the preview. */}
          {error && (
            <div role="alert" className="m-4 mb-0 bg-red-500/10 border border-red-500/40 p-3 rounded-xl flex items-start gap-2">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-white">{error}</p>
            </div>
          )}

          {/* ── EQ4-S2 Mobile camera capture ── */}
          {/* Hidden by default; shown only where the primary pointer is coarse
              and cannot hover. That is an input-capability test, not a width
              test, so the first-party recorder stays available on the
              touch-operated acceptance fixtures regardless of viewport width.
              Ordinary fine/hovering pointer presentation stays camera-free.
              No UA sniffing, JavaScript viewport detection, or device-specific
              width exception is used.
              Sibling of the import label, never a descendant of it: a button
              inside that label would be ambiguous markup and could open the
              file picker instead of the camera. */}
          <div className="hidden [@media(hover:none)_and_(pointer:coarse)]:block border-b border-white/5 p-4">
            {cameraError && (
              <div className="mb-3 bg-red-500/10 border border-red-500/40 p-3 rounded-xl flex items-start gap-2">
                <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-white">{cameraError}</p>
              </div>
            )}

            {cameraPhase === "idle" ? (
              <>
                <button type="button" onClick={startCameraCapture}
                  className="w-full min-h-11 bg-golf-green text-golf-dark rounded-2xl font-black uppercase tracking-widest text-sm flex items-center justify-center gap-2">
                  <Camera size={16} />Record with Camera
                </button>
                <p className="text-[10px] text-gray-500 mt-2 text-center">
                  Up to {MAX_FILE_MB}MB
                </p>
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="relative bg-black rounded-2xl overflow-hidden aspect-video">
                  <video ref={cameraPreviewRef} autoPlay muted playsInline
                    className="w-full h-full object-cover" />
                  {/* Presentation-only safe-frame marks. They infer nothing,
                      classify nothing and persist nothing. */}
                  <div className="absolute inset-4 border border-white/25 rounded-xl pointer-events-none" />
                  {cameraPhase === "recording" && (
                    <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/70 px-2.5 py-1 rounded-full">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-white">Recording</span>
                    </div>
                  )}
                  {(cameraPhase === "starting" || cameraPhase === "finalizing") && (
                    <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="w-8 h-8 animate-spin text-golf-green" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-white">
                        {cameraPhase === "starting" ? "Starting Camera" : "Preparing Video"}
                      </p>
                    </div>
                  )}
                </div>

                <p className="text-[10px] text-gray-500 leading-relaxed">{cameraGuidance}</p>
                <p className="text-[10px] text-gray-500">Up to {MAX_FILE_MB}MB</p>

                <div className="flex flex-col gap-2">
                  {cameraPhase === "ready" && (
                    <button type="button" onClick={startCameraRecording}
                      className="w-full min-h-11 bg-golf-green text-golf-dark rounded-2xl font-black uppercase tracking-widest text-sm flex items-center justify-center gap-2">
                      <Camera size={16} />Start Recording
                    </button>
                  )}
                  {cameraPhase === "recording" && (
                    <button type="button" onClick={stopCameraRecording}
                      className="w-full min-h-11 bg-red-500 text-white rounded-2xl font-black uppercase tracking-widest text-sm flex items-center justify-center gap-2">
                      <Square size={14} />Stop Recording
                    </button>
                  )}
                  <button type="button" onClick={abandonCamera}
                    className="w-full min-h-11 bg-white/5 text-gray-300 border border-white/10 rounded-2xl font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-2">
                    <X size={14} />{cameraPhase === "recording" || cameraPhase === "finalizing" ? "Cancel / Discard" : "Cancel"}
                  </button>
                  {/* Import stays reachable throughout. Choosing a file first
                      abandons the camera, so no stream survives the handoff. */}
                  <label className="w-full min-h-11 bg-white/5 text-gray-300 border border-white/10 rounded-2xl font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-golf-green">
                    {/* sr-only, not hidden: a display:none input is unreachable by keyboard. */}
                    <input type="file" accept="video/*" className="sr-only" onKeyDown={openFileChooserOnEnter}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileReleasingCamera(f); }} />
                    <Upload size={14} />Choose Video Instead
                  </label>
                </div>
              </div>
            )}
          </div>

          {cameraPhase === "idle" && (
          <label className="flex-1 flex flex-col items-center justify-center cursor-pointer hover:bg-white/5 transition-colors group p-8 text-center focus-within:ring-2 focus-within:ring-inset focus-within:ring-golf-green">
            {/* sr-only, not hidden: a display:none input is unreachable by keyboard. */}
            <input type="file" accept="video/*" className="sr-only" onKeyDown={openFileChooserOnEnter}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            <div className="w-20 h-20 bg-white/5 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-golf-green/10 transition-colors">
              <Upload className="w-10 h-10 text-gray-500 group-hover:text-golf-green transition-colors" />
            </div>
            <h3 className="text-xl font-black italic tracking-tighter text-white uppercase mb-2">
              {isPuttingCapture ? "Import Putting Stroke Video" : "Import Swing Video"}
            </h3>
            <p className="text-gray-500 text-sm max-w-xs mb-4">Up to {MAX_FILE_MB}MB — MP4, MOV, or WEBM</p>
            <div className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-left max-w-xs">
              <p className="text-[9px] text-golf-green font-black uppercase tracking-widest mb-1">Pro Tip</p>
              <p className="text-[10px] text-gray-500">
                {isPuttingCapture
                  ? "Use the trim handles in the timeline to isolate one complete putting stroke."
                  : "Use the trim handles in the timeline to isolate just the swing segment before analyzing."}
              </p>
            </div>
          </label>
          )}
        </div>
        ) : (
          <div className="flex-1 relative bg-[#050505] flex flex-col items-center justify-center overflow-hidden">
            <div className="relative max-h-[75%] max-w-full flex items-center justify-center"
              style={{ aspectRatio: videoAspect ?? "auto" }}>
              <video ref={videoRef} src={previewUrl} className="max-h-full max-w-full object-contain" playsInline />
            </div>

            {/* HUD telemetry overlay */}
            {result && (() => {
              const hasLaunchData = result.metrics.swingSpeed > 0 || result.metrics.ballSpeed > 0;
              const hudItems = [
                ...(result.metrics.swingSpeed > 0 ? [{ label: "Swing Speed", value: `${result.metrics.swingSpeed}`, unit: "MPH", color: "text-white" }] : []),
                ...(result.metrics.ballSpeed > 0  ? [{ label: "Ball Speed",  value: `${result.metrics.ballSpeed}`,  unit: "MPH", color: "text-golf-green" }] : []),
                { label: "Smash", value: result.metrics.smashFactor.toFixed(2), unit: "", color: "text-amber-400" },
              ];
              return (
                <div className="absolute top-4 left-4 z-30">
                  <div className="bg-black/70 backdrop-blur-md border border-white/10 px-5 py-3 rounded-2xl flex items-center gap-5 shadow-2xl">
                    {hasLaunchData ? hudItems.map((m, i) => (
                      <div key={i} className="text-center">
                        <p className="text-[8px] text-gray-500 font-black uppercase tracking-widest mb-0.5">{m.label}</p>
                        <p className={`text-lg font-black italic ${m.color}`}>{m.value}<span className="text-[9px] text-gray-600 ml-0.5">{m.unit}</span></p>
                      </div>
                    )) : (
                      <span className="text-[9px] font-black uppercase tracking-widest text-gray-600">No Launch Monitor</span>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Error banner */}
            {error && (
              <div className="absolute top-16 left-4 right-4 z-50">
                <div role="alert" className="bg-red-500/10 border border-red-500/40 backdrop-blur-xl p-4 rounded-xl flex items-start gap-3">
                  <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-white">{error}</p>
                  <button onClick={() => setError(null)} aria-label="Dismiss message"
                    className="ml-auto -my-3 -mr-3 shrink-0 flex items-center justify-center min-w-11 min-h-11 text-gray-500 hover:text-white">
                    <X size={16} />
                  </button>
                </div>
              </div>
            )}

            {/* Loading overlay */}
            {(isAnalyzing || isTrimming) && (
              <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center text-white z-50">
                <Loader2 className="w-14 h-14 animate-spin text-golf-green mb-6" />
                <h3 className="text-2xl font-black italic tracking-tighter uppercase mb-2">
                  {isTrimming ? "COMPRESSING CLIP" : "ANALYZING SWING"}
                </h3>
                <p className="text-gray-500 text-sm max-w-xs text-center">
                  {isTrimming ? "Trimming and compressing video in-browser..." : "Gemini AI computing launch telemetry and biomechanics..."}
                </p>
              </div>
            )}

            {/* Action bar */}
            {!isAnalyzing && !isTrimming && (
              <div className="absolute bottom-4 left-4 right-4 z-40">
                {!result ? (
                  isPuttingCapture && !canUsePuttingAnalysis(userTier) ? (
                    /* Deliberately inert: no click handler, no alternative execution
                       path, no navigation. Putting analysis exists — this golfer's
                       plan does not include it, and the server would refuse the
                       same request for the same reason. */
                    /* ENT-1D: labelled as a state, not an action — while new
                       memberships are paused there is no upgrade to offer. */
                    <div className="w-full">
                      <button type="button" disabled
                        className="w-full py-4 bg-white/5 text-gray-500 border border-white/10 rounded-2xl font-black uppercase tracking-widest flex items-center justify-center gap-3 cursor-not-allowed">
                        <Lock size={18} />PUTTING NOT IN YOUR PLAN
                      </button>
                      <p className="mt-2 text-center text-[11px] text-gray-300 bg-black/70 rounded-xl px-3 py-2">
                        Putting analysis is included with Birdie and Eagle.
                        {!CHECKOUT_AVAILABLE && " New memberships are temporarily paused."}
                      </p>
                    </div>
                  ) : (
                    /* One executable action for an entitled putt and for a full
                       swing alike: the same submission, the same server, the same
                       database-authored routing. Only the label differs. */
                    <button onClick={startAnalysis}
                      className="w-full py-4 bg-golf-green text-golf-dark rounded-2xl font-black uppercase tracking-widest hover:bg-[#22C55E] transition-all flex items-center justify-center gap-3 shadow-[0_0_30px_rgba(74,222,128,0.3)]">
                      <Target size={18} />{isPuttingCapture ? "RUN PUTTING ANALYSIS" : "RUN ANALYZER"}
                    </button>
                  )
                ) : (
                  <div className="bg-black/80 backdrop-blur-md border border-white/10 p-4 rounded-2xl flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 size={20} className="text-golf-green" />
                      <div>
                        <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest">Status</p>
                        <p className="text-sm text-white font-bold">Analysis Complete</p>
                      </div>
                    </div>
                    <button onClick={() => { setFile(null); setPreviewUrl(null); setResult(null); }}
                      className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold text-white">
                      NEW VIDEO
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Timeline Scrubber ── */}
        <div className="h-28 bg-golf-header border-t border-white/10 px-6 flex flex-col justify-center">
          {previewUrl && duration > 0 ? (
            <>
              <div className="flex justify-between text-[10px] font-mono font-black text-gray-500 mb-2">
                <span>{trimStart.toFixed(2)}s</span>
                <span className="text-golf-green">{(trimEnd - trimStart).toFixed(2)}s Selected</span>
                <span>{trimEnd.toFixed(2)}s</span>
              </div>
              <div className="relative h-10 bg-gray-900 rounded-lg border border-white/5 flex items-center">
                {/* Selected region */}
                <div className="absolute h-full bg-golf-green/10 border-x-2 border-golf-green rounded-sm"
                  style={{ left: `${(trimStart / duration) * 100}%`, width: `${((trimEnd - trimStart) / duration) * 100}%` }} />
                {/* Playhead */}
                <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)] z-20 pointer-events-none"
                  style={{ left: `${(currentTime / duration) * 100}%` }} />
                {/* Trim start slider */}
                <input type="range" min={0} max={duration} step={0.01}
                  value={trimStart} disabled={isAnalyzing || isTrimming}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (v < trimEnd - 0.2) { setTrimStart(v); setTime(v); } }}
                  className="trim-slider absolute inset-0 w-full z-10" />
                {/* Trim end slider */}
                <input type="range" min={0} max={duration} step={0.01}
                  value={trimEnd} disabled={isAnalyzing || isTrimming}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (v > trimStart + 0.2) { setTrimEnd(v); setTime(v); } }}
                  className="trim-slider absolute inset-0 w-full z-10" />
              </div>
            </>
          ) : (
            <p className="text-center text-[10px] text-gray-700 font-black uppercase tracking-widest">Timeline Scrubber Idle</p>
          )}
        </div>
      </div>

      {/* ── RIGHT: Results deck ── */}
      <div className="flex-1 bg-[#12140F] overflow-y-auto">

        {/* ── Club Context Panel ── */}
        <div className="hidden lg:block border-b border-white/5 p-4">
          <div className="bg-golf-surface border border-white/5 rounded-3xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 bg-emerald-500/10 rounded-xl flex items-center justify-center shrink-0">
                <Target size={16} className="text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Club</p>
                <p className="text-[11px] text-gray-500">Optional — analyze with or without one</p>
              </div>
            </div>

            {/* A2: one persistent live region per panel, so every change of the clubs' state is announced */}
            <p role="status" aria-live="polite" className="sr-only">{clubsStatus}</p>
            {savedClubs === null ? (
              <p className="text-sm text-gray-400">{CLUBS_LOADING_MESSAGE}</p>
            ) : savedClubs.status === "auth_error" ? (
              <ClubsSessionNotice issue={clubsIssue} onRetry={retryClubs} />
            ) : savedClubs.status === "database_error" || savedClubs.status === "malformed_data" ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-400">{CLUBS_UNAVAILABLE_MESSAGE}</p>
                {savedClubs.status === "database_error" && (
                  <button type="button" onClick={retryClubs}
                    className="min-h-11 px-4 rounded-xl border border-white/15 text-xs font-bold text-white hover:bg-white/5">
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <ClubSelector
                clubs={savedClubs.clubs}
                selectedClubId={selectedClubId}
                onChange={setSelectedClubId}
                disabled={isAnalyzing}
                label="Club used for this swing"
              />
            )}
          </div>
        </div>

        {/* ── Launch Monitor Panel ── */}
        {/* Hidden only while capturing a putting stroke: launch-monitor
            telemetry has no meaning for a putt. Entitlement behaviour below is
            untouched — this hides the surface, it never grants or revokes it. */}
        {!isPuttingCapture && (
        <div className="border-b border-white/5 p-4">
          {canUseLaunchMonitor(userTier) ? (
            <div className="bg-golf-surface border border-white/5 rounded-3xl p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 bg-blue-500/10 rounded-xl flex items-center justify-center shrink-0">
                  <BarChart2 size={16} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-blue-400">Launch Monitor Data</p>
                  <p className="text-[10px] text-gray-600">CSV or JSON — TrackMan, Garmin, FlightScope, Rapsodo</p>
                </div>
                {lmFile && (
                  <button onClick={() => setLmFile(null)} className="ml-auto text-gray-600 hover:text-white">
                    <X size={14} />
                  </button>
                )}
              </div>
              {lmFile ? (
                <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-3 py-2">
                  <FileUp size={14} className="text-blue-400 shrink-0" />
                  <p className="text-xs text-blue-300 truncate">{lmFile.name}</p>
                  <span className="text-[9px] font-mono text-blue-500 ml-auto">
                    {(lmFile.size / 1024).toFixed(0)} KB
                  </span>
                </div>
              ) : (
                <label className="flex items-center gap-2 border border-dashed border-white/10 rounded-xl px-4 py-3 cursor-pointer hover:border-blue-500/30 transition-colors focus-within:ring-2 focus-within:ring-golf-green">
                  <Upload size={14} className="text-gray-600" />
                  <span className="text-[10px] text-gray-600 font-bold uppercase tracking-widest">
                    Attach launch data (optional)
                  </span>
                  <input type="file" accept=".csv,.json" className="sr-only" onKeyDown={openFileChooserOnEnter}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) setLmFile(f); }} />
                </label>
              )}
            </div>
          ) : (
            /* Par locked preview */
            <div className="bg-black/40 border border-white/5 rounded-3xl p-5 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent" />
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-3">
                  <Lock size={14} className="text-gray-500" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                    Launch Monitor Upload — Locked
                  </p>
                  <span className="ml-auto text-[9px] font-black uppercase tracking-widest text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
                    Birdie+
                  </span>
                </div>
                <p className="text-xs text-gray-600 mb-4 leading-relaxed">
                  Connect TrackMan, Garmin, FlightScope, or Rapsodo data.
                  AI fuses your launch metrics with video biomechanics for precision coaching.
                </p>
                <div className="grid grid-cols-2 gap-1.5 mb-4">
                  {["Club Speed","Ball Speed","Launch Angle","Spin Rate","Club Path","Face Angle","Attack Angle","Carry Yards"].map((m) => (
                    <div key={m} className="flex items-center gap-1.5 opacity-40">
                      <div className="w-1 h-1 rounded-full bg-blue-400" />
                      <span className="text-[9px] text-gray-500 font-bold">{m}</span>
                    </div>
                  ))}
                </div>
                <Link href="/upgrade"
                  className="flex items-center justify-center gap-2 w-full min-h-11 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-blue-400 hover:bg-blue-500/20 transition-colors">
                  <Zap size={12} />
                  {CHECKOUT_AVAILABLE ? "Upgrade to Birdie to Unlock" : "Included with Birdie · See plans"}
                </Link>
              </div>
            </div>
          )}
        </div>
        )}

        {!result ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-12">
            <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center mb-6">
              <Activity size={28} className="text-gray-600" />
            </div>
            <h3 className="text-xl font-black italic tracking-tighter text-white uppercase mb-2">Awaiting Session</h3>
            <p className="text-gray-600 text-sm max-w-xs">
              {isPuttingCapture
                ? "Upload your putting stroke video and trim to one complete stroke. Putting analysis is available on eligible plans."
                : "Upload your swing video, trim to the impact zone, then hit Run Analyzer."}
            </p>
          </div>
        ) : (
          <div className="p-6 space-y-6 pb-16">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em]">Live Mechanics Report</p>
              <div className="flex items-center gap-2">
                {/* ENT-1D: no plan badge. The page knows only the stored tier,
                    not whether the membership is current, and every plan gets
                    the same full-swing analysis, so a badge could only
                    mislabel (a free account was labelled with a paid plan). */}
              </div>
            </div>

            {/* Par upsell banner */}
            {result._mode === "basic" && (
              <div className="bg-gradient-to-r from-golf-green/5 to-blue-500/5 border border-white/10 rounded-2xl p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-1">Membership Plans</p>
                  <p className="text-xs text-gray-500">AI putting analysis is included with Birdie and Eagle.</p>
                  {!CHECKOUT_AVAILABLE && (
                    <p className="text-xs text-gray-500 mt-1">New memberships are temporarily paused.</p>
                  )}
                </div>
                <Link href="/upgrade"
                  className="shrink-0 inline-flex items-center min-h-11 px-4 py-2 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all whitespace-nowrap">
                  View Plans
                </Link>
              </div>
            )}

            {/* Score + status */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-golf-surface p-6 rounded-2xl border border-golf-green/20">
                <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-2">Swing Score</p>
                {result.score !== null ? (
                  <p className="text-5xl font-black italic text-white">{result.score}</p>
                ) : (
                  <p className="text-2xl font-black uppercase tracking-widest text-gray-400">{UNSCORED_LABEL}</p>
                )}
                <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                  {result.score !== null ? SCORE_BASIS : UNSCORED_COPY}
                </p>
                {result.scoring_breakdown && (
                  <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                    <span className="font-black uppercase tracking-widest text-gray-600">Scoring Math: </span>
                    {result.scoring_breakdown}
                  </p>
                )}
              </div>
              <div className="bg-golf-surface p-6 rounded-2xl border border-white/5">
                <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-2">Fault Tags</p>
                <div className="space-y-1">
                  {result.weakSpots.slice(0, 3).map((w, i) => (
                    <p key={i} className="text-[10px] text-gray-400 font-bold">· {w}</p>
                  ))}
                </div>
              </div>
            </div>

            {/* AI feedback */}
            <div className="p-5 bg-golf-green/5 border border-golf-green/20 rounded-2xl">
              <div className="flex items-center gap-2 mb-3">
                <Info size={14} className="text-golf-green" />
                <span className="text-[9px] font-black text-golf-green uppercase tracking-widest">{ASSESSMENT_LABEL}</span>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{result.feedback}</p>
            </div>

            {/* Launch telemetry */}
            <div>
              <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em] mb-3">Launch Telemetry</p>
              {result.metrics.swingSpeed === 0 && result.metrics.ballSpeed === 0 ? (
                <div className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <Activity size={14} className="text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-gray-600">Launch Monitor Data Not Connected</p>
                    <p className="text-[10px] text-gray-700 mt-0.5">Connect a TrackMan, FlightScope, or compatible device to capture velocity and launch data.</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ...(result.metrics.swingSpeed > 0 ? [{ label: "Swing Velocity", value: result.metrics.swingSpeed, unit: "MPH", color: "text-white" }] : []),
                    ...(result.metrics.ballSpeed  > 0 ? [{ label: "Ball Velocity",  value: result.metrics.ballSpeed,  unit: "MPH", color: "text-golf-green" }] : []),
                    { label: "Launch Angle",  value: `${result.metrics.launchAngle}°`,       unit: "", color: "text-blue-400" },
                    { label: "Smash Factor",  value: result.metrics.smashFactor.toFixed(2),  unit: "", color: "text-amber-400" },
                  ].map((m, i) => (
                    <div key={i} className="bg-golf-surface p-4 rounded-xl border border-white/5">
                      <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-1">{m.label}</p>
                      <p className={`text-2xl font-black italic ${m.color}`}>{m.value}<span className="text-[10px] text-gray-600 ml-1">{m.unit}</span></p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Drills */}
            <div>
              <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em] mb-3">Prescribed Corrective Drills</p>
              <div className="space-y-4">
                {result.drills.map((drill, i) => (
                  <div key={i} className="p-5 bg-golf-surface rounded-2xl border border-white/5 hover:border-golf-green/30 transition-all">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-golf-green/10 rounded-xl flex items-center justify-center text-golf-green">
                          <Play size={16} />
                        </div>
                        <h4 className="font-black text-white">{drill.name}</h4>
                      </div>
                      <button onClick={() => setActiveDrillVideo(drill.videoUrl)}
                        className="p-1.5 hover:bg-white/5 rounded-lg text-gray-500 hover:text-white">
                        <Maximize2 size={14} />
                      </button>
                    </div>
                    {drill.videoUrl && (
                      <div className="aspect-video rounded-xl overflow-hidden bg-black/40 mb-4 border border-white/5">
                        <iframe src={`${formatYt(drill.videoUrl)}?rel=0`} className="w-full h-full" allowFullScreen />
                      </div>
                    )}
                    <div className="space-y-3">
                      <div><p className="text-[9px] font-black text-golf-green uppercase tracking-widest mb-0.5">The Why</p><p className="text-xs text-gray-400">{drill.why}</p></div>
                      <div><p className="text-[9px] font-black text-blue-400 uppercase tracking-widest mb-0.5">The How</p><p className="text-xs text-gray-300">{drill.how}</p></div>
                      <div><p className="text-[9px] font-black text-amber-400 uppercase tracking-widest mb-0.5">The Feel</p><p className="text-xs text-gray-300 italic">"{drill.feel}"</p></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Drill video modal */}
      {activeDrillVideo && (
        <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4">
          <button onClick={() => setActiveDrillVideo(null)}
            className="absolute top-6 right-6 w-10 h-10 bg-white/10 rounded-full flex items-center justify-center text-white hover:bg-white/20">
            <X size={20} />
          </button>
          <div className="w-full max-w-4xl aspect-video bg-black rounded-3xl overflow-hidden border border-white/10">
            <iframe src={`${formatYt(activeDrillVideo)}?autoplay=1`} className="w-full h-full" allowFullScreen />
          </div>
        </div>
      )}

    </div>
  );
}
