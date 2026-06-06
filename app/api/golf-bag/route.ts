/**
 * swingmaster-web/app/api/golf-bag/route.ts
 * CRUD handler for the user_golf_bag table.
 * GET  — fetch the current user's bag
 * POST — upsert (create or update) the current user's bag
 * DELETE — remove the bag record
 *
 * Auth: Modern Supabase Async Server Client
 * RLS: user_id is enforced at DB level; no manual filter needed for SELECT/DELETE.
 */

import { createClient } from "@/utils/supabase/server";
import { NextResponse, type NextRequest } from 'next/server';
import type { GolfBagUpsert } from '@/lib/types/swing';

// ---------------------------------------------------------------------------
// GET /api/golf-bag
// ---------------------------------------------------------------------------
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('user_golf_bag')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[GET /api/golf-bag]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bag: data });
}

// ---------------------------------------------------------------------------
// POST /api/golf-bag  — upsert
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Partial<GolfBagUpsert>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('user_golf_bag')
    .upsert(
      { ...body, user_id: user.id },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('[POST /api/golf-bag]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bag: data }, { status: 200 });
}

// ---------------------------------------------------------------------------
// DELETE /api/golf-bag
// ---------------------------------------------------------------------------
export async function DELETE() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { error } = await supabase
    .from('user_golf_bag')
    .delete()
    .eq('user_id', user.id);

  if (error) {
    console.error('[DELETE /api/golf-bag]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}