import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSsrClient } from '@/utils/supabase/server';
import { createClient } from '@supabase/supabase-js';

// ── Service client — bypasses RLS for trusted server-side writes ──────────────

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface IngestBody {
  student_id: string;
  source: string;
  payload: Record<string, unknown>;
}

interface NormalizedMetrics {
  device_type: string;
  club_path_deg: number | null;
  face_to_path_deg: number | null;
  attack_angle_deg: number | null;
  ball_speed_mph: number | null;
}

interface Fault {
  diagnosis: string;
  drill_name: string;
}

interface PrescriptionResult {
  prescription_id: string;
  drill_id: string;
  drill_name: string;
  diagnosis: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function obj(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' && !Array.isArray(v))
    ? (v as Record<string, unknown>)
    : {};
}

// ── Adapters ──────────────────────────────────────────────────────────────────

function adaptTrackman(p: Record<string, unknown>): NormalizedMetrics {
  return {
    device_type: 'trackman',
    club_path_deg:    toNum(p.ClubPath),
    face_to_path_deg: toNum(p.FaceToPath),
    attack_angle_deg: toNum(p.AttackAngle),
    ball_speed_mph:   toNum(p.BallSpeed),
  };
}

function adaptForesight(p: Record<string, unknown>): NormalizedMetrics {
  return {
    device_type: 'foresight',
    club_path_deg:    toNum(p.Path),
    face_to_path_deg: toNum(p.F_to_P),
    attack_angle_deg: toNum(p.AoA),
    ball_speed_mph:   toNum(p.BallSpeed),
  };
}

function adaptFlightscope(p: Record<string, unknown>): NormalizedMetrics {
  const cd = obj(p.clubData);
  const bd = obj(p.ballData);
  return {
    device_type: 'flightscope',
    club_path_deg:    toNum(cd.path),
    face_to_path_deg: toNum(cd.faceToPath),
    attack_angle_deg: toNum(cd.attackAngle),
    ball_speed_mph:   toNum(bd.speed),
  };
}

// ── Logic engine ──────────────────────────────────────────────────────────────

function prescribeDrills(m: NormalizedMetrics): Fault[] {
  const { club_path_deg: cp, face_to_path_deg: fp, attack_angle_deg: aa } = m;
  const faults: Fault[] = [];

  // Out-to-in path + open face relative to path = slice pattern
  if (cp !== null && fp !== null && cp < -3 && fp > 2) {
    faults.push({ diagnosis: 'Over-The-Top Slice', drill_name: 'Pump Drill' });
  }

  // Steep downswing (too negative attack angle)
  if (aa !== null && aa < -5) {
    faults.push({ diagnosis: 'Too Steep', drill_name: 'Shaft Plane Stick Drill' });
  }

  // In-to-out path + closed face relative to path = hook pattern
  if (cp !== null && fp !== null && cp > 3 && fp < -2) {
    faults.push({ diagnosis: 'Inside-Out Hook', drill_name: 'Towel Under Arm' });
  }

  return faults;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. Authenticate caller
  const authClient = createSsrClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Parse request body
  let body: IngestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { student_id, source, payload } = body;

  if (!student_id || typeof student_id !== 'string') {
    return NextResponse.json({ error: 'student_id (string) is required.' }, { status: 400 });
  }
  if (!source || typeof source !== 'string') {
    return NextResponse.json({ error: 'source (string) is required.' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'payload must be a JSON object.' }, { status: 400 });
  }

  // 3. Initialise service client
  let db: ReturnType<typeof serviceClient>;
  try {
    db = serviceClient();
  } catch (e) {
    console.error('[ingest]', e);
    return NextResponse.json({ error: 'Server misconfiguration — service key missing.' }, { status: 503 });
  }

  // 4. Authorise: must be the student themselves or their linked coach
  const isStudent = user.id === student_id;
  if (!isStudent) {
    const { data: rel } = await db
      .from('coach_student_relationships')
      .select('id')
      .eq('coach_id', user.id)
      .eq('student_id', student_id)
      .eq('status', 'active')
      .maybeSingle();

    if (!rel) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }
  }

  // 5. Adapt payload to normalised metrics
  const src = source.toLowerCase().trim();
  let metrics: NormalizedMetrics;

  switch (src) {
    case 'trackman':
      metrics = adaptTrackman(payload);
      break;
    case 'foresight':
      metrics = adaptForesight(payload);
      break;
    case 'flightscope':
    case 'mevo':
      metrics = adaptFlightscope(payload);
      break;
    default:
      return NextResponse.json(
        { error: `Unsupported source "${source}". Valid values: trackman, foresight, flightscope.` },
        { status: 400 },
      );
  }

  // 6. Persist the normalised session
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { data: sessionRow, error: sessionErr } = await db
    .from('launch_monitor_sessions')
    .insert({
      student_id,
      coach_id:         isStudent ? null : user.id,
      device_type:      metrics.device_type,
      session_date:     today,
      club_path_deg:    metrics.club_path_deg,
      face_to_path_deg: metrics.face_to_path_deg,
      attack_angle_deg: metrics.attack_angle_deg,
      ball_speed_mph:   metrics.ball_speed_mph,
    })
    .select('id')
    .single();

  if (sessionErr || !sessionRow) {
    console.error('[ingest] session insert failed:', sessionErr?.message);
    return NextResponse.json({ error: 'Failed to store session.' }, { status: 500 });
  }

  const sessionId = sessionRow.id as string;

  // 7. Diagnose faults and auto-prescribe drills
  const faults = prescribeDrills(metrics);
  const prescriptions: PrescriptionResult[] = [];

  if (faults.length > 0) {
    // Resolve coach attribution: the caller if they are the coach, or the
    // student's linked coach if the student submitted their own data.
    let coachId: string | null = isStudent ? null : user.id;
    if (isStudent) {
      const { data: rel } = await db
        .from('coach_student_relationships')
        .select('coach_id')
        .eq('student_id', student_id)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      coachId = (rel?.coach_id as string) ?? null;
    }

    // Batch-resolve drill IDs by name (avoids hardcoding UUIDs)
    const drillNames = Array.from(new Set(faults.map(f => f.drill_name)));
    const { data: drillRows } = await db
      .from('drills')
      .select('id, name')
      .in('name', drillNames);

    const drillMap = new Map<string, string>(
      (drillRows ?? []).map(d => [d.name as string, d.id as string]),
    );

    for (const fault of faults) {
      const drillId = drillMap.get(fault.drill_name);
      if (!drillId) {
        console.warn(`[ingest] drill not found in DB: "${fault.drill_name}"`);
        continue;
      }

      const { data: px, error: pxErr } = await db
        .from('automated_prescriptions')
        .insert({
          coach_id:   coachId,
          student_id,
          drill_id:   drillId,
          session_id: sessionId,
          status:     'active',
          notes:      `Auto-diagnosed: ${fault.diagnosis}`,
        })
        .select('id')
        .single();

      if (pxErr) {
        console.error('[ingest] prescription insert failed:', pxErr.message);
        continue;
      }

      prescriptions.push({
        prescription_id: px!.id as string,
        drill_id:        drillId,
        drill_name:      fault.drill_name,
        diagnosis:       fault.diagnosis,
      });
    }
  }

  // 8. Return structured response
  return NextResponse.json({
    ok: true,
    session_id:      sessionId,
    source:          src,
    normalized: {
      club_path_deg:    metrics.club_path_deg,
      face_to_path_deg: metrics.face_to_path_deg,
      attack_angle_deg: metrics.attack_angle_deg,
      ball_speed_mph:   metrics.ball_speed_mph,
    },
    faults_diagnosed: faults.length,
    prescriptions,
  });
}
