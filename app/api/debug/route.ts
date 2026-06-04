import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const allCookies = req.cookies.getAll();
  const supabaseCookies = allCookies.filter(c => c.name.startsWith("sb-"));

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();

  return NextResponse.json({
    cookieCount: allCookies.length,
    supabaseCookieCount: supabaseCookies.length,
    supabaseCookieNames: supabaseCookies.map(c => c.name),
    hasSession: !!session,
    userId: session?.user?.id ?? null,
    email: session?.user?.email ?? null,
  });
}
