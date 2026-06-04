import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const allCookies = req.cookies.getAll();
  const supabaseCookie = allCookies.find(c => c.name === "sb-atlmnqispyzhsahahpjy-auth-token");

  let rawValue = supabaseCookie?.value ?? null;
  let decodedValue: string | null = null;
  let parsedOk = false;
  let parseError: string | null = null;
  let sessionPreview: object | null = null;

  if (rawValue) {
    try {
      decodedValue = decodeURIComponent(rawValue);
    } catch {
      decodedValue = rawValue;
    }
    try {
      const parsed = JSON.parse(decodedValue);
      parsedOk = true;
      sessionPreview = {
        hasAccessToken: !!parsed.access_token,
        hasRefreshToken: !!parsed.refresh_token,
        expiresAt: parsed.expires_at,
        userId: parsed.user?.id ?? null,
        email: parsed.user?.email ?? null,
      };
    } catch (e) {
      parseError = String(e);
    }
  }

  return NextResponse.json({
    cookieCount: allCookies.length,
    supabaseCookieFound: !!supabaseCookie,
    rawValueLength: rawValue?.length ?? 0,
    rawValueStart: rawValue?.slice(0, 50) ?? null,
    decodedValueStart: decodedValue?.slice(0, 50) ?? null,
    parsedOk,
    parseError,
    sessionPreview,
  });
}
