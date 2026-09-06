import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAMERA_PERMISSION_DENIED_MESSAGE,
  CAMERA_RECORDER_MIME_CANDIDATES,
  CAMERA_RECORDING_TOO_LARGE_MESSAGE,
  CAMERA_RECORDING_UNAVAILABLE_MESSAGE,
  CAMERA_START_FAILED_MESSAGE,
  CAMERA_UNSUPPORTED_MESSAGE,
  cameraFileExtensionForMime,
  classifyCameraStartError,
  hasCameraRecordingCapability,
  selectCameraRecorderMimeType,
} from "@/lib/analyze-camera-capture";

/**
 * EQ4-S2 — mobile camera capture.
 *
 * TWO KINDS OF COVERAGE, AND THEY PROVE VERY DIFFERENT THINGS.
 *
 * BEHAVIOURAL (describe block A). The pure policy helper is executed directly:
 * MIME preference, extension mapping, capability gating and error
 * classification are real function calls with real inputs.
 *
 * STRUCTURAL (describe blocks B–E). Everything about the Analyze page is a
 * source-contract assertion. This repository has no jsdom and no browser
 * harness, so these tests CANNOT execute the page, cannot open a camera, and
 * cannot prove any runtime behaviour. In particular they do NOT prove that
 * permission is requested only on tap, that MediaStream tracks actually stop,
 * that a late getUserMedia is really discarded, or that no network call
 * happens on recording stop. They prove only that the source still has the
 * shape those guarantees depend on.
 *
 * REAL ANDROID CHROME AND REAL iOS/iPadOS SAFARI ACCEPTANCE REMAINS MANDATORY,
 * including the camera indicator turning off after both a successful handoff
 * and a cancel/abandon. A green run here is not evidence of camera behaviour.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ANALYZE_PAGE = "app/(dashboard)/analyze/page.tsx";
const analyzeSource = readSource(ANALYZE_PAGE);

/** The camera lifecycle region, isolated from the pre-existing canvas
 *  preprocessing recorder so that `new MediaRecorder` in getTrimmedBlob can
 *  never accidentally satisfy a camera-capture assertion. */
function cameraLifecycleSource(): string {
  const start = analyzeSource.indexOf("// ─── EQ4-S2 camera lifecycle ─");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = analyzeSource.indexOf("// ─── Render", start);
  expect(end).toBeGreaterThan(start);
  return analyzeSource.slice(start, end);
}

/** The recorder onstop completion path, where a File is created and handed off. */
function recordingCompletionSource(): string {
  const block = cameraLifecycleSource();
  const start = block.indexOf("recorder.onstop = () => {");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = block.indexOf("cameraRecorderRef.current = recorder;", start);
  expect(end).toBeGreaterThan(start);
  return block.slice(start, end);
}

/** The mobile camera UI region. */
function cameraSurfaceSource(): string {
  const start = analyzeSource.indexOf("{/* ── EQ4-S2 Mobile camera capture ── */}");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = analyzeSource.indexOf('{cameraPhase === "idle" && (', start);
  expect(end).toBeGreaterThan(start);
  return analyzeSource.slice(start, end);
}

// ─── A. Behavioural: pure camera policy ──────────────────────────────────────

describe("EQ4-S2 camera policy — pure helper behaviour", () => {
  it("exposes the finalized recorder MIME candidates in order", () => {
    expect([...CAMERA_RECORDER_MIME_CANDIDATES]).toEqual([
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ]);
  });

  it("chooses the first supported recorder MIME", () => {
    // MP4 unsupported, VP9 supported: preference order must be honoured
    // rather than simply returning the first candidate.
    const supported = new Set(["video/webm;codecs=vp9", "video/webm"]);
    expect(selectCameraRecorderMimeType((m) => supported.has(m))).toBe(
      "video/webm;codecs=vp9",
    );
    expect(selectCameraRecorderMimeType(() => true)).toBe("video/mp4");
  });

  it("returns no recorder MIME when no candidate is supported", () => {
    expect(selectCameraRecorderMimeType(() => false)).toBeNull();
  });

  it("maps MP4 MIME to the mp4 extension", () => {
    expect(cameraFileExtensionForMime("video/mp4")).toBe("mp4");
    expect(cameraFileExtensionForMime("video/mp4;codecs=avc1")).toBe("mp4");
  });

  it("maps WebM MIME to the webm extension", () => {
    expect(cameraFileExtensionForMime("video/webm")).toBe("webm");
    expect(cameraFileExtensionForMime("video/webm;codecs=vp9")).toBe("webm");
  });

  it("classifies NotAllowedError as permission denied", () => {
    expect(classifyCameraStartError("NotAllowedError")).toBe(
      CAMERA_PERMISSION_DENIED_MESSAGE,
    );
  });

  it("classifies SecurityError as permission denied", () => {
    expect(classifyCameraStartError("SecurityError")).toBe(
      CAMERA_PERMISSION_DENIED_MESSAGE,
    );
  });

  it("classifies camera availability failures as fixed start failure", () => {
    for (const name of [
      "NotFoundError",
      "NotReadableError",
      "AbortError",
      "OverconstrainedError",
      "SomethingUnexpectedError",
      undefined,
    ]) {
      expect(classifyCameraStartError(name)).toBe(CAMERA_START_FAILED_MESSAGE);
    }
  });

  it("keeps capability and error policy fixed without exposing raw exception text", () => {
    expect(hasCameraRecordingCapability({ getUserMedia: true, mediaRecorder: true })).toBe(true);
    expect(hasCameraRecordingCapability({ getUserMedia: false, mediaRecorder: true })).toBe(false);
    expect(hasCameraRecordingCapability({ getUserMedia: true, mediaRecorder: false })).toBe(false);
    expect(hasCameraRecordingCapability({ getUserMedia: false, mediaRecorder: false })).toBe(false);

    // A browser message must never survive classification into golfer copy.
    const leaked = "Requested device not found: /dev/video0";
    expect(classifyCameraStartError("NotFoundError")).not.toContain(leaked);
    for (const message of [
      CAMERA_UNSUPPORTED_MESSAGE,
      CAMERA_PERMISSION_DENIED_MESSAGE,
      CAMERA_START_FAILED_MESSAGE,
      CAMERA_RECORDING_UNAVAILABLE_MESSAGE,
      CAMERA_RECORDING_TOO_LARGE_MESSAGE,
    ]) {
      expect(message).toContain("instead");
      expect(message).not.toContain("Error");
    }
  });
});

// ─── B. Structural: Analyze camera surface contract ──────────────────────────

describe("EQ4-S2 Analyze — camera surface source contract", () => {
  it("uses audio false and ideal-only camera constraints", () => {
    const start = analyzeSource.indexOf("const CAMERA_CAPTURE_CONSTRAINTS");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = analyzeSource.indexOf("};", start);
    const constraints = analyzeSource.slice(start, end);

    expect(constraints).toContain("audio: false");
    expect(constraints).toContain('facingMode: { ideal: "environment" }');
    expect(constraints).toContain("width: { ideal: 1280 }");
    expect(constraints).toContain("height: { ideal: 720 }");
    expect(constraints).toContain("frameRate: { ideal: 60 }");
    // exact/min/max would turn a preference into a request that can fail.
    expect(constraints).not.toContain("exact:");
    expect(constraints).not.toContain("min:");
    expect(constraints).not.toContain("max:");
    expect(constraints).not.toContain("deviceId");
  });

  it("requests camera only inside the explicit camera action handler", () => {
    expect(analyzeSource.match(/getUserMedia\(/g) ?? []).toHaveLength(1);
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).toContain("const startCameraCapture = useCallback(async () => {");
    const handlerStart = lifecycle.indexOf("const startCameraCapture");
    const handlerEnd = lifecycle.indexOf("const startCameraRecording", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(lifecycle.slice(handlerStart, handlerEnd)).toContain(
      "getUserMedia(CAMERA_CAPTURE_CONSTRAINTS)",
    );
  });

  it("never requests camera from effects or club-selection logic", () => {
    // Everything before the camera lifecycle region — imports, state, the
    // saved-club load, the URL hint and the whole submission path.
    const beforeCamera = analyzeSource.slice(
      0,
      analyzeSource.indexOf("// ─── EQ4-S2 camera lifecycle ─"),
    );
    expect(beforeCamera).not.toContain("getUserMedia(");
    // Scoped to CAMERA acquisition specifically: the pre-existing canvas
    // preprocessing recorder legitimately constructs a MediaRecorder earlier
    // in the file, so a bare "new MediaRecorder" ban would be false.
    expect(beforeCamera).not.toContain("CAMERA_CAPTURE_CONSTRAINTS)");
    expect(beforeCamera).not.toContain("cameraStreamRef.current = stream");

    // The two camera effects must bind or tear down, never acquire.
    const lifecycle = cameraLifecycleSource();
    const bindStart = lifecycle.indexOf("useEffect(() => {");
    expect(bindStart).toBeGreaterThanOrEqual(0);
    expect(lifecycle.slice(bindStart)).not.toContain("getUserMedia(");
  });

  it("keeps Record with Camera as a sibling of the import label", () => {
    const cameraIdx = analyzeSource.indexOf("Record with Camera");
    const labelIdx = analyzeSource.indexOf(
      '<label className="flex-1 flex flex-col items-center justify-center cursor-pointer',
    );
    expect(cameraIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeGreaterThan(cameraIdx);

    // Decisive: the import label's own body must not contain the camera action,
    // so the control cannot be a descendant that hijacks the file picker.
    const labelEnd = analyzeSource.indexOf("</label>", labelIdx);
    expect(labelEnd).toBeGreaterThan(labelIdx);
    expect(analyzeSource.slice(labelIdx, labelEnd)).not.toContain("Record with Camera");
    expect(analyzeSource.slice(labelIdx, labelEnd)).not.toContain("startCameraCapture");
  });

  it("keeps the camera surface mobile-only and desktop import camera-free", () => {
    expect(cameraSurfaceSource()).toContain("lg:hidden");
    // The desktop results deck and its Club Context panel gain no camera.
    const deckIdx = analyzeSource.indexOf('<div className="flex-1 bg-[#12140F] overflow-y-auto">');
    expect(deckIdx).toBeGreaterThanOrEqual(0);
    const deck = analyzeSource.slice(deckIdx);
    expect(deck).not.toContain("Record with Camera");
    expect(deck).not.toContain("startCameraCapture");
  });

  it("keeps existing file import available", () => {
    expect(analyzeSource).toContain('<input type="file" accept="video/*" className="hidden"');
    expect(analyzeSource).toContain("Import Swing Video");
    expect(analyzeSource).toContain("Import Putting Stroke Video");
    expect(cameraSurfaceSource()).toContain("Choose Video Instead");
  });

  it("renders the live camera preview autoPlay muted and playsInline", () => {
    const surface = cameraSurfaceSource();
    expect(surface).toContain("<video ref={cameraPreviewRef} autoPlay muted playsInline");
  });

  it("binds the live preview through srcObject after render", () => {
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).toContain("element.srcObject = stream");
    // A camera stream is bound directly; converting it to an object URL is a
    // different (and wrong) mechanism.
    expect(lifecycle).not.toContain("createObjectURL");
    expect(cameraSurfaceSource()).not.toContain("createObjectURL");
  });

  it("introduces no HTML capture attribute", () => {
    expect(analyzeSource).not.toContain('capture="');
    expect(analyzeSource).not.toContain("capture={");
  });

  it("introduces no device enumeration picker or orientation lock", () => {
    expect(analyzeSource).not.toContain("enumerateDevices");
    expect(analyzeSource).not.toContain("deviceId");
    expect(analyzeSource).not.toContain("orientation.lock");
    // No browser sniffing anywhere in the capture path.
    expect(analyzeSource).not.toContain("navigator.userAgent");
    expect(analyzeSource).not.toContain("userAgent");
  });
});

// ─── C. Structural: stream and cancellation source shape ─────────────────────

describe("EQ4-S2 Analyze — stream and cancellation source shape", () => {
  it("stops acquired camera streams through getTracks", () => {
    expect(analyzeSource).toContain("function releaseCameraTracks(stream: MediaStream | null)");
    expect(analyzeSource).toContain("for (const track of stream.getTracks())");
    expect(analyzeSource).toContain("track.stop()");

    const lifecycle = cameraLifecycleSource();
    // Every abandonment path releases: cancel, recorder failure, oversize,
    // empty output, unrecordable browser, unmount.
    expect((lifecycle.match(/releaseCameraTracks\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(lifecycle).toContain("const abandonCamera = useCallback(() => {");
    expect(lifecycle).toContain("return () => {");
  });

  it("invalidates and stops a late getUserMedia resolution", () => {
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).toContain("const requestId = ++cameraRequestRef.current;");
    expect(lifecycle).toContain("if (cameraRequestRef.current !== requestId) {");
    // A stale resolution releases the stream it was handed and stores nothing.
    const staleIdx = lifecycle.indexOf("if (cameraRequestRef.current !== requestId) {");
    const staleBlock = lifecycle.slice(staleIdx, staleIdx + 200);
    expect(staleBlock).toContain("releaseCameraTracks(stream)");
    expect(staleBlock).not.toContain("cameraStreamRef.current = stream");
  });

  it("prevents canceled recording from handing a File to handleFile", () => {
    const completion = recordingCompletionSource();
    expect(completion).toContain("cameraRequestRef.current !== requestId");
    expect(completion).toContain("cameraDiscardRef.current === true");
    // The stale guard returns before any File is constructed.
    const staleReturn = completion.indexOf("if (stale) return;");
    const fileIdx = completion.indexOf("new File(");
    expect(staleReturn).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThan(staleReturn);

    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).toContain("cameraDiscardRef.current = true;");
  });

  it("prevents recorder failure from handing a File to handleFile", () => {
    const lifecycle = cameraLifecycleSource();
    const errIdx = lifecycle.indexOf("recorder.onerror = () => {");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    const errEnd = lifecycle.indexOf("recorder.onstop = () => {", errIdx);
    expect(errEnd).toBeGreaterThan(errIdx);
    const errBlock = lifecycle.slice(errIdx, errEnd);

    expect(errBlock).not.toContain("handleFile(");
    expect(errBlock).toContain("cameraDiscardRef.current = true;");
    expect(errBlock).toContain("releaseCameraTracks(owned)");
    expect(errBlock).toContain("CAMERA_RECORDING_UNAVAILABLE_MESSAGE");
    // A stale recorder must not clear a newer one.
    expect(errBlock).toContain("if (cameraRecorderRef.current === recorder)");
  });

  it("fails closed when MediaRecorder.start throws synchronously", () => {
    // Scoped to the record-start handler only, so neither the constructor
    // try/catch, the async onerror handler, nor the pre-existing preprocessing
    // recorder can satisfy this.
    const lifecycle = cameraLifecycleSource();
    const handlerStart = lifecycle.indexOf("const startCameraRecording = useCallback(() => {");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handlerEnd = lifecycle.indexOf("const stopCameraRecording", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = lifecycle.slice(handlerStart, handlerEnd);

    // The direct start() call is guarded.
    const startIdx = handler.indexOf("recorder.start();");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const guardIdx = handler.lastIndexOf("try {", startIdx);
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    // That try must be the one wrapping start(), not the constructor's.
    expect(handler.slice(guardIdx, startIdx)).not.toContain("new MediaRecorder(");

    // Ownership and the recording phase are claimed only after start returns.
    const ownIdx = handler.indexOf("cameraRecorderRef.current = recorder;");
    const phaseIdx = handler.indexOf('setCameraPhase("recording");');
    expect(ownIdx).toBeGreaterThan(startIdx);
    expect(phaseIdx).toBeGreaterThan(startIdx);

    // The catch is a terminal fail-closed path.
    const catchBlock = handler.slice(startIdx, ownIdx);
    expect(catchBlock).toContain("cameraDiscardRef.current = true;");
    expect(catchBlock).toContain("if (cameraRecorderRef.current === recorder) cameraRecorderRef.current = null;");
    expect(catchBlock).toContain("releaseAsUnrecordable();");
    expect(catchBlock).not.toContain("handleFile(");
  });

  it("fails closed when user MediaRecorder.stop throws synchronously", () => {
    // Scoped to the explicit Stop Recording handler, so the best-effort stops
    // in abandonCamera and the unmount effect cannot satisfy this.
    const lifecycle = cameraLifecycleSource();
    const handlerStart = lifecycle.indexOf("const stopCameraRecording = useCallback(() => {");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handlerEnd = lifecycle.indexOf("useEffect(() => {", handlerStart);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = lifecycle.slice(handlerStart, handlerEnd);

    const stopIdx = handler.indexOf("recorder.stop();");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(handler.lastIndexOf("try {", stopIdx)).toBeGreaterThanOrEqual(0);

    // finalizing is claimed only after stop() actually returned, so a throw
    // cannot leave the golfer watching "Preparing Video" forever.
    const finalizingIdx = handler.indexOf('setCameraPhase("finalizing");');
    expect(finalizingIdx).toBeGreaterThan(stopIdx);

    const catchBlock = handler.slice(stopIdx, finalizingIdx);
    expect(catchBlock).toContain("cameraRequestRef.current += 1;");
    expect(catchBlock).toContain("cameraDiscardRef.current = true;");
    expect(catchBlock).toContain("if (cameraRecorderRef.current === recorder) cameraRecorderRef.current = null;");
    expect(catchBlock).toContain("releaseCameraTracks(owned)");
    expect(catchBlock).toContain("cameraPreviewRef.current.srcObject = null");
    expect(catchBlock).toContain("CAMERA_RECORDING_UNAVAILABLE_MESSAGE");
    expect(catchBlock).toContain('setCameraPhase("idle");');
    expect(catchBlock).not.toContain("handleFile(");
  });
});

// ─── D. Structural: File handoff and no-mutation contract ────────────────────

describe("EQ4-S2 Analyze — recorded File handoff performs no submission", () => {
  it("materializes successful camera output as a File", () => {
    const completion = recordingCompletionSource();
    expect(completion).toContain("const blob = new Blob(chunks, { type: recordedMime })");
    expect(completion).toContain("cameraFileExtensionForMime(recordedMime)");
    expect(completion).toContain("new File(");
    expect(completion).toContain("`swingpro-camera-${Date.now()}.${extension}`");
    expect(completion).toContain("type: recordedMime");
  });

  it("passes the successful recorded File through existing handleFile", () => {
    const completion = recordingCompletionSource();
    expect((completion.match(/handleFile\(recordedFile\)/g) ?? []).length).toBe(1);
    // The one file lifecycle owner keeps ownership: no parallel pipeline.
    expect(completion).not.toContain("setFile(");
    expect(completion).not.toContain("setPreviewUrl(");
  });

  it("performs no Supabase Storage upload when camera recording stops", () => {
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).not.toContain("supabase.storage");
    expect(lifecycle).not.toContain(".upload(");
  });

  it("performs no database insert when camera recording stops", () => {
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).not.toContain('.from("swing_videos")');
    expect(lifecycle).not.toContain('.from("swing_analysis")');
    expect(lifecycle).not.toContain(".insert(");
  });

  it("performs no analysis API call when camera recording stops", () => {
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).not.toContain('fetch("/api/analyze-swing"');
    expect(lifecycle).not.toContain("startAnalysis(");
  });

  it("shows the existing 250MB ceiling on the camera surface", () => {
    expect(analyzeSource).toContain("const MAX_FILE_MB = 250");
    const surface = cameraSurfaceSource();
    expect((surface.match(/Up to \{MAX_FILE_MB\}MB/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an oversized camera recording visibly before handleFile", () => {
    const completion = recordingCompletionSource();
    const sizeIdx = completion.indexOf("blob.size > MAX_FILE_MB * 1024 * 1024");
    const handoffIdx = completion.indexOf("handleFile(recordedFile)");
    expect(sizeIdx).toBeGreaterThanOrEqual(0);
    expect(handoffIdx).toBeGreaterThan(sizeIdx);
    expect(completion).toContain("CAMERA_RECORDING_TOO_LARGE_MESSAGE");

    // The camera error surface is separate from the page-wide error banner,
    // which only renders inside the preview branch and would be invisible here.
    expect(analyzeSource).toContain("const [cameraError, setCameraError] = useState<string | null>(null)");
    expect(cameraSurfaceSource()).toContain("{cameraError && (");
    expect(cameraSurfaceSource()).toContain("{cameraError}");
    // Never a raw browser exception.
    expect(cameraLifecycleSource()).not.toContain("err.message");
    expect(cameraLifecycleSource()).not.toContain("String(err)");
  });
});

// ─── E. Structural: Putter and equipment boundary ────────────────────────────

describe("EQ4-S2 Analyze — Putter and equipment boundaries hold", () => {
  it("allows Putter capture preparation without enabling putting analysis", () => {
    // Camera entry is not gated on club type: a Putter may record, preview and
    // trim. Nothing in the capture path consults the putting classifier.
    const lifecycle = cameraLifecycleSource();
    expect(lifecycle).not.toContain("isPuttingCapturePresentation(");
    expect(cameraSurfaceSource()).not.toContain("disabled={isPuttingCapture}");
    // Guidance copy still adapts, which is presentation only.
    expect(analyzeSource).toContain("const CAMERA_PUTTING_GUIDANCE");
    expect(analyzeSource).toContain("cameraGuidance");
  });

  it("keeps the Putter analyzer action disabled", () => {
    const branchIdx = analyzeSource.indexOf("isPuttingCapture ? (");
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    const branch = analyzeSource.slice(branchIdx, analyzeSource.indexOf(") : (", branchIdx));
    expect(branch).toContain("PUTTING ANALYSIS COMING SOON");
    expect(branch).toContain("disabled");
    expect(branch).not.toContain("onClick");
  });

  it("keeps the Putter submission guard before preprocessing Storage database and API", () => {
    const start = analyzeSource.indexOf("const startAnalysis");
    const end = analyzeSource.indexOf("const setTime", start);
    expect(end).toBeGreaterThan(start);
    const submission = analyzeSource.slice(start, end);

    const guard = submission.indexOf("isPuttingCapturePresentation(savedClubs, selectedClubId)");
    const preprocessing = submission.indexOf("await getTrimmedBlob()");
    const storage = submission.indexOf("supabase.storage");
    const videos = submission.indexOf('.from("swing_videos")');
    const analysis = submission.indexOf('.from("swing_analysis")');
    const api = submission.indexOf('fetch("/api/analyze-swing"');

    for (const idx of [guard, preprocessing, storage, videos, analysis, api]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(guard).toBeLessThan(preprocessing);
    expect(guard).toBeLessThan(storage);
    expect(guard).toBeLessThan(videos);
    expect(guard).toBeLessThan(analysis);
    expect(guard).toBeLessThan(api);
  });

  it("never writes analysis_family from the client", () => {
    expect(analyzeSource).not.toContain("analysis_family");
  });

  it("never writes equipment_snapshot from the client", () => {
    expect(analyzeSource).not.toContain("equipment_snapshot");
  });

  it("keeps selectedClubId single-owner", () => {
    expect(
      analyzeSource.match(
        /const\s+\[selectedClubId,\s*setSelectedClubId\]\s*=\s*useState<string \| null>\(null\)/g,
      ) ?? [],
    ).toHaveLength(1);
    expect(cameraLifecycleSource()).not.toContain("setSelectedClubId");
  });

  it("keeps saved-club loading single-owner", () => {
    expect(
      analyzeSource.match(/querySavedClubs\(supabase,\s*\{\s*userId:\s*clubsUserId\s*\}\)/g) ?? [],
    ).toHaveLength(1);
    expect(cameraLifecycleSource()).not.toContain("querySavedClubs");
  });

  it("preserves EQ4-S1 mobile and desktop selector placement", () => {
    const leftClass =
      "w-full lg:w-[600px] flex flex-col border-r border-white/10 bg-black flex-shrink-0 relative";
    const leftIdx = analyzeSource.indexOf(leftClass);
    const mobilePanelIdx = analyzeSource.indexOf("EQ4-S1 Mobile Club Context Panel", leftIdx);
    const cameraIdx = analyzeSource.indexOf("EQ4-S2 Mobile camera capture", leftIdx);
    expect(leftIdx).toBeGreaterThanOrEqual(0);
    expect(mobilePanelIdx).toBeGreaterThan(leftIdx);
    // Club selection still comes before capture, camera included.
    expect(cameraIdx).toBeGreaterThan(mobilePanelIdx);

    expect(analyzeSource).toContain('<div className="lg:hidden border-b border-white/5 p-4">');
    expect(analyzeSource).toContain('<div className="hidden lg:block border-b border-white/5 p-4">');
    expect(analyzeSource.match(/<ClubSelector\b/g) ?? []).toHaveLength(2);
  });
});
