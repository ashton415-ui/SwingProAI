import { NextResponse } from "next/server";
import { getServerSession } from "@/utils/supabase/server";

/**
 * POST /api/v1/analyze — retired (ENT-1D).
 *
 * This route sent a base64 video from the request body straight to the AI
 * backend on every call. It created no analysis record, so it could not take
 * the shared execution claim: nothing stopped repeated or concurrent provider
 * calls, nothing fenced a result, and it processed raw video synchronously in
 * a web route. No client in this repository calls it.
 *
 * Analysis now has one execution path: POST /api/v1/analyses creates the
 * owned request, and POST /api/analyze-swing runs it under the claim. This
 * route authenticates and then answers 410 Gone. It reads no body and calls
 * no provider.
 */

export async function POST(_request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(
    { error: "This endpoint has been retired. Create an analysis with POST /api/v1/analyses." },
    { status: 410 },
  );
}
