/**
 * SwingProAI — minimal, dependency-free HTML sanitizer for AI-generated prose.
 *
 * The Gemini prose_summary.html is UNTRUSTED model output. Before it is stored
 * or rendered via dangerouslySetInnerHTML it must be sanitized. This runs
 * server-side (no DOM), so we use a strict allow-list strategy:
 *
 *   1. Remove entire dangerous elements + their contents (script/style/etc).
 *   2. Drop every tag not on a tiny formatting allow-list.
 *   3. Strip ALL attributes from surviving tags — this neutralizes
 *      `onerror=`, `href="javascript:"`, `style=`, etc. in one move.
 *
 * With no attributes permitted and no script/style/iframe tags, the XSS surface
 * is effectively closed for the allowed formatting tags.
 *
 * NOTE: For richer needs (links, classes), swap this for a vetted library such
 * as `sanitize-html` or `isomorphic-dompurify` rather than widening this allowlist.
 */

const ALLOWED_TAGS = new Set([
  "h4",
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "br",
]);

// Elements whose entire contents must be discarded, not just the tags.
const FORBIDDEN_BLOCKS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "svg",
  "math",
];

export function sanitizeAnalysisHtml(input: string | null | undefined): string {
  if (!input) return "";

  let html = String(input);

  // 1. Strip dangerous elements along with their inner content.
  for (const tag of FORBIDDEN_BLOCKS) {
    const block = new RegExp(`<${tag}[\\s\\S]*?>[\\s\\S]*?<\\/${tag}>`, "gi");
    html = html.replace(block, "");
    // Also kill any unclosed/self-closing remnants of these tags.
    html = html.replace(new RegExp(`<\\/?${tag}[^>]*>`, "gi"), "");
  }

  // 2. Remove HTML comments (can hide conditional-comment payloads).
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Walk every remaining tag: keep allow-listed ones with NO attributes,
  //    drop everything else (the tag markup, not the visible text).
  html = html.replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return ""; // drop disallowed tag markup
    const isClosing = match.startsWith("</");
    if (isClosing) return `</${name}>`;
    const isSelfClosing = name === "br";
    return isSelfClosing ? `<${name}/>` : `<${name}>`; // attributes stripped
  });

  return html.trim();
}
