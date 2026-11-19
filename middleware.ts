import type { NextRequest } from "next/server";
import { refreshSession } from "@/utils/supabase/session-refresh";

// Protected pages only. The middleware refreshes an expiring session cookie
// and forwards it to the same request; it is not an authentication gate.
// Identity stays with the shared verifier in utils/supabase/server.ts.
export function middleware(request: NextRequest) {
  return refreshSession(request);
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
