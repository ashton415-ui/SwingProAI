import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const allCookies = req.cookies.getAll();
  const supabaseCookies = allCookies.filter(c => c.name.startsWith("sb-"));

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();

  // Check env vars are present (don't expose values)
  const envCheck = {
    hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    hasSupabaseKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseUrlPrefix: process.env.NEXT_PUBLIC_SUPABASE_URL?.slice(0, 30) ?? "MISSING",
  };

  return NextResponse.json({
    cookieCount: allCookies.length,
    allCookieNames: allCookies.map(c => c.name),
    supabaseCookieCount: supabaseCookies.length,
    supabaseCookieNames: supabaseCookies.map(c => c.name),
    hasSession: !!session,
    userId: session?.user?.id ?? null,
    email: session?.user?.email ?? null,
    envCheck,
  });
}
