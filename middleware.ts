import type { NextRequest } from "next/server";
import { resumeExpiringSession } from "@/utils/supabase/session-resume";

// Protected pages only. The middleware never refreshes or writes a session: a
// page navigation whose session cookie is due to expire goes by /auth/resume,
// where the browser's own client refreshes it; it is not an authentication
// gate. Identity stays with the shared verifier in utils/supabase/server.ts.
export function middleware(request: NextRequest) {
  return resumeExpiringSession(request);
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/analyze/:path*",
    "/bag/:path*",
    "/coach/:path*",
    "/dashboard/:path*",
    "/drills/:path*",
    "/goals/:path*",
    "/lessons/:path*",
    "/range/:path*",
    "/swings/:path*",
    "/telemetry/:path*",
    "/upgrade/:path*",
  ],
};
