/**
 * EQ3 — retirement of the legacy Next.js equipment API surface.
 *
 * A static source-contract suite in the established style of this repository's
 * other equipment suites. Nothing here contacts a database, a network, a
 * browser, or a Next.js server; every assertion is filesystem and source
 * inspection only.
 *
 * WHAT WAS RETIRED AND WHY
 * -----------------------
 * Three misplaced Next.js route files and one dead React client formed a
 * complete legacy equipment API loop that no live surface used:
 *
 *   app/api/equipment/route.ts            — inline/static catalog handler
 *   app/api/equipment/catalog/route.ts    — authenticated user_equipment DELETE
 *   app/api/equipment/[id]/route.ts       — collection GET/POST on user_equipment
 *   components/equipment/VirtualBag.tsx   — the only caller of all three
 *
 * Each route's own header names a different intended path than the one it sits
 * at, so the family was rotated relative to its own documentation. Rather than
 * repair or relocate it, EQ3 retires it: the authenticated hard-DELETE handler
 * contradicts the archive lifecycle DB1/DB2/DB3 established, and the remaining
 * handlers duplicate architecture the canonical catalog reader and the saved-club
 * reader already own.
 *
 * WHAT IS DELIBERATELY *NOT* IN SCOPE
 * -----------------------------------
 * The Python service under ai-backend/ exposes its own separate read-only
 * equipment catalog router. It is a different service surface, this slice does
 * not decide its future, and section F below pins that boundary so a future
 * reader cannot mistake this contract for a repository-wide ban.
 *
 * WHY COMMENTS ARE STRIPPED
 * -------------------------
 * The "must not contain" assertions run against comment-stripped source. The
 * repository legitimately *discusses* the retired route family in prose — for
 * example lib/equipment/catalog.ts explains that it never falls back to the
 * legacy static catalog in app/api/equipment/route.ts. An explanation of a
 * prohibition must not be what fails the test asserting it.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Exactly the files this slice retires. Hand-transcribed, not derived. */
const RETIRED_PATHS = [
  "app/api/equipment/route.ts",
  "app/api/equipment/catalog/route.ts",
  "app/api/equipment/[id]/route.ts",
  "components/equipment/VirtualBag.tsx",
];

/** The retired Next.js API contract no production TypeScript may still call. */
const RETIRED_API_PREFIX = "/api/equipment";

/** Production TypeScript roots this contract governs. ai-backend is excluded. */
const PRODUCTION_ROOTS = ["app", "components", "lib", "utils"];

/** The Next.js route tree, for the hard-delete assertion. */
const APP_API_ROOT = "app/api";

const BAG_CLIENT = "app/(dashboard)/bag/BagPageClient.tsx";

/** The separate Python service surface this slice explicitly preserves. */
const PRESERVED_PYTHON_PATHS = [
  "ai-backend/app/routers/equipment.py",
  "ai-backend/app/main.py",
  "ai-backend/app/data/equipment_catalog.py",
];

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function isTestFile(relativePath: string): boolean {
  return TEST_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

/**
 * Every .ts/.tsx file beneath one root, as repo-relative POSIX paths.
 * Returns an empty list for a root that does not exist rather than throwing,
 * so the contract does not depend on optional directories.
 */
function collectSourceFiles(root: string): string[] {
  const absoluteRoot = path.join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];

  const found: string[] = [];
  const walk = (absoluteDir: string) => {
    for (const entry of readdirSync(absoluteDir)) {
      const absolute = path.join(absoluteDir, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        walk(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
      found.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
    }
  };
  walk(absoluteRoot);
  return found.sort();
}

/** Production (non-test) TypeScript source across the governed roots. */
function productionSourceFiles(): string[] {
  return PRODUCTION_ROOTS.flatMap((root) => collectSourceFiles(root)).filter(
    (file) => !isTestFile(file)
  );
}

const NEWLINE = String.fromCharCode(10);

/**
 * Strips TypeScript/JSX comments so "must not contain" assertions describe
 * executable code. String literals are preserved — the tokens these tests look
 * for live inside them.
 */
function stripTsComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (quote === null && two === "//") {
      const nl = source.indexOf(NEWLINE, i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (quote === null && two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const c = source[i];
    if (quote !== null) {
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Executable source for one file. */
function code(relativePath: string): string {
  return stripTsComments(readSource(relativePath));
}

// ============================================================================
// A. The retired Next.js surface is gone.
// ============================================================================

describe("EQ3 API retirement — the legacy equipment surface is absent", () => {
  for (const retired of RETIRED_PATHS) {
    it(`${retired} no longer exists`, () => {
      expect(
        existsSync(path.join(repoRoot, retired)),
        `${retired}: restoring this file re-opens the retired equipment API surface`
      ).toBe(false);
    });
  }

  it("retires all four paths together, not a subset", () => {
    const surviving = RETIRED_PATHS.filter((p) => existsSync(path.join(repoRoot, p)));
    expect(surviving, "the route family and its only client retire as one unit").toEqual([]);
  });
});

// ============================================================================
// B. No production TypeScript still calls the retired API.
// ============================================================================

describe("EQ3 API retirement — no production TypeScript depends on it", () => {
  it("governs a non-empty set of production TypeScript files", () => {
    // Guards the guard: an empty scan would make every assertion below vacuous.
    const files = productionSourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.startsWith("app/"))).toBe(true);
    expect(files.some((f) => f.startsWith("components/"))).toBe(true);
    expect(files.some((f) => f.startsWith("lib/"))).toBe(true);
  });

  it("references the retired API from no executable production source", () => {
    const offenders = productionSourceFiles().filter((file) =>
      code(file).includes(RETIRED_API_PREFIX)
    );
    expect(
      offenders,
      `these files still call the retired ${RETIRED_API_PREFIX} contract, which no longer exists`
    ).toEqual([]);
  });

  it("still allows prose to explain the retirement", () => {
    // lib/equipment/catalog.ts documents that it never falls back to the legacy
    // static catalog. That sentence must survive comment stripping as a comment
    // and must not be what the assertion above measures.
    const explainer = "lib/equipment/catalog.ts";
    expect(existsSync(path.join(repoRoot, explainer))).toBe(true);
    expect(readSource(explainer)).toContain(RETIRED_API_PREFIX);
    expect(code(explainer)).not.toContain(RETIRED_API_PREFIX);
  });

  it("excludes test sources from the production scan", () => {
    // This suite names the retired contract in its own assertions, so a scan
    // that swept test files would fail on itself.
    const files = productionSourceFiles();
    expect(files.every((file) => !isTestFile(file))).toBe(true);
    expect(files).not.toContain("lib/equipment-api-retirement-eq3.test.ts");
  });
});

// ============================================================================
// C. No Next.js route hard-deletes user_equipment.
// ============================================================================

describe("EQ3 API retirement — no user_equipment hard delete under app/api", () => {
  it("has no route that both targets user_equipment and calls .delete(", () => {
    const offenders = collectSourceFiles(APP_API_ROOT)
      .filter((file) => !isTestFile(file))
      .filter((file) => {
        const executable = code(file);
        return executable.includes("user_equipment") && executable.includes(".delete(");
      });
    expect(
      offenders,
      "removal from the bag is an archive UPDATE; a route may not hard-delete user_equipment"
    ).toEqual([]);
  });

  it("has no user_equipment query chain containing a delete call", () => {
    // Chain-scoped, so an unrelated DELETE handler elsewhere in the same file
    // could not by itself trip the assertion above without also being wrong.
    const offenders: string[] = [];
    for (const file of collectSourceFiles(APP_API_ROOT).filter((f) => !isTestFile(f))) {
      const executable = code(file);
      let from = executable.indexOf("user_equipment");
      while (from !== -1) {
        const end = executable.indexOf(";", from);
        const chain = executable.slice(from, end === -1 ? executable.length : end);
        if (chain.includes(".delete(")) offenders.push(file);
        from = executable.indexOf("user_equipment", from + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not ban DELETE handlers for unrelated resources", () => {
    // Recorded as an explicit non-goal: this contract is about user_equipment,
    // not about the HTTP verb. Any surviving route may still export DELETE.
    const routes = collectSourceFiles(APP_API_ROOT).filter((f) => !isTestFile(f));
    for (const file of routes) {
      const executable = code(file);
      if (executable.includes(".delete(") && !executable.includes("user_equipment")) {
        expect(executable).toContain(".delete(");
      }
    }
    expect(routes.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// D. The supported removal path is still the archive UPDATE.
// ============================================================================

describe("EQ3 API retirement — bag removal remains archive-based", () => {
  const bag = () => code(BAG_CLIENT);

  it("performs no hard delete", () => {
    expect(
      bag(),
      `${BAG_CLIENT}: retiring the API must not reintroduce a client-side delete`
    ).not.toContain(".delete(");
  });

  it("writes the archive flag on the equipment table", () => {
    expect(bag()).toContain('.from("user_equipment")');
    expect(bag()).toContain(".update({ is_archived: true })");
  });

  it("scopes the archive by id, owner and current active state", () => {
    expect(bag()).toContain('.eq("id", clubId)');
    expect(bag()).toContain('.eq("user_id", userId)');
    expect(bag()).toContain('.eq("is_archived", false)');
  });

  it("confirms the archived row positively", () => {
    expect(bag()).toContain('.select("id")');
    expect(bag()).toContain(".maybeSingle()");
  });
});

// ============================================================================
// E. The active bag uses the surviving component.
// ============================================================================

describe("EQ3 API retirement — the active bag component is unaffected", () => {
  it("imports the swing VirtualBag", () => {
    expect(code(BAG_CLIENT)).toContain("@/components/swing/VirtualBag");
  });

  it("does not reference the retired equipment VirtualBag", () => {
    expect(
      readSource(BAG_CLIENT),
      `${BAG_CLIENT}: the retired component must not be referenced at all`
    ).not.toContain("@/components/equipment/VirtualBag");
  });

  it("leaves the active component in place", () => {
    expect(existsSync(path.join(repoRoot, "components/swing/VirtualBag.tsx"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "components/equipment/ClubSelector.tsx"))).toBe(true);
  });
});

// ============================================================================
// F. The Python service surface is explicitly out of scope.
// ============================================================================

describe("EQ3 API retirement — the Python equipment router is preserved", () => {
  for (const preserved of PRESERVED_PYTHON_PATHS) {
    it(`${preserved} is untouched by this retirement`, () => {
      expect(
        existsSync(path.join(repoRoot, preserved)),
        `${preserved}: the Python catalog service is a separate surface this slice does not decide`
      ).toBe(true);
    });
  }

  it("scopes the retirement scan to TypeScript roots only", () => {
    // The contract is deliberately not a repository-wide ban on the string.
    // ai-backend is never walked, so the Python router keeps its own routes.
    expect(PRODUCTION_ROOTS).toEqual(["app", "components", "lib", "utils"]);
    expect(PRODUCTION_ROOTS).not.toContain("ai-backend");
    expect(productionSourceFiles().every((f) => !f.startsWith("ai-backend/"))).toBe(true);
  });
});

// ============================================================================
// G. This suite stays a static source contract.
// ============================================================================

describe("EQ3 API retirement — the suite itself stays honest", () => {
  /**
   * This suite's own import block.
   *
   * Section G is asserted positively, over the imports only. A negative scan of
   * this file for forbidden tokens would be self-defeating: naming "@supabase"
   * or "writeFileSync" in an assertion puts that very string into the source
   * being scanned. Pinning the exact import set proves the same properties
   * without that trap — a module this file does not import is a capability it
   * cannot reach.
   */
  const importBlock = () => {
    const source = readSource("lib/equipment-api-retirement-eq3.test.ts");
    const end = source.indexOf("const __dirname");
    expect(end, "could not locate the end of the import block").toBeGreaterThan(-1);
    return source.slice(0, end);
  };

  it("imports exactly vitest and read-only Node builtins", () => {
    const specifiers = (importBlock().match(/from "[^"]+"/g) ?? [])
      .map((clause) => clause.slice('from "'.length, -1))
      .sort();
    expect(
      specifiers,
      "no Supabase client, no HTTP client, and no implementation module may be imported"
    ).toEqual(["node:fs", "node:path", "node:url", "vitest"]);
  });

  it("takes only read-only filesystem capabilities", () => {
    const fsImport = importBlock().match(/import \{([^}]*)\} from "node:fs"/);
    expect(fsImport, "the node:fs import must be an explicit named list").not.toBeNull();
    const names = (fsImport as RegExpMatchArray)[1]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .sort();
    expect(
      names,
      "a write capability here would let a source contract edit the source it judges"
    ).toEqual(["existsSync", "readFileSync", "readdirSync", "statSync"]);
  });

  it("derives every expectation from hand-transcribed constants", () => {
    // Nothing above is read back out of the implementation, so a future change
    // cannot move the code and its own test in one step.
    expect(RETIRED_PATHS).toHaveLength(4);
    expect(RETIRED_API_PREFIX).toBe("/api/equipment");
    expect(PRODUCTION_ROOTS).toHaveLength(4);
    expect(PRESERVED_PYTHON_PATHS).toHaveLength(3);
  });
});
