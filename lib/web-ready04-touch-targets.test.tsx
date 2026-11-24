import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * AG-WEB-READY-04 F1-T — the ten controls measured under 44 px in the S1-R1 staging run (and the other Goals step
 * controls) carry a 44 px minimum hit area on the interactive element itself. This is a source-level semantic guard of
 * the exact elements (their labels, targets and behaviour stay as they were); the actual rendered sizes are measured in a
 * real browser at 390×844 and 1280×800 (F1 evidence), because a class name is not a measurement.
 */
const ROOT = path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const dashboard = read("app/(dashboard)/dashboard/page.tsx");
const telemetry = read("app/(dashboard)/telemetry/page.tsx");
const goals = read("app/(dashboard)/goals/GoalsForm.tsx");
const tokens = (cls: string) => new Set(cls.split(/\s+/).filter(Boolean));

/** The className of the one element whose opening tag matches `open` and whose own text is `label`. */
function classOf(src: string, open: RegExp, label: RegExp): string {
  const matches = Array.from(src.matchAll(new RegExp(`${open.source}[^>]*?className="([^"]*)"[^>]*>([\\s\\S]*?)</`, "g")))
    .filter((m) => label.test(m[2].replace(/<[^>]*>/g, "").trim()));
  expect(matches.length, `${open} ${label}`).toBe(1);
  return matches[0][1];
}

describe("F1-T: measured controls have a 44 px minimum hit area on the element itself", () => {
  it("Progress Hub: Analyze Swing, Filter and the empty-state Upload First Swing", () => {
    const analyze = tokens(classOf(dashboard, /<Link\s+href="\/analyze"\s+/, /^Analyze Swing$/));
    expect(analyze.has("min-h-11")).toBe(true);
    const upload = tokens(classOf(dashboard, /<Link\s+href="\/analyze"\s+/, /^Upload First Swing$/));
    for (const t of ["min-h-11", "inline-flex", "items-center"]) expect(upload.has(t), t).toBe(true);
    const filter = tokens(classOf(dashboard, /<button type="button"\s+/, /^Filter$/));
    for (const t of ["min-h-11", "min-w-11", "inline-flex", "items-center"]) expect(filter.has(t), t).toBe(true);
  });

  it("the Filter button gains no behaviour (no handler, no new function)", () => {
    const tag = dashboard.match(/<button type="button" className="[^"]*">\s*<Filter size=\{12\} \/>\s*Filter\s*<\/button>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).not.toMatch(/onClick|href|formAction/);
  });

  it("Telemetry: Range, Analyze and the empty-state Start Range Session and Upload First Swing", () => {
    const headerRange = telemetry.match(/<Link href="\/range" className="([^"]*)">[\s\S]*?Range\s*<\/Link>/);
    const headerAnalyze = telemetry.match(/<Link href="\/analyze" className="([^"]*)">[\s\S]*?Analyze\s*<\/Link>/);
    expect(headerRange).not.toBeNull();
    expect(headerAnalyze).not.toBeNull();
    expect(tokens(headerRange![1]).has("min-h-11")).toBe(true);
    expect(tokens(headerAnalyze![1]).has("min-h-11")).toBe(true);
    const start = tokens(classOf(telemetry, /<Link href="\/range"\s+/, /^Start Range Session$/));
    const upload = tokens(classOf(telemetry, /<Link href="\/analyze"\s+/, /^Upload First Swing$/));
    for (const t of ["min-h-11", "inline-flex", "items-center"]) {
      expect(start.has(t), t).toBe(true);
      expect(upload.has(t), t).toBe(true);
    }
  });

  it("Goals: every step's Back, Next / Generate My Plan and the miss options", () => {
    const back = goals.match(/<button\s+type="button"\s+onClick=\{\(\) => \{ setError\(null\); setStep\(\(s\) => s - 1\); \}\}\s+disabled=\{isPending\}\s+className="([^"]*)"/);
    expect(back).not.toBeNull();
    for (const t of ["min-h-11", "min-w-11"]) expect(tokens(back![1]).has(t), t).toBe(true);
    const next = goals.match(/<button\s+type="button"\s+onClick=\{nextStep\}\s+disabled=\{isPending\}\s+className="([^"]*)"/);
    expect(next).not.toBeNull();
    expect(tokens(next![1]).has("min-h-11")).toBe(true);
    const miss = goals.match(/onClick=\{\(\) => setPrimaryMiss\(miss\)\}\s+className=\{`([^`$]*)\$\{/);
    expect(miss).not.toBeNull();
    expect(tokens(miss![1]).has("min-h-11")).toBe(true);
    // the outcome link was already 44 px; unchanged
    expect(goals).toContain('className="mt-4 inline-flex items-center justify-center min-h-11 min-w-11 px-5 rounded-xl');
  });

  it("labels and destinations are unchanged", () => {
    expect(dashboard).toMatch(/<Target size=\{14\} \/>\s*Analyze Swing\s*<\/Link>/);
    expect(telemetry).toContain(">Start Range Session</Link>");
    expect(telemetry).toContain(">Upload First Swing</Link>");
    expect(goals).toContain('"Generate My Plan"');
  });
});
