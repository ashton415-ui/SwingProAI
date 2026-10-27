// ============================================================================
// ENT-1D — application-to-database integration: test adapter (LOCAL ONLY)
// ============================================================================
//
// Loaded by vitest.ent1d-app.config.ts before every integration suite. It is
// the ONLY adapter between the real application modules and the disposable
// local stack, and it does exactly three things:
//
//   1. Local client configuration. Reads `supabase status -o json` of the
//      run's own stack (path in ENT1D_STATUS_JSON), refuses anything that is
//      not a loopback URL equal to ENT1D_EXPECTED_API, and sets the three
//      variables utils/supabase/{admin,server}.ts read. Nothing is read from
//      any .env file; the config's envDir is an empty directory.
//   2. Outbound guard. Wraps globalThis.fetch so any request to a host other
//      than 127.0.0.1/localhost throws and is recorded. supabase-js, the
//      route's video fetch and anything else share this fetch.
//   3. A synthetic provider credential, so the route's "is a key configured"
//      check passes. The Gemini SDK itself is replaced per suite (vi.mock),
//      so this value never leaves the process.
//
// `server-only` and `next/headers` are replaced per suite (vi.mock) because
// Vitest is not a Next.js server; see each suite's header.

import { readFileSync } from "node:fs";

const statusPath = process.env.ENT1D_STATUS_JSON;
const expectedApi = process.env.ENT1D_EXPECTED_API;
if (!statusPath || !expectedApi) {
  throw new Error("ENT1D_STATUS_JSON and ENT1D_EXPECTED_API must name the run's local stack.");
}
const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, string>;
if (status.API_URL !== expectedApi || !/^http:\/\/127\.0\.0\.1:\d+$/.test(status.API_URL)) {
  throw new Error(`TARGET_MISMATCH: refusing to run against ${status.API_URL}`);
}

for (const name of [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "GOOGLE_AI_API_KEY",
]) {
  delete process.env[name];
}
process.env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.GEMINI_API_KEY = "ent1d-synthetic-local-provider-credential";

export const outboundViolations: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(raw).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    outboundViolations.push(host);
    throw new Error(`ENT1D_OUTBOUND_BLOCKED: ${host}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
