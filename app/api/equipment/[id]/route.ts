/**
 * swingmaster-web/app/api/equipment/route.ts
 * CRUD for user_equipment table.
 * GET  — list all equipment for current user
 * POST — create new equipment item
 */

import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET() {
  const supabase = createRouteHandlerClient({ cookies });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('user_equipment')
    .select('*')
    .eq('user_id', user.id)
    .order('club_type')
    .order('is_primary', { ascending: false })
    .order('created_at');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ equipment: data });
}

export async function POST(req: NextRequest) {
  const supabase = createRouteHandlerClient({ cookies });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // If setting as primary, unset other primaries of same type
  if (body.is_primary && body.club_type) {
    await supabase
      .from('user_equipment')
      .update({ is_primary: false })
      .eq('user_id', user.id)
      .eq('club_type', body.club_type as string);
  }

  const { data, error } = await supabase
    .from('user_equipment')
    .insert({ ...body, user_id: user.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ equipment: data }, { status: 201 });
}
