import { createClient } from '@/utils/supabase/server';
import { NextResponse, type NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const loginUrl = new URL('/login', request.url);
  return NextResponse.redirect(loginUrl, { status: 302 });
}
