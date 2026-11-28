import { POST as finalizeUpload } from "@/app/api/v1/uploads/finalize/route";
import { requireBearerHeader } from "@/lib/api/protected-web-boundary";

/**
 * POST /api/web/uploads/finalize — AG-WEB-READY-10-P4, the protected browser path (off by default).
 *
 * The existing POST /api/v1/uploads/finalize handler, unchanged, behind one rule: no Authorization header, no handler
 * (lib/api/protected-web-boundary.ts). The handler's own route segment settings are none, so none are declared here.
 */
export async function POST(request: Request): Promise<Response> {
  return requireBearerHeader(request, finalizeUpload, "v1");
}
