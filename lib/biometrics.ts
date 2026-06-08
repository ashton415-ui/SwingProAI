/**
 * lib/biometrics.ts
 *
 * Geometric utilities for extracting biomechanical metrics from MediaPipe Pose
 * landmark arrays, and the main extractSwingMetrics() pipeline.
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure math (calcSpineAngle, calcShoulderRotation, calcHipRotation)
 *   → no browser APIs, safe to import in any environment, unit-testable
 *
 * extractSwingMetrics(videoUrl)
 *   → browser-only (HTMLVideoElement + CanvasElement + @mediapipe/pose WASM)
 *   → use dynamic import so SSR/API routes never load the WASM bundle
 *   → returns null fields on any error or timeout — DB writes never crash
 *
 * Key frame heuristics
 *   Setup:          8% of video duration
 *   Top of swing:  38% of video duration
 *   Impact:        55% of video duration
 *
 *   These are good approximations for a standard range-recording style.
 *   Replace with pose-sequence peak-detection if higher accuracy is needed.
 *
 * Coordinate conventions (MediaPipe Pose normalized landmarks)
 *   x → 0 = left edge, 1 = right edge of frame
 *   y → 0 = top edge,  1 = bottom edge  (y INCREASES downward)
 *   z → depth relative to mid-hip, normalized by hip width
 *       negative = closer to camera, positive = further from camera
 *       MediaPipe estimates z from a monocular video — useful for rotation
 *       but has higher uncertainty than x/y.
 */

// ── MediaPipe landmark indices we need ───────────────────────────────────────

const LM = {
  LEFT_SHOULDER:  11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP:       23,
  RIGHT_HIP:      24,
} as const;

const RAD_TO_DEG = 180 / Math.PI;

// ── Minimal type that matches MediaPipe's NormalizedLandmark ─────────────────
// Declared locally so the pure-math functions don't pull in @mediapipe/pose
// at the module level — safe for SSR / API routes.

export interface PoseLandmark {
  x: number;          // 0–1, left→right
  y: number;          // 0–1, top→bottom
  z: number;          // depth (monocular estimate, normalized by hip width)
  visibility?: number; // 0–1, confidence that the landmark is visible
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface FrameMetrics {
  /** Degrees from vertical (0 = perfectly upright, 40 = typical address tilt). */
  spineAngle: number | null;
  /** Degrees of horizontal shoulder turn relative to frontal plane (z-axis differential). */
  shoulderRotation: number | null;
  /** Degrees of horizontal hip turn relative to frontal plane (z-axis differential). */
  hipRotation: number | null;
  /** Mean visibility of the four key landmarks [0–1]. Flags when landmarks are occluded. */
  landmarkVisibility: number;
}

export interface SwingMetrics {
  setup:      FrameMetrics;
  topOfSwing: FrameMetrics;
  impact:     FrameMetrics;

  // ── Canonical per-swing values used for DB storage ──────────────────────
  /** Spine angle at Setup — most representative for address posture. */
  spineAngle:        number | null;
  /** Shoulder turn at Top of Swing — maximum backswing rotation. */
  shoulderRotation:  number | null;
  /** Hip rotation at Impact — how much the hips have cleared through the ball. */
  hipRotation:       number | null;
  /**
   * Tempo ratio string in "X:1" format.
   * Derived from the timing between setup → top → impact if reliable timestamps
   * are available; null when the estimate is below the confidence threshold.
   */
  tempoRatio: string | null;
}

// ── Pure geometry — server-safe, unit-testable ───────────────────────────────

function midpoint(a: PoseLandmark, b: PoseLandmark): PoseLandmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/**
 * Spine angle: angle of the mid-shoulder → mid-hip vector from the image
 * vertical (gravity direction).
 *
 * In image coords y increases downward, so the "upward" direction from hip
 * to shoulder has negative dy.  We flip the sign so dy is always positive,
 * then compute atan2(|dx|, dy) — the tilt from vertical in degrees.
 *
 * Face-on view  → lateral tilt dominates
 * Down-the-line → forward tilt dominates
 * Either way the reported angle quantifies how far the spine deviates from
 * a true vertical column, which is the clinically relevant number.
 */
export function calcSpineAngle(landmarks: PoseLandmark[]): number | null {
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];

  if (!ls || !rs || !lh || !rh) return null;

  // Reject if any key landmark is poorly visible
  const minVis = Math.min(
    ls.visibility ?? 1,
    rs.visibility ?? 1,
    lh.visibility ?? 1,
    rh.visibility ?? 1,
  );
  if (minVis < 0.4) return null;

  const shoulder = midpoint(ls, rs);
  const hip      = midpoint(lh, rh);

  // dy: hip.y > shoulder.y (hip is lower in frame), so this is positive
  const dy = hip.y - shoulder.y;
  const dx = shoulder.x - hip.x;

  if (dy <= 0) return null; // degenerate: landmarks inverted

  const angle = Math.atan2(Math.abs(dx), dy) * RAD_TO_DEG;
  return Math.round(angle * 10) / 10;
}

/**
 * Shoulder rotation: the angle the shoulder line makes with the frontal plane,
 * derived from the z-depth differential between left and right shoulders.
 *
 * When z_right − z_left ≈ 0 → shoulders square to camera (no rotation).
 * As the golfer turns, one shoulder moves toward the camera (−z) and the other
 * moves away (+z).  The lateral width (x-component) acts as the adjacent side.
 *
 * rotation = atan2( |Δz| , |Δx| )  in degrees
 *
 * MediaPipe z accuracy: sufficient for detecting gross rotation (±30° easily
 * detectable); sub-5° precision requires a stereo camera or structured light.
 */
export function calcShoulderRotation(landmarks: PoseLandmark[]): number | null {
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];

  if (!ls || !rs) return null;

  const minVis = Math.min(ls.visibility ?? 1, rs.visibility ?? 1);
  if (minVis < 0.4) return null;

  const dz = rs.z - ls.z; // depth differential
  const dx = rs.x - ls.x; // lateral width in image plane

  if (Math.abs(dx) < 0.01) return null; // shoulders too close — unreliable

  const angle = Math.atan2(Math.abs(dz), Math.abs(dx)) * RAD_TO_DEG;
  return Math.round(angle * 10) / 10;
}

/**
 * Hip rotation: same geometry as shoulder rotation, applied to the hip joints.
 *
 * For a right-handed golfer at address, hips are square.  At impact the hips
 * should show ~45–55° of open rotation toward the target.
 */
export function calcHipRotation(landmarks: PoseLandmark[]): number | null {
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];

  if (!lh || !rh) return null;

  const minVis = Math.min(lh.visibility ?? 1, rh.visibility ?? 1);
  if (minVis < 0.4) return null;

  const dz = rh.z - lh.z;
  const dx = rh.x - lh.x;

  if (Math.abs(dx) < 0.01) return null;

  const angle = Math.atan2(Math.abs(dz), Math.abs(dx)) * RAD_TO_DEG;
  return Math.round(angle * 10) / 10;
}

/**
 * Extract all three metrics for a single landmark set.
 */
export function computeFrameMetrics(landmarks: PoseLandmark[]): FrameMetrics {
  const visibilities = [
    landmarks[LM.LEFT_SHOULDER]?.visibility  ?? 0,
    landmarks[LM.RIGHT_SHOULDER]?.visibility ?? 0,
    landmarks[LM.LEFT_HIP]?.visibility       ?? 0,
    landmarks[LM.RIGHT_HIP]?.visibility      ?? 0,
  ];
  const landmarkVisibility =
    visibilities.reduce((a, b) => a + b, 0) / visibilities.length;

  return {
    spineAngle:        calcSpineAngle(landmarks),
    shoulderRotation:  calcShoulderRotation(landmarks),
    hipRotation:       calcHipRotation(landmarks),
    landmarkVisibility: Math.round(landmarkVisibility * 1000) / 1000,
  };
}

// ── Null-safe frame metrics ───────────────────────────────────────────────────

function nullFrame(): FrameMetrics {
  return { spineAngle: null, shoulderRotation: null, hipRotation: null, landmarkVisibility: 0 };
}

// ── Tempo estimation ─────────────────────────────────────────────────────────

/**
 * Estimates backswing-to-downswing tempo ratio from frame timestamps.
 *
 * backswingDuration = time(topOfSwing) − time(setup)
 * downswingDuration = time(impact)    − time(topOfSwing)
 *
 * Returns "X.X:1" string rounded to one decimal (e.g. "3.0:1", "2.5:1").
 * Returns null when timestamps are identical or the ratio is implausible.
 */
export function estimateTempoRatio(
  setupMs: number,
  topMs: number,
  impactMs: number,
): string | null {
  const backswing  = topMs    - setupMs;
  const downswing  = impactMs - topMs;

  if (downswing <= 0 || backswing <= 0) return null;

  const ratio = backswing / downswing;

  // Sanity check: physiologically plausible range is ~1.5:1 to 5:1
  if (ratio < 1.5 || ratio > 5) return null;

  return `${ratio.toFixed(1)}:1`;
}

// ── Browser-only: video processing pipeline ──────────────────────────────────

// Per-frame seek timeout — generous to handle slow mobile connections
const SEEK_TIMEOUT_MS   = 5_000;
// Per-frame pose inference timeout
const POSE_TIMEOUT_MS   = 8_000;
// Total cap for the entire extractSwingMetrics call
const PIPELINE_TIMEOUT_MS = 45_000;

/**
 * Seek an HTMLVideoElement to `targetSeconds` and resolve when the seek lands.
 * Rejects after SEEK_TIMEOUT_MS to prevent hanging on a stalled stream.
 */
async function seekTo(video: HTMLVideoElement, targetSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Seek to ${targetSeconds}s timed out`)),
      SEEK_TIMEOUT_MS,
    );

    const onSeeked = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };

    video.addEventListener("seeked", onSeeked);
    video.currentTime = targetSeconds;
  });
}

/**
 * Run MediaPipe Pose on a single canvas frame.
 * Uses a closure that resolves the next result and ignores subsequent ones.
 */
async function detectPoseInFrame(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pose: any,
  canvas: HTMLCanvasElement,
): Promise<PoseLandmark[] | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[biometrics] pose inference timed out — skipping frame");
      resolve(null);
    }, POSE_TIMEOUT_MS);

    let settled = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pose.onResults((results: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(results?.poseLandmarks ?? null);
    });

    pose.send({ image: canvas }).catch((err: unknown) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        console.warn("[biometrics] pose.send error:", err);
        resolve(null);
      }
    });
  });
}

/**
 * extractSwingMetrics — browser-only entry point.
 *
 * Loads @mediapipe/pose via CDN WASM, seeks the video to three heuristic
 * key frames (Setup / Top of Swing / Impact), runs Pose on each frame,
 * and returns computed biomechanical metrics.
 *
 * Always returns a SwingMetrics object — individual fields are null when
 * landmarks are missing, the pose model fails, or a timeout fires.
 * This guarantees that callers can always write the result to the DB without
 * a try/catch on their end.
 *
 * @param videoUrl - Absolute or relative URL playable by HTMLVideoElement.
 *                   Must be CORS-accessible from the current origin.
 */
export async function extractSwingMetrics(videoUrl: string): Promise<SwingMetrics> {
  const empty: SwingMetrics = {
    setup:           nullFrame(),
    topOfSwing:      nullFrame(),
    impact:          nullFrame(),
    spineAngle:      null,
    shoulderRotation: null,
    hipRotation:     null,
    tempoRatio:      null,
  };

  // Guard: must be running in a browser
  if (typeof window === "undefined" || typeof document === "undefined") {
    console.warn("[biometrics] extractSwingMetrics called outside browser — returning empty");
    return empty;
  }

  // Wrap the entire pipeline in a global timeout
  return Promise.race([
    runPipeline(videoUrl, empty),
    new Promise<SwingMetrics>((resolve) =>
      setTimeout(() => {
        console.warn(`[biometrics] pipeline exceeded ${PIPELINE_TIMEOUT_MS}ms — returning partial results`);
        resolve(empty);
      }, PIPELINE_TIMEOUT_MS),
    ),
  ]);
}

async function runPipeline(videoUrl: string, empty: SwingMetrics): Promise<SwingMetrics> {
  let video: HTMLVideoElement | null   = null;
  let canvas: HTMLCanvasElement | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pose: any = null;

  try {
    // ── 1. Dynamically import @mediapipe/pose (browser WASM — never SSR) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mp = await import("@mediapipe/pose").catch((err) => {
      console.warn("[biometrics] failed to import @mediapipe/pose:", err);
      return null;
    }) as any;

    if (!mp?.Pose) {
      console.warn("[biometrics] @mediapipe/pose unavailable — returning empty metrics");
      return empty;
    }

    pose = new mp.Pose({
      locateFile: (file: string) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
    });

    pose.setOptions({
      modelComplexity:    1,     // 0=lite, 1=full, 2=heavy
      smoothLandmarks:    false, // no smoothing across frames — we want single-frame precision
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5,
    });

    // ── 2. Load the video (no autoplay, muted to allow seeking cross-origin) ──
    video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted       = true;
    video.preload     = "metadata";
    video.src         = videoUrl;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Video metadata load timed out")),
        10_000,
      );
      video!.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
      video!.onerror          = () => { clearTimeout(timeout); reject(new Error("Video load error")); };
    });

    const duration = video.duration;
    if (!duration || !isFinite(duration) || duration <= 0) {
      console.warn("[biometrics] invalid video duration:", duration);
      return empty;
    }

    // ── 3. Set up an offscreen canvas ──────────────────────────────────────
    canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn("[biometrics] failed to get 2D canvas context");
      return empty;
    }

    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 360;

    // ── 4. Process three key frames ────────────────────────────────────────
    const keyFrames = [
      { name: "setup",      pct: 0.08 },
      { name: "topOfSwing", pct: 0.38 },
      { name: "impact",     pct: 0.55 },
    ] as const;

    const frameData: Record<string, { landmarks: PoseLandmark[] | null; timestamp: number }> = {};

    for (const { name, pct } of keyFrames) {
      const targetTime = duration * pct;
      console.log(`[biometrics] seeking to ${name} @ ${targetTime.toFixed(2)}s`);

      try {
        await seekTo(video, targetTime);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const landmarks = await detectPoseInFrame(pose, canvas);

        frameData[name] = {
          landmarks,
          timestamp: targetTime * 1000, // convert to ms for tempo calculation
        };

        if (landmarks) {
          console.log(`[biometrics] ${name}: detected ${landmarks.length} landmarks`);
        } else {
          console.warn(`[biometrics] ${name}: no landmarks detected`);
        }
      } catch (seekErr) {
        console.warn(`[biometrics] ${name} seek/detect error:`, seekErr);
        frameData[name] = { landmarks: null, timestamp: targetTime * 1000 };
      }
    }

    // ── 5. Compute per-frame metrics ───────────────────────────────────────
    const setup      = frameData.setup.landmarks      ? computeFrameMetrics(frameData.setup.landmarks)      : nullFrame();
    const topOfSwing = frameData.topOfSwing.landmarks ? computeFrameMetrics(frameData.topOfSwing.landmarks) : nullFrame();
    const impact     = frameData.impact.landmarks     ? computeFrameMetrics(frameData.impact.landmarks)     : nullFrame();

    // ── 6. Derive canonical single-swing values ────────────────────────────
    const tempoRatio = estimateTempoRatio(
      frameData.setup.timestamp,
      frameData.topOfSwing.timestamp,
      frameData.impact.timestamp,
    );

    const result: SwingMetrics = {
      setup,
      topOfSwing,
      impact,
      spineAngle:       setup.spineAngle,          // address tilt
      shoulderRotation: topOfSwing.shoulderRotation, // max backswing rotation
      hipRotation:      impact.hipRotation,          // impact hip clearance
      tempoRatio,
    };

    console.log("[biometrics] pipeline complete:", {
      spineAngle:       result.spineAngle,
      shoulderRotation: result.shoulderRotation,
      hipRotation:      result.hipRotation,
      tempoRatio:       result.tempoRatio,
    });

    return result;

  } catch (err) {
    // Catch-all: any uncaught error returns the empty result so DB writes proceed
    console.error("[biometrics] pipeline error:", err instanceof Error ? err.message : err);
    return empty;
  } finally {
    // ── Cleanup — always runs, even if we threw ────────────────────────────
    try { if (pose) await pose.close(); } catch { /* ignore */ }
    if (video) { video.src = ""; video.load(); }
    canvas = null;
    video  = null;
  }
}
