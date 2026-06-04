import { NextResponse } from "next/server";
import { getServerSession } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession();

  return NextResponse.json({
    hasSession: !!session,
    userId: session?.user?.id ?? null,
    email: session?.user?.email ?? null,
    expiresAt: session?.expires_at ?? null,
  });
}
