import { POST as createAnalysisRequest } from "@/app/api/v1/analyses/route";
import { requireBearerHeader } from "@/lib/api/protected-web-boundary";

/**
 * POST /api/web/analyses — AG-WEB-READY-10-P4, the protected browser path (off by default).
 *
 * The existing POST /api/v1/analyses handler, unchanged, behind one rule: no Authorization header, no handler
 * (lib/api/protected-web-boundary.ts). The handler's own route segment settings are none, so none are declared here.
 */
export async function POST(request: Request): Promise<Response> {
  return requireBearerHeader(request, createAnalysisRequest, "v1");
}
