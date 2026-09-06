/**
 * EQ4-S2 — pure camera-capture policy for the mobile Analyze recorder.
 *
 * Everything here is a pure function or a frozen constant. Nothing in this
 * module touches the camera: it never calls getUserMedia, never holds a
 * MediaStream or MediaRecorder, owns no React state, and performs no network,
 * storage or database work. The Analyze page owns every side effect; this
 * module only answers questions about policy.
 *
 * The split exists so the decisions that are easy to get quietly wrong —
 * container support, file extension, and how a DOMException name becomes
 * golfer-facing copy — are exercised directly by unit tests rather than
 * inferred from page source.
 */

/**
 * Recorder containers in preference order.
 *
 * Support genuinely differs between browsers, so the choice is feature
 * detected rather than assumed. The Analyze preprocessing path hard-codes
 * `video/webm` because it can fall back to returning the original file; a
 * camera recording has no such fallback, so guessing here would mean a
 * recording that simply never starts.
 */
export const CAMERA_RECORDER_MIME_CANDIDATES: readonly string[] = [
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * Fixed golfer-facing copy. Every message names the file-import alternative,
 * because import always remains available, and none of them repeat browser
 * error text back to the golfer.
 */
export const CAMERA_UNSUPPORTED_MESSAGE =
  "Camera recording isn't available in this browser. Choose a video from your device instead.";

export const CAMERA_PERMISSION_DENIED_MESSAGE =
  "Camera access is off. Allow camera access in your browser settings, or choose a video instead.";

export const CAMERA_START_FAILED_MESSAGE =
  "We couldn't start the camera. Close other apps using it or choose a video instead.";

export const CAMERA_RECORDING_UNAVAILABLE_MESSAGE =
  "This browser can open the camera but can't record video here. Choose a video instead.";

export const CAMERA_RECORDING_TOO_LARGE_MESSAGE =
  "This recording is over the 250MB limit. Record a shorter video or choose a video instead.";

/**
 * Both capabilities are required before the camera action may run. A browser
 * that can open a camera but cannot record is not a usable capture path, and
 * asking for permission first would prompt the golfer for nothing.
 */
export function hasCameraRecordingCapability(detect: {
  getUserMedia: boolean;
  mediaRecorder: boolean;
}): boolean {
  return detect.getUserMedia === true && detect.mediaRecorder === true;
}

/**
 * First supported candidate, or null when none is supported.
 *
 * The support predicate is injected so this stays pure and testable: the page
 * passes a bound `MediaRecorder.isTypeSupported`. Returning null is a real
 * outcome the caller must handle by releasing the camera — never by falling
 * back to an unlisted container.
 */
export function selectCameraRecorderMimeType(
  isTypeSupported: (mime: string) => boolean
): string | null {
  for (const candidate of CAMERA_RECORDER_MIME_CANDIDATES) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Extension for a selected recorder MIME. Only ever called with a MIME that
 * `selectCameraRecorderMimeType` returned, so the two supported families are
 * exhaustive; webm is the residual branch rather than a guess about unknown
 * containers.
 */
export function cameraFileExtensionForMime(mime: string): "mp4" | "webm" {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

/**
 * Maps a DOMException NAME — never its message — to fixed copy.
 *
 * Only the name is accepted as input, so raw browser text cannot reach the
 * golfer even by accident. Anything unrecognised, including undefined, is
 * treated as a start failure: that message is accurate for an unknown fault
 * and still points at the working alternative.
 */
export function classifyCameraStartError(errorName: string | undefined): string {
  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return CAMERA_PERMISSION_DENIED_MESSAGE;
  }
  return CAMERA_START_FAILED_MESSAGE;
}
