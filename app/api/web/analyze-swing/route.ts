import type { NextRequest } from "next/server";
import { POST as analyzeSwing } from "@/app/api/analyze-swing/route";
import { requireBearerHeader } from "@/lib/api/protected-web-boundary";

/**
 * POST /api/web/analyze-swing — AG-WEB-READY-10-P4, the protected browser path (off by default).
 *
 * The existing POST /api/analyze-swing handler, unchanged, behind one rule: no Authorization header, no handler
 * (lib/api/protected-web-boundary.ts).
 *
 * Route segment settings are not inherited by a module that reuses a handler, and Next.js reads them only as literals
 * in the route file itself, so the handler's are restated here exactly (app/api/analyze-swing/route.ts). The P4 tests
 * compare the two files' settings.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest): Promise<Response> {
  return requireBearerHeader(request, analyzeSwing, "analyze-swing");
}
