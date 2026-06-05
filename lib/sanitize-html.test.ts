import { describe, it, expect } from "vitest";
import { sanitizeAnalysisHtml } from "./sanitize-html";

describe("sanitizeAnalysisHtml — hostile input is neutralized", () => {
  it("strips <script> elements and their contents", () => {
    const out = sanitizeAnalysisHtml(`<script>stealCookies()</script><p>safe</p>`);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("stealCookies");
    expect(out).toBe("<p>safe</p>");
  });

  it("removes inline event-handler attributes (onload/onerror/onclick)", () => {
    const out = sanitizeAnalysisHtml(
      `<p onclick="alert(1)">click</p><body onload="evil()">x</body>`
    );
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>click</p>");
  });

  it("neutralizes <img onerror> payloads", () => {
    const out = sanitizeAnalysisHtml(`<img src=x onerror=alert(1)>`);
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain("<img");
    expect(out).toBe("");
  });

  it("drops javascript: href links but keeps the visible text", () => {
    const out = sanitizeAnalysisHtml(`<a href="javascript:alert(1)">link</a>text`);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a");
    expect(out).toBe("linktext");
  });

  it("removes <style>, <iframe>, <svg>, <object> blocks entirely", () => {
    const out = sanitizeAnalysisHtml(
      `<style>*{x}</style><iframe src="evil"></iframe>` +
        `<svg onload="x"></svg><object data="evil"></object><p>kept</p>`
    );
    expect(out).toBe("<p>kept</p>");
  });

  it("strips ALL attributes from otherwise-allowed tags", () => {
    const out = sanitizeAnalysisHtml(
      `<p class="leak" style="color:red" data-x="1">text</p>`
    );
    expect(out).toBe("<p>text</p>");
  });

  it("removes HTML comments (can hide conditional-comment payloads)", () => {
    const out = sanitizeAnalysisHtml(`<!--[if IE]><script>x</script><![endif]--><p>ok</p>`);
    expect(out).not.toContain("<!--");
    expect(out).toContain("<p>ok</p>");
  });

  it("handles null / undefined / empty input safely", () => {
    expect(sanitizeAnalysisHtml(null)).toBe("");
    expect(sanitizeAnalysisHtml(undefined)).toBe("");
    expect(sanitizeAnalysisHtml("")).toBe("");
  });
});

describe("sanitizeAnalysisHtml — safe structural tags pass through", () => {
  it("preserves the allow-listed formatting tags", () => {
    const input =
      `<h4>Transition</h4>` +
      `<p>The <strong>pelvis</strong> leads and the <em>shoulders</em> follow.</p>` +
      `<ul><li>lag stored</li><li>late release</li></ul>`;
    const out = sanitizeAnalysisHtml(input);
    expect(out).toBe(
      `<h4>Transition</h4>` +
        `<p>The <strong>pelvis</strong> leads and the <em>shoulders</em> follow.</p>` +
        `<ul><li>lag stored</li><li>late release</li></ul>`
    );
  });

  it("keeps text content when wrapping tags are disallowed", () => {
    const out = sanitizeAnalysisHtml(`<div><span>kinetic chain</span></div>`);
    expect(out).toBe("kinetic chain");
  });

  it("normalizes <br> to a self-closing, attribute-free tag", () => {
    const out = sanitizeAnalysisHtml(`line1<br class="x">line2`);
    expect(out).toBe("line1<br/>line2");
  });

  it("represents a realistic AI prose_summary unchanged", () => {
    const realistic =
      `<h4>Impact</h4><p>Clubface is <strong>6° open</strong> due to the cupped ` +
      `lead wrist carried from the top.</p><ul><li>Square the face earlier</li></ul>`;
    const out = sanitizeAnalysisHtml(realistic);
    expect(out).toBe(realistic);
  });
});
