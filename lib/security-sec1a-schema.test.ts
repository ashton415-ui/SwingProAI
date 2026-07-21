import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migrationPath = path.join(__dirname, "..", "supabase-security-sec1a.sql");
// Normalized to LF immediately after reading, matching the CM2A/CM2R fix to
// the marketplace schema tests, so exact-newline-adjacent assertions below
// are independent of Windows core.autocrlf checkout behavior.
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");

/** Strips `-- ...` line comments so keyword-absence checks can't be fooled by
 *  this file's own prose (e.g. "No DROP POLICY IF EXISTS" appears as
 *  commentary explaining a design decision, not as executable SQL). */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const code = stripSqlComments(migration);
const codeLower = code.toLowerCase();

/** Extracts the single `do $$ ... end $$;` block containing `marker`. */
function doBlockContaining(marker: string): string {
  const markerIdx = codeLower.indexOf(marker.toLowerCase());
  expect(markerIdx, `expected to find marker "${marker}"`).toBeGreaterThanOrEqual(0);
  const blockStart = codeLower.lastIndexOf("do $$", markerIdx);
  expect(blockStart, `expected an enclosing "do $$" before "${marker}"`).toBeGreaterThanOrEqual(0);
  const blockEnd = codeLower.indexOf("end $$;", markerIdx);
  expect(blockEnd, `expected an enclosing "end $$;" after "${marker}"`).toBeGreaterThan(markerIdx);
  return codeLower.slice(blockStart, blockEnd + "end $$;".length);
}

const preflightBlock = doBlockContaining("SEC1A-PRE-A1");
const postflightBlock = doBlockContaining("SEC1A-POST-A1");

interface DropTarget {
  policyName: string;
  relation: string;
  /** Character offset of the start of this DROP statement within `code`. */
  index: number;
}

/** Parses every top-level `drop policy "<name>" on <schema>.<table>;` statement,
 *  including its character offset so statement ordering can be verified. */
function parseDropPolicies(sql: string): DropTarget[] {
  const re = /drop\s+policy\s+"([^"]+)"\s+on\s+([a-z_]+\.[a-z_]+)\s*;/gi;
  const out: DropTarget[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({ policyName: m[1], relation: m[2].toLowerCase(), index: m.index });
  }
  return out;
}

const dropTargets = parseDropPolicies(code);

const APPROVED_WEAK_POLICIES: Omit<DropTarget, "index">[] = [
  { policyName: "Allow Anonymous Uploads xuww7b_0", relation: "storage.objects" },
  { policyName: "Allow authenticated inserts", relation: "public.user_goals" },
  { policyName: "Allow users to view own goals", relation: "public.user_goals" },
];

const STRICT_POLICY_NAMES = [
  "Users can insert own goals",
  "Users can view own goals",
  "Users can upload their own swing videos",
  "Users can read their own swing videos",
  "Users can delete their own swing videos",
];

const OWNER_SCOPED_GOAL_PREDICATE = "(auth.uid()=user_id)";
// Doubled single quotes because this matches the raw *source text* of the
// SQL file, where an embedded string literal inside a plpgsql '...' string
// must escape its own quotes as ''.
const FOLDER_SCOPED_STORAGE_PREDICATE =
  "((bucket_id=''swing-videos''::text)and((storage.foldername(name))[1]=(auth.uid())::text))";

// ============================================================================
// 1. Transaction shape
// ============================================================================
describe("supabase-security-sec1a.sql — transaction shape", () => {
  it("contains exactly one top-level BEGIN and one COMMIT", () => {
    const begins = code.match(/^\s*begin\s*;\s*$/gim) ?? [];
    const commits = code.match(/^\s*commit\s*;\s*$/gim) ?? [];
    expect(begins.length).toBe(1);
    expect(commits.length).toBe(1);
  });

  it("places BEGIN before COMMIT", () => {
    const beginIdx = codeLower.search(/^\s*begin\s*;\s*$/im);
    const commitIdx = codeLower.search(/^\s*commit\s*;\s*$/im);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
  });

  it("states prominently that it is unapplied/source-only", () => {
    expect(migration).toMatch(/THIS MIGRATION IS UNAPPLIED\. IT IS SOURCE ONLY\./);
  });
});

// ============================================================================
// 2. Preflight / postflight presence and fail-loud behavior
// ============================================================================
describe("supabase-security-sec1a.sql — fail-loud preflight and postflight", () => {
  it("has a preflight DO block and a postflight DO block", () => {
    expect(preflightBlock.length).toBeGreaterThan(0);
    expect(postflightBlock.length).toBeGreaterThan(0);
  });

  it("the preflight block raises exceptions on drift", () => {
    const raises = preflightBlock.match(/raise\s+exception/g) ?? [];
    expect(raises.length).toBeGreaterThan(5);
  });

  it("the postflight block raises exceptions on drift", () => {
    const raises = postflightBlock.match(/raise\s+exception/g) ?? [];
    expect(raises.length).toBeGreaterThan(5);
  });

  it("every preflight/postflight exception carries a stable SEC1A-PRE/POST identifier", () => {
    const preIds = preflightBlock.match(/sec1a-pre-[a-z0-9]+/g) ?? [];
    const postIds = postflightBlock.match(/sec1a-post-[a-z0-9]+/g) ?? [];
    expect(preIds.length).toBeGreaterThan(5);
    expect(postIds.length).toBeGreaterThan(5);
  });

  it("preflight checks table ownership and execution authority (not merely BYPASSRLS)", () => {
    expect(preflightBlock).toMatch(/sec1a-pre-b\d/);
    expect(preflightBlock).toContain("pg_has_role");
    expect(preflightBlock).toContain("bypassrls");
    expect(preflightBlock).toContain("is not sufficient authority for policy ddl");
  });

  it("preflight and postflight both check RLS remains/is enabled on both relations", () => {
    expect(preflightBlock).toContain("relrowsecurity");
    expect(postflightBlock).toContain("relrowsecurity");
    expect(postflightBlock).toMatch(/sec1a-post-c1/);
    expect(postflightBlock).toMatch(/sec1a-post-c2/);
  });
});

// ============================================================================
// 3. Exact policy removals
// ============================================================================
describe("supabase-security-sec1a.sql — exact policy removals", () => {
  it("contains exactly three DROP POLICY statements", () => {
    expect(dropTargets.length).toBe(3);
  });

  it("drops exactly the three approved weak policy names, and no others", () => {
    const actual = dropTargets
      .map((d) => `${d.relation}::${d.policyName}`)
      .sort();
    const expected = APPROVED_WEAK_POLICIES.map((d) => `${d.relation}::${d.policyName}`).sort();
    expect(actual).toEqual(expected);
  });

  it("every DROP POLICY is schema-qualified to the approved relation", () => {
    for (const d of dropTargets) {
      expect(["storage.objects", "public.user_goals"]).toContain(d.relation);
    }
  });

  it("does not use DROP POLICY IF EXISTS anywhere in executable SQL", () => {
    expect(codeLower).not.toContain("drop policy if exists");
  });

  it("does not drop any strict/preserved policy", () => {
    const droppedNames = dropTargets.map((d) => d.policyName);
    for (const strictName of STRICT_POLICY_NAMES) {
      expect(droppedNames).not.toContain(strictName);
    }
  });

  it("does not drop any drill-video policy", () => {
    for (const d of dropTargets) {
      expect(d.policyName.toLowerCase()).not.toContain("drill");
    }
  });
});

// ============================================================================
// 4. No DDL/DML/grant/config changes outside the three policy removals
// ============================================================================
describe("supabase-security-sec1a.sql — narrow scope: no unrelated changes", () => {
  it("contains no CREATE/ALTER/DROP TABLE", () => {
    expect(codeLower).not.toMatch(/\bcreate\s+table\b/);
    expect(codeLower).not.toMatch(/\balter\s+table\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+table\b/);
  });

  it("contains no CREATE/DROP FUNCTION and no persistent helper function", () => {
    expect(codeLower).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+function\b/);
  });

  it("contains no CREATE POLICY (this contract only removes policies)", () => {
    expect(codeLower).not.toMatch(/\bcreate\s+policy\b/);
  });

  it("creates no storage UPDATE policy for swing-videos", () => {
    expect(codeLower).not.toMatch(/create\s+policy[\s\S]*?update[\s\S]*?swing-videos/);
  });

  it("contains no GRANT or REVOKE", () => {
    expect(codeLower).not.toMatch(/\bgrant\b/);
    expect(codeLower).not.toMatch(/\brevoke\b/);
  });

  it("contains no DML against application or storage rows", () => {
    expect(codeLower).not.toMatch(/\binsert\s+into\b/);
    expect(codeLower).not.toMatch(/\bupdate\s+\S+\s+set\b/);
    expect(codeLower).not.toMatch(/\bdelete\s+from\b/);
    expect(codeLower).not.toMatch(/\btruncate\b/);
  });

  it("does not reference storage.buckets or bucket configuration fields", () => {
    expect(codeLower).not.toContain("storage.buckets");
    expect(codeLower).not.toContain("file_size_limit");
    expect(codeLower).not.toContain("allowed_mime_types");
  });

  it("makes no nullability or column change to user_goals", () => {
    // Deliberately narrower than a blanket /not\s+null/ scan: this file's own
    // preflight/postflight logic legitimately uses PL/pgSQL "IS NOT NULL"
    // boolean checks (e.g. `if v_pol.qual is not null`), which are not a
    // nullability *change*. Only the actual DDL forms for altering a
    // column's nullability are checked here.
    expect(codeLower).not.toMatch(/\badd\s+column\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+column\b/);
    expect(codeLower).not.toMatch(/\bset\s+not\s+null\b/);
    expect(codeLower).not.toMatch(/\bdrop\s+not\s+null\b/);
    expect(codeLower).not.toMatch(/\balter\s+column\b/);
  });

  it("does not reference historical v6/v7/v8 migration files", () => {
    expect(codeLower).not.toContain("supabase-schema-v6.sql");
    expect(codeLower).not.toContain("supabase-schema-v7.sql");
    expect(codeLower).not.toContain("supabase-schema-v8.sql");
  });

  it("does not reference application code or package/config files", () => {
    expect(codeLower).not.toContain("package.json");
    expect(codeLower).not.toContain(".env");
    expect(codeLower).not.toMatch(/\bapp\//);
  });
});

// ============================================================================
// 5. Strict-policy preservation is actually verified, in both phases
// (broad, whole-block checks — retained for backward compatibility;
// superseded in strength by the pinned per-policy contracts in section 11)
// ============================================================================
describe("supabase-security-sec1a.sql — strict-policy preservation contract", () => {
  it.each(STRICT_POLICY_NAMES)("preflight verifies strict policy %s exists with its approved definition", (name) => {
    expect(preflightBlock).toContain(name.toLowerCase());
  });

  it.each(STRICT_POLICY_NAMES)("postflight re-verifies strict policy %s after the drops", (name) => {
    expect(postflightBlock).toContain(name.toLowerCase());
  });

  it("preflight and postflight both assert the owner-scoped user_goals predicate", () => {
    expect(preflightBlock.replace(/\s+/g, "")).toContain(OWNER_SCOPED_GOAL_PREDICATE);
    expect(postflightBlock.replace(/\s+/g, "")).toContain(OWNER_SCOPED_GOAL_PREDICATE);
  });

  it("preflight and postflight both assert the folder-scoped storage predicate", () => {
    expect(preflightBlock.replace(/\s+/g, "")).toContain(FOLDER_SCOPED_STORAGE_PREDICATE);
    expect(postflightBlock.replace(/\s+/g, "")).toContain(FOLDER_SCOPED_STORAGE_PREDICATE);
  });

  it("preflight stops rather than recreating a drifted strict policy", () => {
    expect(preflightBlock).toContain("stop and redesign");
    expect(preflightBlock).not.toMatch(/\bcreate\s+policy\b/);
  });
});

// ============================================================================
// 6. Equivalent-access and unrelated-policy checks
// (marker/presence checks — retained; narrowly-scoped anon+public checks are
// in section 12)
// ============================================================================
describe("supabase-security-sec1a.sql — equivalent-access and unrelated-policy checks", () => {
  it("preflight scans for additional anon-role INSERT policies on swing-videos", () => {
    expect(preflightBlock).toMatch(/sec1a-pre-e1/);
    expect(preflightBlock).toContain("'anon' = any(roles)");
  });

  it("preflight scans for additional arbitrary-user_id user_goals INSERT policies", () => {
    expect(preflightBlock).toMatch(/sec1a-pre-e2/);
  });

  it("preflight scans for additional null-user_id-permitting SELECT policies", () => {
    expect(preflightBlock).toMatch(/sec1a-pre-e3/);
  });

  it("postflight re-confirms no equivalent broad access exists after the drop", () => {
    expect(postflightBlock).toMatch(/sec1a-post-d1/);
    expect(postflightBlock).toMatch(/sec1a-post-d2/);
    expect(postflightBlock).toMatch(/sec1a-post-d3/);
  });

  it("postflight confirms the unrelated drill-video policies were left untouched", () => {
    expect(postflightBlock).toContain("users can upload drill videos");
    expect(postflightBlock).toContain("users can view own drill videos");
    expect(postflightBlock).toMatch(/sec1a-post-e1/);
  });
});

// ============================================================================
// 7. Normalization is narrow (whitespace-only), not a loose substring match
// ============================================================================
describe("supabase-security-sec1a.sql — expression normalization is narrow", () => {
  it("normalizes via whitespace stripping, preserving operators/casts/literals", () => {
    expect(codeLower).toContain("regexp_replace(coalesce(");
    expect(codeLower).toMatch(/\[\[:space:\]\]\+/);
  });

  it("sorts role arrays before comparison rather than comparing raw order", () => {
    expect(codeLower).toContain("array_agg(r order by r)");
  });

  it("does not reduce comparisons to loose substring containment for full predicates", () => {
    // The narrow "like '%...%'" scans are reserved for the equivalent-access
    // section only (E1-E3, POST-D1/D2), never for verifying an exact
    // approved policy's own predicate, which always uses strict equality.
    expect(preflightBlock).toContain("<> '(bucket_id=''swing-videos''::text)'");
    expect(preflightBlock).toContain(`<> '${OWNER_SCOPED_GOAL_PREDICATE}'`);
  });
});

// ============================================================================
// 8. No dynamic EXECUTE (closes mutation gap: dynamic policy DDL bypass)
// ============================================================================
describe("supabase-security-sec1a.sql — no dynamic SQL execution", () => {
  it("contains no executable EXECUTE keyword anywhere in the comment-stripped SQL", () => {
    // Operates on `codeLower`, which already had every `-- ...` comment
    // stripped before this check runs — so this cannot be satisfied merely
    // by documentation/comments saying EXECUTE is prohibited; it proves the
    // word is absent from the *executable* text itself.
    expect(codeLower).not.toMatch(/\bexecute\b/);
  });
});

// ============================================================================
// 9. Transaction / DROP statement ordering, by character offset
// (closes mutation gap: a DROP moved outside the preflight/postflight
// boundary would previously only be caught by accident, if at all)
// ============================================================================
describe("supabase-security-sec1a.sql — statement ordering", () => {
  const beginOffset = codeLower.search(/^\s*begin\s*;\s*$/im);
  const firstDoOffset = codeLower.indexOf("do $$");
  const preflightEndOffset = codeLower.indexOf("end $$;", firstDoOffset) + "end $$;".length;
  const secondDoOffset = codeLower.indexOf("do $$", preflightEndOffset);
  const postflightEndOffset = codeLower.indexOf("end $$;", secondDoOffset) + "end $$;".length;
  const commitOffset = codeLower.search(/^\s*commit\s*;\s*$/im);

  it("BEGIN precedes the preflight DO block", () => {
    expect(beginOffset).toBeGreaterThanOrEqual(0);
    expect(firstDoOffset).toBeGreaterThan(beginOffset);
  });

  it("the preflight DO block ends before the first DROP POLICY", () => {
    expect(dropTargets.length).toBeGreaterThan(0);
    const firstDropOffset = Math.min(...dropTargets.map((d) => d.index));
    expect(preflightEndOffset).toBeLessThan(firstDropOffset);
  });

  it("all three DROP POLICY statements occur strictly between preflight and postflight", () => {
    expect(dropTargets.length).toBe(3);
    for (const d of dropTargets) {
      expect(d.index).toBeGreaterThan(preflightEndOffset);
      expect(d.index).toBeLessThan(secondDoOffset);
    }
  });

  it("no DROP POLICY occurs before preflight or after the postflight DO block begins", () => {
    for (const d of dropTargets) {
      expect(d.index).not.toBeLessThan(preflightEndOffset);
      expect(d.index).not.toBeGreaterThanOrEqual(secondDoOffset);
    }
  });

  it("the postflight DO block ends before COMMIT", () => {
    expect(commitOffset).toBeGreaterThan(postflightEndOffset);
  });
});

// ============================================================================
// 10. Pinned per-policy contracts
// (closes mutation gap: a role or predicate change to ONE specific named
// policy must fail even when another correct policy block still contains
// the original expected substring elsewhere in the same DO block)
// ============================================================================

/** Bounds the validation block for one specific policy lookup
 *  (`select policyname, ... into v_pol from pg_policies where ... and
 *  policyname = '<name>';` plus its following `if ... end if;` checks),
 *  ending at the next distinct check of any kind rather than at the end of
 *  the whole DO block — so each policy's role/predicate assertions can only
 *  be satisfied by that policy's own text. */
function policyBlockSlice(container: string, policyName: string): string {
  const needle = `policyname = '${policyName.toLowerCase()}'`;
  const needleIdx = container.indexOf(needle);
  expect(needleIdx, `expected to find "${needle}" in the given block`).toBeGreaterThanOrEqual(0);
  const blockStart = container.lastIndexOf("select policyname", needleIdx);
  expect(blockStart, `expected a preceding "select policyname" before "${needle}"`).toBeGreaterThanOrEqual(0);
  const nextMarkers = [
    container.indexOf("select policyname", blockStart + 1),
    container.indexOf("select count(*) into v_count", blockStart + 1),
    container.indexOf("if not (select relrowsecurity", blockStart + 1),
    container.indexOf("raise notice", blockStart + 1),
  ].filter((i) => i !== -1);
  const blockEnd = nextMarkers.length > 0 ? Math.min(...nextMarkers) : container.length;
  return container.slice(blockStart, blockEnd);
}

interface PolicyContract {
  name: string;
  schema: string;
  table: string;
  cmd: string;
  roleLiteral: string;
  qualMustBeNull?: boolean;
  qualExpected?: string;
  withCheckMustBeNull?: boolean;
  withCheckExpected?: string;
}

const WEAK_POLICY_CONTRACTS: PolicyContract[] = [
  {
    name: "Allow Anonymous Uploads xuww7b_0",
    schema: "storage",
    table: "objects",
    cmd: "INSERT",
    roleLiteral: "array['anon']::name[]",
    qualMustBeNull: true,
    withCheckExpected: "(bucket_id=''swing-videos''::text)",
  },
  {
    name: "Allow authenticated inserts",
    schema: "public",
    table: "user_goals",
    cmd: "INSERT",
    roleLiteral: "array['authenticated']::name[]",
    qualMustBeNull: true,
    withCheckExpected: "true",
  },
  {
    name: "Allow users to view own goals",
    schema: "public",
    table: "user_goals",
    cmd: "SELECT",
    roleLiteral: "array['authenticated']::name[]",
    qualExpected: "((auth.uid()=user_id)or(user_idisnull))",
    withCheckMustBeNull: true,
  },
];

const STRICT_POLICY_CONTRACTS: PolicyContract[] = [
  {
    name: "Users can insert own goals",
    schema: "public",
    table: "user_goals",
    cmd: "INSERT",
    roleLiteral: "array['public']::name[]",
    withCheckExpected: OWNER_SCOPED_GOAL_PREDICATE,
  },
  {
    name: "Users can view own goals",
    schema: "public",
    table: "user_goals",
    cmd: "SELECT",
    roleLiteral: "array['public']::name[]",
    qualExpected: OWNER_SCOPED_GOAL_PREDICATE,
  },
  {
    name: "Users can upload their own swing videos",
    schema: "storage",
    table: "objects",
    cmd: "INSERT",
    roleLiteral: "array['authenticated']::name[]",
    withCheckExpected: FOLDER_SCOPED_STORAGE_PREDICATE,
  },
  {
    name: "Users can read their own swing videos",
    schema: "storage",
    table: "objects",
    cmd: "SELECT",
    roleLiteral: "array['authenticated']::name[]",
    qualExpected: FOLDER_SCOPED_STORAGE_PREDICATE,
  },
  {
    name: "Users can delete their own swing videos",
    schema: "storage",
    table: "objects",
    cmd: "DELETE",
    roleLiteral: "array['authenticated']::name[]",
    qualExpected: FOLDER_SCOPED_STORAGE_PREDICATE,
  },
];

function assertPolicyContract(block: string, c: PolicyContract) {
  // `block` is sliced from `codeLower`, which lowercases the entire source
  // file including string literals like 'INSERT' -> 'insert' — so the
  // expected `cmd` value (defined in uppercase above for readability, since
  // that is how pg_policies.cmd is genuinely rendered at runtime) must be
  // lowered here to match the source text being searched.
  expect(block, `[${c.name}] schema`).toContain(`schemaname = '${c.schema}'`);
  expect(block, `[${c.name}] table`).toContain(`tablename = '${c.table}'`);
  expect(block, `[${c.name}] cmd`).toContain(`v_pol.cmd <> '${c.cmd.toLowerCase()}'`);
  expect(block, `[${c.name}] roles`).toContain(c.roleLiteral);
  if (c.qualMustBeNull) {
    expect(block, `[${c.name}] qual must be null`).toMatch(/v_pol\.qual is not null/);
  }
  if (c.qualExpected) {
    expect(block, `[${c.name}] qual predicate`).toContain(`<> '${c.qualExpected}'`);
  }
  if (c.withCheckMustBeNull) {
    expect(block, `[${c.name}] with_check must be null`).toMatch(/v_pol\.with_check is not null/);
  }
  if (c.withCheckExpected) {
    expect(block, `[${c.name}] with_check predicate`).toContain(`<> '${c.withCheckExpected}'`);
  }
}

describe("supabase-security-sec1a.sql — pinned weak-policy contracts (preflight)", () => {
  it.each(WEAK_POLICY_CONTRACTS)("preflight pins $name to its own exact bounded contract", (c) => {
    const block = policyBlockSlice(preflightBlock, c.name);
    assertPolicyContract(block, c);
  });
});

describe("supabase-security-sec1a.sql — pinned strict-policy contracts (preflight and postflight)", () => {
  it.each(STRICT_POLICY_CONTRACTS)("preflight pins $name to its own exact bounded contract", (c) => {
    const block = policyBlockSlice(preflightBlock, c.name);
    assertPolicyContract(block, c);
  });

  it.each(STRICT_POLICY_CONTRACTS)("postflight pins $name to its own exact bounded contract", (c) => {
    const block = policyBlockSlice(postflightBlock, c.name);
    assertPolicyContract(block, c);
  });
});

// ============================================================================
// 11. Anon + public equivalent-access detection, narrowly scoped
// (closes mutation gap: the prior scan checked only 'anon' = any(roles),
// missing that a policy assigned to PostgreSQL's `public` pseudo-role also
// applies to anonymous clients)
// ============================================================================

/** Bounds a single `select count(*) into v_count ... if ... end if;` check
 *  identified by its stable SEC1A-* marker. */
function checkBlockContaining(container: string, marker: string): string {
  const markerIdx = container.indexOf(marker.toLowerCase());
  expect(markerIdx, `expected to find marker "${marker}"`).toBeGreaterThanOrEqual(0);
  const selectIdx = container.lastIndexOf("select count(*) into v_count", markerIdx);
  expect(selectIdx, `expected a preceding "select count(*) into v_count" before "${marker}"`).toBeGreaterThanOrEqual(0);
  const endIfIdx = container.indexOf("end if;", markerIdx);
  expect(endIfIdx, `expected an "end if;" after "${marker}"`).toBeGreaterThan(markerIdx);
  return container.slice(selectIdx, endIfIdx + "end if;".length);
}

describe("supabase-security-sec1a.sql — anon+public equivalent-access detection", () => {
  it("preflight SEC1A-PRE-E1 recognizes both anon and public as anonymous-applicable", () => {
    const e1 = checkBlockContaining(preflightBlock, "sec1a-pre-e1");
    expect(e1).toContain("'anon' = any(roles)");
    expect(e1).toContain("'public' = any(roles)");
    expect(e1).toMatch(/\(\s*'anon'\s*=\s*any\(roles\)\s*or\s*'public'\s*=\s*any\(roles\)\s*\)/);
  });

  it("postflight SEC1A-POST-D1 recognizes both anon and public as anonymous-applicable", () => {
    const d1 = checkBlockContaining(postflightBlock, "sec1a-post-d1");
    expect(d1).toContain("'anon' = any(roles)");
    expect(d1).toContain("'public' = any(roles)");
    expect(d1).toMatch(/\(\s*'anon'\s*=\s*any\(roles\)\s*or\s*'public'\s*=\s*any\(roles\)\s*\)/);
  });

  it("the preflight anon/public scan stays narrowed to storage.objects INSERT for swing-videos", () => {
    const e1 = checkBlockContaining(preflightBlock, "sec1a-pre-e1");
    expect(e1).toContain("schemaname = 'storage'");
    expect(e1).toContain("tablename = 'objects'");
    expect(e1).toContain("cmd = 'insert'");
    expect(e1).toContain("like '%swing-videos%'");
    // Excluded from its own scan — must not flag itself.
    expect(e1).toContain("policyname <> 'allow anonymous uploads xuww7b_0'");
  });

  it("the postflight anon/public scan stays narrowed to storage.objects INSERT for swing-videos", () => {
    const d1 = checkBlockContaining(postflightBlock, "sec1a-post-d1");
    expect(d1).toContain("schemaname = 'storage'");
    expect(d1).toContain("tablename = 'objects'");
    expect(d1).toContain("cmd = 'insert'");
    expect(d1).toContain("like '%swing-videos%'");
  });

  it("does not widen the anon/public scan into a blanket freeze of the whole storage.objects policy set", () => {
    // The scan is bounded to one command (INSERT) and one bucket
    // (swing-videos) — it must not, for example, also require an exact
    // count of every policy on the table, which would make any future
    // unrelated bucket policy a permanent prerequisite.
    const e1 = checkBlockContaining(preflightBlock, "sec1a-pre-e1");
    expect(e1).not.toMatch(/count\(\*\)\s*(=|<>)\s*\d/);
  });
});
