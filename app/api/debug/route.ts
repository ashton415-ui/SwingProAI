import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const allCookies = req.cookies.getAll();
  const supabaseCookie = allCookies.find(c => c.name === "sb-atlmnqispyzhsahahpjy-auth-token");

  const supabase = await createClient();

  const sessionResult = await supabase.auth.getSession();
  const userResult = await supabase.auth.getUser();

  return NextResponse.json({
    cookieCount: allCookies.length,
    supabaseCookieFound: !!supabaseCookie,
    getSession: {
      hasSession: !!sessionResult.data.session,
      error: sessionResult.error?.message ?? null,
      userId: sessionResult.data.session?.user?.id ?? null,
    },
    getUser: {
      hasUser: !!userResult.data.user,
      error: userResult.error?.message ?? null,
      userId: userResult.data.user?.id ?? null,
    },
  });
}
