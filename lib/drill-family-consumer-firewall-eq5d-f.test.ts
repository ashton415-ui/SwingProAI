/**
 * EQ5D Unit F — canonical drill-family consumer firewall.
 *
 * Unit S made public.drills.drill_family authoritative in the database (text,
 * NOT NULL, no default, CHECK full_swing | putting). It did not make the
 * application read it. Until every canonical consumer filters on the column,
 * the first putting drill inserted into the catalog would surface in the
 * full-swing drill library and be routed to the full-swing verification
 * pipeline. This suite pins the two canonical in-scope consumers:
 *
 *   app/(dashboard)/drills/page.tsx  — the drill library catalog query
 *   app/api/verify-drill/route.ts    — the per-drill verification lookup
 *
 * Positive allow-list, never negative exclusion. `.eq("drill_family",
 * "full_swing")` fails closed when a third family value is added; excluding
 * "putting" fails open. EQ5C-C separately proved that a negative SQL predicate
 * over a nullable column matches nothing at all under three-valued logic, which
 * is why the column is NOT NULL and why the application filter is positive.
 *
 * The suite reads source text rather than executing the consumers: the page is
 * a client component and the route calls Supabase and Gemini. Every claim is
 * therefore expressed as a reusable boolean predicate, and each predicate is
 * proved non-vacuous by mutating the source string in memory and asserting the
 * predicate flips to false. Nothing is written to disk.
 *
 * Deliberately out of scope: swingmaster-web/app/api/coach/ingest/route.ts is a
 * dormant nested legacy consumer excluded from the root tsconfig, and is a
 * separately deferred catalog firewall.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGE_PATH = path.join(REPO_ROOT, "app", "(dashboard)", "drills", "page.tsx");
const ROUTE_PATH = path.join(REPO_ROOT, "app", "api", "verify-drill", "route.ts");

/** The one positive family predicate every canonical consumer must carry. */
const FAMILY_PREDICATE = '.eq("drill_family", "full_swing")';

/** Reads a source file. CRLF is normalised for assertion only; no file is written. */
function readSource(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/** Index of `needle`, throwing rather than silently yielding -1. */
function indexRequired(source: string, needle: string): number {
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`required anchor absent: ${needle}`);
  return at;
}

/** The inclusive slice from `start` through the first `end` that follows it. */
function sliceBetween(source: string, start: string, end: string): string {
  const from = indexRequired(source, start);
  const to = source.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`unterminated slice: ${start} .. ${end}`);
  return source.slice(from, to + end.length);
}

/** Removes the first occurrence of `needle`, asserting it was present. */
function withoutFirst(source: string, needle: string): string {
  const at = indexRequired(source, needle);
  return source.slice(0, at) + source.slice(at + needle.length);
}

/**
 * Filter calls that would make a mutable text column the family authority.
 * `.select("id, name, ...")` is a projection, not a filter, and is unaffected.
 */
const NAME_AUTHORITY = /\.(eq|neq|in|is|like|ilike|match|filter|or)\(\s*"name"/;
const TARGET_METRIC_AUTHORITY = /\.(eq|neq|in|is|like|ilike|match|filter|or)\(\s*"target_metric"/;
const UUID_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The /drills library catalog query — exactly one statement. */
function pageCatalogQuery(source: string): string {
  return sliceBetween(source, 'supabase.from("drills")', '.order("name"),');
}

/** The verify-drill canonical lookup, from destructure through .single(). */
function verifyCatalogLookup(source: string): string {
  return sliceBetween(source, "const { data: drill, error: drillErr }", ".single();");
}

/** The verify-drill POST handler, excluding module imports and constants. */
function verifyHandler(source: string): string {
  return source.slice(indexRequired(source, "export async function POST("));
}

function hasDisclosureCopy(source: string, phrase: string): boolean {
  return stripComments(verifyHandler(source)).includes(phrase);
}

/** Every canonical-drills statement in a source, each up to its terminating semicolon. */
function canonicalDrillsStatements(source: string): string[] {
  return Array.from(source.matchAll(/\.from\("drills"\)/g)).map((match) => {
    const at = match.index ?? 0;
    const end = source.indexOf(";", at);
    return end === -1 ? source.slice(at) : source.slice(at, end + 1);
  });
}

const WRITE_OPERATIONS = [".insert(", ".upsert(", ".update(", ".delete("];

/**
 * Every downstream effect that must not be reachable before the not-found
 * boundary has returned. GOOGLE_AI_API_KEY is the fallback half of the same key
 * statement as GEMINI_API_KEY.
 */
const DOWNSTREAM_EFFECTS = [
  "GEMINI_API_KEY",
  "GOOGLE_AI_API_KEY",
  "createAdminClient()",
  ".download(",
  "fs.writeFileSync",
  "new GoogleAIFileManager(",
  "uploadFile",
  "generateContent",
  '.from("user_drills")',
];

/** True when the page catalog query is family-qualified by the column alone. */
function pageIsFamilySafe(source: string): boolean {
  const query = pageCatalogQuery(source);
  return (
    query.includes(FAMILY_PREDICATE) &&
    !NAME_AUTHORITY.test(query) &&
    !TARGET_METRIC_AUTHORITY.test(query) &&
    !UUID_LITERAL.test(query)
  );
}

/** True when the verify lookup is qualified by both drill id and family. */
function verifyIsFamilySafe(source: string): boolean {
  const lookup = verifyCatalogLookup(source);
  return (
    lookup.includes('.eq("id", drillId)') &&
    lookup.includes(FAMILY_PREDICATE) &&
    !NAME_AUTHORITY.test(lookup) &&
    !TARGET_METRIC_AUTHORITY.test(lookup) &&
    !UUID_LITERAL.test(lookup)
  );
}

/**
 * True when the family-qualified lookup and its not-found return precede every
 * downstream effect, so an out-of-family drill costs a 404 and nothing else.
 */
function verifyEffectsAreFailClosed(source: string): boolean {
  const handler = verifyHandler(source);
  const family = handler.indexOf(FAMILY_PREDICATE);
  const notFound = handler.indexOf("if (drillErr || !drill)");
  if (family === -1 || notFound === -1 || family > notFound) return false;
  const notFoundReturn = handler.indexOf("{ status: 404 }", notFound);
  if (notFoundReturn === -1) return false;
  return DOWNSTREAM_EFFECTS.every((effect) => {
    const at = handler.indexOf(effect);
    return at !== -1 && at > notFoundReturn;
  });
}

/** The whole early not-found block, used only by the in-memory mutation tests. */
function notFoundBlock(source: string): string {
  return sliceBetween(source, "if (drillErr || !drill) {", '{ status: 404 });\n  }\n');
}

const page = readSource(PAGE_PATH);
const route = readSource(ROUTE_PATH);

describe("EQ5D Unit F — /drills catalog query family firewall", () => {
  it("filters the canonical catalog on drill_family = full_swing", () => {
    expect(pageCatalogQuery(page)).toContain(FAMILY_PREDICATE);
  });

  it("uses a positive allow-list, never an exclusion of putting", () => {
    const query = pageCatalogQuery(page);
    expect(query).not.toContain('.neq("drill_family"');
    expect(query).not.toContain('"putting"');
  });

  it("does not use drill name as the family authority", () => {
    expect(NAME_AUTHORITY.test(pageCatalogQuery(page))).toBe(false);
  });

  it("does not use target_metric as the family authority", () => {
    expect(TARGET_METRIC_AUTHORITY.test(pageCatalogQuery(page))).toBe(false);
  });

  it("carries no hard-coded UUID allow-list", () => {
    expect(UUID_LITERAL.test(pageCatalogQuery(page))).toBe(false);
    expect(UUID_LITERAL.test(page)).toBe(false);
  });

  it("is family-safe as a whole", () => {
    expect(pageIsFamilySafe(page)).toBe(true);
  });
});

describe("EQ5D Unit F — verify-drill lookup family firewall", () => {
  it("requires both the drill id and the family predicate", () => {
    const lookup = verifyCatalogLookup(route);
    expect(lookup).toContain('.eq("id", drillId)');
    expect(lookup).toContain(FAMILY_PREDICATE);
  });

  it("applies the family predicate before .single()", () => {
    expect(route.indexOf(FAMILY_PREDICATE)).toBeLessThan(indexRequired(route, ".single();"));
  });

  it("does not use drill name as the family authority", () => {
    expect(NAME_AUTHORITY.test(verifyCatalogLookup(route))).toBe(false);
  });

  it("does not use target_metric as the family authority", () => {
    expect(TARGET_METRIC_AUTHORITY.test(verifyCatalogLookup(route))).toBe(false);
  });

  it("carries no hard-coded UUID allow-list", () => {
    expect(UUID_LITERAL.test(verifyCatalogLookup(route))).toBe(false);
    expect(UUID_LITERAL.test(route)).toBe(false);
  });

  it("is family-safe as a whole", () => {
    expect(verifyIsFamilySafe(route)).toBe(true);
  });
});

describe("EQ5D Unit F — verify-drill fails closed and discloses nothing", () => {
  it("keeps the pre-existing 404 contract unchanged", () => {
    expect(route).toContain(
      'return NextResponse.json({ error: "Drill not found" }, { status: 404 });',
    );
    expect(route.split('{ error: "Drill not found" }').length - 1).toBe(1);
  });

  it("adds no family-specific disclosure copy", () => {
    const disclosures = [
      "Putting verification not supported",
      "Wrong drill family",
      "Unsupported drill",
    ];
    for (const phrase of disclosures) {
      expect(hasDisclosureCopy(route, phrase)).toBe(false);
    }
  });

  it("returns 404 before every downstream effect", () => {
    expect(verifyEffectsAreFailClosed(route)).toBe(true);
  });

  it("names every downstream effect it orders, so none is silently unchecked", () => {
    const handler = verifyHandler(route);
    for (const effect of DOWNSTREAM_EFFECTS) {
      expect(handler).toContain(effect);
    }
  });
});

describe("EQ5D Unit F — full-swing verification pipeline is preserved", () => {
  it("keeps the Gemini model and response schema", () => {
    expect(route).toContain("gemini-2.5-flash");
    expect(route).toContain("VERIFICATION_SCHEMA");
    expect(route).toContain("systemInstruction");
  });

  it("keeps the frozen generation parameters", () => {
    expect(/temperature:\s*0\.0/.test(route)).toBe(true);
    expect(/maxOutputTokens:\s*512/.test(route)).toBe(true);
  });

  it("keeps temp-file cleanup and both verification outcomes", () => {
    expect(route).toContain("unlinkSync");
    expect(route).toContain('"verified"');
    expect(route).toContain('"needs_work"');
  });
});

describe("EQ5D Unit F — scope firewall", () => {
  it("performs no runtime write to the canonical drills catalog", () => {
    for (const source of [page, route]) {
      const statements = canonicalDrillsStatements(source);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        for (const operation of WRITE_OPERATIONS) {
          expect(statement).not.toContain(operation);
        }
      }
    }
  });

  it("introduces no putting seed and no canonical-drill insert", () => {
    for (const source of [page, route]) {
      expect(source).not.toContain('"putting"');
      expect(source).not.toContain('.from("drills").insert');
    }
  });

  it("admits no equipment or commercial weighting", () => {
    const forbidden = ["equipment", "club_designation", "brand", "msrp", "price", "affiliate", "sponsor"];
    for (const source of [page, route]) {
      for (const token of forbidden) {
        expect(source.toLowerCase()).not.toContain(token);
      }
    }
  });

  it("admits no recommendation engine", () => {
    for (const source of [page, route]) {
      expect(source.toLowerCase()).not.toContain("recommend");
      expect(source.toLowerCase()).not.toContain("prescription");
    }
  });
});

describe("EQ5D Unit F — non-vacuity of every firewall predicate", () => {
  it("catches deletion of the page family predicate", () => {
    const mutated = withoutFirst(page, FAMILY_PREDICATE);
    expect(mutated).not.toBe(page);
    expect(pageIsFamilySafe(mutated)).toBe(false);
  });

  it("catches substitution of a negative page predicate", () => {
    const mutated = page.replace(FAMILY_PREDICATE, '.neq("drill_family", "putting")');
    expect(mutated).not.toBe(page);
    expect(pageIsFamilySafe(mutated)).toBe(false);
  });

  it("catches deletion of the route family predicate", () => {
    const mutated = withoutFirst(route, FAMILY_PREDICATE);
    expect(mutated).not.toBe(route);
    expect(verifyIsFamilySafe(mutated)).toBe(false);
    expect(verifyEffectsAreFailClosed(mutated)).toBe(false);
  });

  it("catches a name-based family authority in the route lookup", () => {
    const mutated = route.replace(FAMILY_PREDICATE, '.eq("name", "One-Piece Takeaway")');
    expect(mutated).not.toBe(route);
    expect(verifyIsFamilySafe(mutated)).toBe(false);
  });

  it("catches removal of the early not-found boundary", () => {
    const mutated = withoutFirst(route, "if (drillErr || !drill)");
    expect(mutated).not.toBe(route);
    expect(verifyEffectsAreFailClosed(mutated)).toBe(false);
  });

  it("catches the not-found boundary being moved after a downstream effect", () => {
    const block = notFoundBlock(route);
    const without = withoutFirst(route, block);
    const at = indexRequired(without, '.from("user_drills")');
    const mutated = without.slice(0, at) + block + without.slice(at);
    expect(mutated).not.toBe(route);
    expect(verifyEffectsAreFailClosed(mutated)).toBe(false);
  });

  it("catches family-specific disclosure regardless of quote style", () => {
    const mutated = route.replace(
      '{ error: "Drill not found" }',
      "{ error: 'Wrong drill family' }",
    );
    expect(mutated).not.toBe(route);
    expect(hasDisclosureCopy(mutated, "Wrong drill family")).toBe(true);
  });
});
