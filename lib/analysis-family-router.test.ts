import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyAnalysisFamilyRoute } from "./analysis-family-router";

/**
 * EQ5A — SERVER ANALYSIS ROUTER.
 *
 * Part A executes the pure classifier directly. Part B is static/structural: it
 * reads the route source and asserts a contract. It does NOT import or execute
 * the route handler, does NOT read process.env, and contacts nothing.
 *
 * The routing value is public.swing_analysis.analysis_family, written only by
 * apply_swing_analysis_equipment_snapshot() on INSERT and immutable afterwards.
 * It cannot come from the request, and these tests exist to keep it that way.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so no assertion here
 *  depends on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const ANALYZE_API = "app/api/analyze-swing/route.ts";
const apiSource = readSource(ANALYZE_API);

/**
 * The POST handler body only.
 *
 * Ordering assertions must compare execution sites, not declarations. The file
 * header docblock names extractSwingMetrics(), and fetchVideoBytes() is defined
 * as a module helper — both appear long before the handler runs. Slicing to the
 * handler removes those, leaving exactly one occurrence of each anchor.
 */
const handlerSource = (() => {
  const start = apiSource.indexOf("export async function POST(");
  if (start < 0) throw new Error("POST handler not found in the Analyze API route");
  return apiSource.slice(start);
})();

/** Index of `needle` in the handler, failing the test if it is absent. */
function anchor(needle: string): number {
  const index = handlerSource.indexOf(needle);
  expect(index, `missing handler anchor: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** The RequestBody interface body, so a ban applies to the client contract
 *  rather than to the whole route. */
const requestBodySource = (() => {
  const start = apiSource.indexOf("interface RequestBody {");
  if (start < 0) throw new Error("RequestBody interface not found");
  const end = apiSource.indexOf("\n}", start);
  if (end < 0) throw new Error("RequestBody interface is unterminated");
  return apiSource.slice(start, end);
})();

/** Every line carrying a console call. The route's console calls are each on a
 *  single line, so a line scan is sufficient and needs no paren parsing. */
const consoleLines = apiSource
  .split("\n")
  .filter((line) => line.includes("console."));

const PUTTING_COPY =
  "Putting analysis is coming soon. To avoid an incorrect full-swing report, this video can't be analyzed yet.";
const UNSUPPORTED_COPY = "Analysis failed. Please try again.";

// ─── PART A — the pure classifier ────────────────────────────────────────────

describe("EQ5A analysis-family router — pure classification", () => {
  it("routes a full_swing family to the existing full-swing pipeline", () => {
    expect(classifyAnalysisFamilyRoute("full_swing")).toBe("full_swing_pipeline");
  });

  /**
   * A literal null is a deliberately persisted state: the snapshot producer
   * nulls the family whenever club_id is null, and the equipment-context
   * constraint permits that exact all-null row. Analyzing without a club is a
   * shipping capability, so it must keep reaching the full-swing pipeline.
   */
  it("routes a literal null family to full swing as the no-club compatibility case", () => {
    expect(classifyAnalysisFamilyRoute(null)).toBe("full_swing_pipeline");
  });

  it("routes a putting family to the pre-EQ5B unavailable branch", () => {
    expect(classifyAnalysisFamilyRoute("putting")).toBe("putting_unavailable");
  });

  /**
   * undefined means the expected field was absent from the runtime row shape.
   * That proves nothing about the golfer's equipment, so it must not inherit
   * the no-club allowance.
   */
  it("fails closed when the family field is missing from the row", () => {
    expect(classifyAnalysisFamilyRoute(undefined)).toBe("unsupported_family");
  });

  it("fails closed on a plausible but unrecognized family", () => {
    expect(classifyAnalysisFamilyRoute("chip")).toBe("unsupported_family");
  });

  it("fails closed on a case variant rather than normalizing it", () => {
    expect(classifyAnalysisFamilyRoute("FULL_SWING")).toBe("unsupported_family");
  });

  it("fails closed on an empty string", () => {
    expect(classifyAnalysisFamilyRoute("")).toBe("unsupported_family");
  });

  it("fails closed on a number", () => {
    expect(classifyAnalysisFamilyRoute(0)).toBe("unsupported_family");
  });

  it("fails closed on a boolean", () => {
    expect(classifyAnalysisFamilyRoute(false)).toBe("unsupported_family");
  });

  it("fails closed on an object", () => {
    expect(classifyAnalysisFamilyRoute({ analysis_family: "full_swing" })).toBe(
      "unsupported_family",
    );
  });

  it("fails closed on an array", () => {
    expect(classifyAnalysisFamilyRoute(["full_swing"])).toBe("unsupported_family");
  });

  /**
   * The regression this test exists for: a loose-equality or falsy check would
   * collapse null and undefined and silently send a malformed row into Gemini
   * full-swing analysis. They must classify differently, permanently.
   */
  it("never treats a missing field as equivalent to a persisted null", () => {
    expect(classifyAnalysisFamilyRoute(null)).not.toBe(
      classifyAnalysisFamilyRoute(undefined),
    );
    expect(classifyAnalysisFamilyRoute(null)).toBe("full_swing_pipeline");
    expect(classifyAnalysisFamilyRoute(undefined)).toBe("unsupported_family");
  });
});

// ─── PART B — the route source contract ──────────────────────────────────────

describe("EQ5A analysis-family router — Analyze API source contract", () => {
  it("imports the pure classifier from the shared helper", () => {
    expect(apiSource).toContain(
      'import { classifyAnalysisFamilyRoute } from "@/lib/analysis-family-router";',
    );
  });

  it("classifies the database-authored family from the owned row", () => {
    expect(apiSource).toContain(
      "classifyAnalysisFamilyRoute(analysisRow.analysis_family)",
    );
    // Exactly one read: the classifier argument. Nothing else in the route may
    // touch the field, which is what keeps it out of logs and writes below.
    expect(apiSource.split("analysisRow.analysis_family")).toHaveLength(2);
  });

  it("authenticates and proves ownership before it routes", () => {
    const owned = anchor('.eq("user_id", user.id)');
    const notFound = anchor('{ error: "Analysis record not found." }');
    const router = anchor("classifyAnalysisFamilyRoute(analysisRow.analysis_family)");
    expect(owned).toBeLessThan(notFound);
    expect(notFound).toBeLessThan(router);
  });

  it("routes before the row-status diagnostic", () => {
    expect(anchor("classifyAnalysisFamilyRoute(analysisRow.analysis_family)")).toBeLessThan(
      anchor('console.log("[analyze-swing] row status:", analysisRow.status)'),
    );
  });

  /**
   * A completed putting row must not emit a warning claiming Gemini is being
   * re-run while the router is in fact refusing it before Gemini.
   */
  it("routes before the complete-row rerun warning", () => {
    expect(anchor("classifyAnalysisFamilyRoute(analysisRow.analysis_family)")).toBeLessThan(
      anchor("re-running Gemini to refresh"),
    );
  });

  it("routes before the first row mutation", () => {
    expect(anchor("classifyAnalysisFamilyRoute(analysisRow.analysis_family)")).toBeLessThan(
      anchor('status: "processing"'),
    );
  });

  it("refuses putting with the fixed pre-EQ5B copy and a 503", () => {
    const branch = anchor('analysisRoute === "putting_unavailable"');
    const rest = handlerSource.slice(branch);
    expect(rest).toContain("{ error: PUTTING_ANALYSIS_UNAVAILABLE_MESSAGE }");
    expect(rest.slice(0, 400)).toContain("{ status: 503 }");
    expect(apiSource).toContain(PUTTING_COPY);
  });

  it("refuses an unsupported family with the fixed generic copy and a 500", () => {
    const branch = anchor('analysisRoute === "unsupported_family"');
    const rest = handlerSource.slice(branch);
    expect(rest).toContain(`{ error: "${UNSUPPORTED_COPY}" }`);
    expect(rest.slice(0, 400)).toContain("{ status: 500 }");
  });

  /**
   * Both refusals must precede every full-swing execution site, not merely the
   * database write: no Gemini credential lookup, no biometric merge, no signed
   * URL, no video download, no model call.
   */
  it("refuses before every full-swing execution anchor", () => {
    const putting = anchor('analysisRoute === "putting_unavailable"');
    const unsupported = anchor('analysisRoute === "unsupported_family"');
    for (const site of [
      "process.env.GEMINI_API_KEY",
      "extractSwingMetrics(",
      "createSignedUrl(",
      "await fetchVideoBytes(",
      "generateContent(",
    ]) {
      const at = anchor(site);
      expect(putting, `putting refusal must precede ${site}`).toBeLessThan(at);
      expect(unsupported, `unsupported refusal must precede ${site}`).toBeLessThan(at);
    }
  });

  /**
   * Scoped to the interface, not the whole route: the server legitimately reads
   * the persisted family, but the client may never name it.
   */
  it("gives the request body no routing authority", () => {
    expect(requestBodySource).toContain("analysisId: string;");
    for (const field of [
      "analysis_family",
      "swing_category",
      "club_id",
      "club_type",
      "isPutting",
      "selectedPutter",
      "equipment_snapshot",
    ]) {
      expect(
        requestBodySource,
        `RequestBody must not accept ${field}`,
      ).not.toContain(field);
    }
  });

  it("never writes the immutable equipment routing context", () => {
    expect(apiSource).not.toContain("club_id");
    expect(apiSource).not.toContain("equipment_snapshot");
    // A write would appear as an object property; the read never does.
    expect(apiSource).not.toContain("analysis_family:");
    expect(apiSource).toContain("analysisRow.analysis_family");
  });

  it("keeps the family out of the logs and the existing pipeline intact", () => {
    for (const line of consoleLines) {
      expect(line, "a console call must not carry the family value").not.toContain(
        "analysisRow.analysis_family",
      );
      expect(line, "a console call must not carry the route binding").not.toContain(
        "analysisRoute",
      );
    }
    expect(apiSource).toContain(
      'console.error("[analyze-swing] unsupported analysis family")',
    );
    // Neither fixed response names a family, a value, or an identifier.
    for (const copy of [PUTTING_COPY, UNSUPPORTED_COPY]) {
      expect(copy).not.toContain("analysis_family");
      expect(copy).not.toContain("full_swing");
      expect(copy).not.toContain("putting_unavailable");
    }
    expect(apiSource).toContain('model: "gemini-2.5-flash"');
    expect(apiSource).toContain("SYSTEM_INSTRUCTION");
    expect(apiSource).toContain("RESPONSE_SCHEMA");
    expect(apiSource).toContain("temperature: 0.0");
    expect(apiSource).toContain("maxOutputTokens: 8192");
  });
});
