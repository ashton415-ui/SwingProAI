'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/utils/supabase/client';
import {
  Users, Loader2, Activity, Dumbbell, AlertTriangle,
  CheckCircle2, Clock, XCircle, Target, ChevronRight, ArrowLeft,
  Copy, Check, Share2,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Student {
  relationship_id: string;
  student_id: string;
  full_name: string;
  email: string;
  primary_launch_monitor_type: string | null;
  compliance_rate: number;
}

interface LMSession {
  id: string;
  club_path_deg: number | null;
  face_to_path_deg: number | null;
  attack_angle_deg: number | null;
  ball_speed_mph: number | null;
  device_type: string | null;
  session_date: string;
}

type PrescriptionStatus = 'active' | 'in_progress' | 'completed' | 'revoked';

interface Prescription {
  id: string;
  status: PrescriptionStatus;
  drill_name: string;
  drill_target_metric: string | null;
  assigned_at: string;
  completed_at: string | null;
  notes: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  PrescriptionStatus,
  { label: string; badge: string; iconColor: string; Icon: React.ElementType }
> = {
  active:      { label: 'Active',      badge: 'bg-indigo-500/10 border-indigo-500/25 text-indigo-400',  iconColor: 'text-indigo-400',  Icon: Target },
  in_progress: { label: 'In Progress', badge: 'bg-amber-500/10 border-amber-500/25 text-amber-400',    iconColor: 'text-amber-400',   Icon: Clock },
  completed:   { label: 'Completed',   badge: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400', iconColor: 'text-emerald-400', Icon: CheckCircle2 },
  revoked:     { label: 'Revoked',     badge: 'bg-slate-700/30 border-slate-600/20 text-slate-500',    iconColor: 'text-slate-600',   Icon: XCircle },
};

const NEXT_STATUS: Record<string, PrescriptionStatus> = {
  active: 'in_progress',
  in_progress: 'completed',
  completed: 'active',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function complianceBadge(rate: number) {
  if (rate >= 80) return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
  if (rate >= 50) return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
  if (rate === 0)  return 'bg-slate-700/30 border-slate-600/20 text-slate-500';
  return 'bg-red-500/10 border-red-500/20 text-red-400';
}

function fmt(value: number | null, suffix = ''): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}${suffix}`;
}

function fmtSpeed(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} mph`;
}

function isPathFlagged(value: number | null): boolean {
  return value !== null && Math.abs(value) > 3;
}

function computeCompliance(
  prescriptions: { status: string }[],
): number {
  const nonRevoked = prescriptions.filter(p => p.status !== 'revoked');
  if (nonRevoked.length === 0) return 0;
  const done = prescriptions.filter(p => p.status === 'completed').length;
  return Math.round((done / nonRevoked.length) * 100);
}

function initials(name: string, email: string): string {
  return (name || email).charAt(0).toUpperCase();
}

// ── TelemetryMatrix ───────────────────────────────────────────────────────────

function TelemetryMatrix({ session }: { session: LMSession | null }) {
  if (!session) {
    return (
      <div className="bg-slate-900 border border-white/[0.07] rounded-2xl px-5 py-8 text-center">
        <Activity className="w-7 h-7 text-slate-700 mx-auto mb-2" />
        <p className="text-sm text-slate-500">No launch monitor sessions on file.</p>
      </div>
    );
  }

  const cells = [
    {
      label: 'Club Path',
      value: fmt(session.club_path_deg, '°'),
      sub: 'Swing direction',
      flagged: isPathFlagged(session.club_path_deg),
    },
    {
      label: 'Face to Path',
      value: fmt(session.face_to_path_deg, '°'),
      sub: 'Curvature driver',
      flagged: isPathFlagged(session.face_to_path_deg),
    },
    {
      label: 'Attack Angle',
      value: fmt(session.attack_angle_deg, '°'),
      sub: 'Impact steepness',
      flagged: false,
    },
    {
      label: 'Ball Speed',
      value: fmtSpeed(session.ball_speed_mph),
      sub: 'Impact efficiency',
      flagged: false,
    },
  ];

  return (
    <div className="bg-slate-900 border border-white/[0.07] rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-indigo-400" />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Latest Session</p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-600">
          {session.device_type && (
            <span className="font-bold uppercase tracking-wider">{session.device_type}</span>
          )}
          <span>
            {new Date(session.session_date + 'T00:00:00').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-white/[0.06]">
        {cells.map(({ label, value, sub, flagged }) => (
          <div key={label} className={`px-4 py-4 ${flagged ? 'bg-red-500/[0.04]' : ''}`}>
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-1">{label}</p>
            <div className="flex items-baseline gap-1.5">
              <span className={`text-xl font-black tabular-nums ${flagged ? 'text-red-400' : 'text-white'}`}>
                {value}
              </span>
              {flagged && <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mb-0.5" />}
            </div>
            <p className="text-[10px] text-slate-600 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DrillItem ─────────────────────────────────────────────────────────────────

function DrillItem({
  prescription,
  onStatusChange,
  onRevoke,
  updating,
}: {
  prescription: Prescription;
  onStatusChange: (id: string, next: PrescriptionStatus) => void;
  onRevoke: (id: string) => void;
  updating: boolean;
}) {
  const cfg = STATUS_CONFIG[prescription.status];
  const { Icon, iconColor } = cfg;
  const isRevoked = prescription.status === 'revoked';

  return (
    <div className={`flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.02] ${isRevoked ? 'opacity-40' : ''}`}>
      <button
        disabled={updating || isRevoked}
        onClick={() =>
          onStatusChange(prescription.id, NEXT_STATUS[prescription.status] ?? 'active')
        }
        className="shrink-0 mt-0.5 disabled:cursor-default"
        title={isRevoked ? 'Revoked' : `Advance to ${NEXT_STATUS[prescription.status]}`}
      >
        {updating
          ? <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
          : <Icon className={`w-4 h-4 ${iconColor}`} />
        }
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className={`text-sm font-semibold ${isRevoked ? 'line-through text-slate-600' : 'text-white'}`}>
            {prescription.drill_name}
          </p>
          <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${cfg.badge}`}>
            {cfg.label}
          </span>
        </div>
        {prescription.drill_target_metric && (
          <p className="text-[10px] text-slate-600 mt-0.5">{prescription.drill_target_metric}</p>
        )}
        {prescription.notes && (
          <p className="text-[11px] text-slate-500 mt-1 italic">{prescription.notes}</p>
        )}
      </div>

      {!isRevoked && (
        <button
          disabled={updating}
          onClick={() => onRevoke(prescription.id)}
          className="shrink-0 text-[10px] font-semibold text-slate-700 hover:text-red-400 transition-colors disabled:cursor-default"
        >
          Revoke
        </button>
      )}
    </div>
  );
}

// ── InviteCard ────────────────────────────────────────────────────────────────

function InviteCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore — clipboard blocked */ }
  }

  return (
    <div className="mx-2 mt-2 mb-1 bg-indigo-600/10 border border-indigo-500/20 rounded-2xl px-4 py-3.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Share2 className="w-3 h-3 text-indigo-400" />
        <p className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Your Invite Code</p>
      </div>
      <p className="text-[10px] text-slate-500 mb-2.5">
        Share this with students to connect instantly.
      </p>
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-slate-900/70 border border-white/10 rounded-xl py-2 text-center">
          <span className="text-2xl font-black tracking-[0.3em] text-white font-mono select-all">
            {code}
          </span>
        </div>
        <button
          onClick={copy}
          className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl transition-colors ${
            copied
              ? 'bg-emerald-600 text-white'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          {copied
            ? <><Check className="w-3.5 h-3.5" /> Copied!</>
            : <><Copy className="w-3.5 h-3.5" /> Copy</>
          }
        </button>
      </div>
    </div>
  );
}

// ── RosterItem ────────────────────────────────────────────────────────────────

function RosterItem({
  student,
  selected,
  onClick,
}: {
  student: Student;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
        selected
          ? 'bg-indigo-600/20 border border-indigo-500/30'
          : 'border border-transparent hover:bg-white/[0.04]'
      }`}
    >
      <div className="w-8 h-8 rounded-lg bg-slate-800 border border-white/10 flex items-center justify-center shrink-0">
        <span className="text-[11px] font-black text-slate-400">
          {initials(student.full_name, student.email)}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">
          {student.full_name || student.email}
        </p>
        <p className="text-[10px] text-slate-500 truncate mt-0.5">
          {student.primary_launch_monitor_type ?? 'No device'}
        </p>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1">
        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${complianceBadge(student.compliance_rate)}`}>
          {student.compliance_rate}%
        </span>
        <ChevronRight className="w-3 h-3 text-slate-700" />
      </div>
    </button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CoachHubPage() {
  const supabase = useMemo(() => createClient(), []);

  const [loadingRoster, setLoadingRoster] = useState(true);
  const [roster, setRoster] = useState<Student[]>([]);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const [loadingDetail, setLoadingDetail] = useState(false);
  const [latestSession, setLatestSession] = useState<LMSession | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  // ── Roster load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      setLoadingRoster(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoadingRoster(false); return; }

      // Fetch coach's own invite code alongside roster
      const { data: profile } = await supabase
        .from('users')
        .select('coach_invite_code')
        .eq('id', user.id)
        .single();
      setInviteCode(profile?.coach_invite_code ?? null);

      const { data: rels } = await supabase
        .from('coach_student_relationships')
        .select('id, student_id, primary_launch_monitor_type')
        .eq('coach_id', user.id)
        .eq('status', 'active');

      if (!rels?.length) { setLoadingRoster(false); return; }

      const studentIds = rels.map(r => r.student_id);

      const [{ data: profiles }, { data: allPx }] = await Promise.all([
        supabase
          .from('users')
          .select('id, full_name, email')
          .in('id', studentIds),
        supabase
          .from('automated_prescriptions')
          .select('student_id, status')
          .eq('coach_id', user.id)
          .in('student_id', studentIds),
      ]);

      const profileMap = new Map((profiles ?? []).map(p => [p.id, p]));

      const students: Student[] = rels.map(rel => {
        const profile = profileMap.get(rel.student_id);
        const studentPx = (allPx ?? []).filter(p => p.student_id === rel.student_id);

        return {
          relationship_id: rel.id,
          student_id: rel.student_id,
          full_name: profile?.full_name ?? '',
          email: profile?.email ?? '',
          primary_launch_monitor_type: rel.primary_launch_monitor_type,
          compliance_rate: computeCompliance(studentPx),
        };
      });

      setRoster(students);
      setLoadingRoster(false);
    })();
  }, [supabase]);

  // ── Student detail load ──────────────────────────────────────────────────────
  const loadDetail = useCallback(
    async (studentId: string) => {
      setLoadingDetail(true);
      setLatestSession(null);
      setPrescriptions([]);

      const [{ data: sessions }, { data: pxRows }] = await Promise.all([
        supabase
          .from('launch_monitor_sessions')
          .select('id, club_path_deg, face_to_path_deg, attack_angle_deg, ball_speed_mph, device_type, session_date')
          .eq('student_id', studentId)
          .order('session_date', { ascending: false })
          .limit(1),
        supabase
          .from('automated_prescriptions')
          .select('id, status, notes, assigned_at, completed_at, drill:drills(name, target_metric)')
          .eq('student_id', studentId)
          .order('assigned_at', { ascending: false }),
      ]);

      setLatestSession(sessions?.[0] ?? null);
      setPrescriptions(
        (pxRows ?? []).map(px => {
          const drill = px.drill as { name?: string; target_metric?: string } | null;
          return {
            id: px.id,
            status: px.status as PrescriptionStatus,
            drill_name: drill?.name ?? 'Unknown Drill',
            drill_target_metric: drill?.target_metric ?? null,
            assigned_at: px.assigned_at,
            completed_at: px.completed_at,
            notes: px.notes,
          };
        }),
      );

      setLoadingDetail(false);
    },
    [supabase],
  );

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // ── Prescription mutations ───────────────────────────────────────────────────
  async function handleStatusChange(id: string, next: PrescriptionStatus) {
    setUpdatingId(id);
    const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() };
    if (next === 'completed') patch.completed_at = new Date().toISOString();

    await supabase.from('automated_prescriptions').update(patch).eq('id', id);

    setPrescriptions(prev => {
      const updated = prev.map(p =>
        p.id === id ? { ...p, status: next, completed_at: (patch.completed_at as string) ?? p.completed_at } : p,
      );
      if (selectedId) {
        setRoster(r =>
          r.map(s =>
            s.student_id === selectedId
              ? { ...s, compliance_rate: computeCompliance(updated) }
              : s,
          ),
        );
      }
      return updated;
    });
    setUpdatingId(null);
  }

  async function handleRevoke(id: string) {
    setUpdatingId(id);
    await supabase
      .from('automated_prescriptions')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', id);

    setPrescriptions(prev => {
      const updated = prev.map(p => (p.id === id ? { ...p, status: 'revoked' as PrescriptionStatus } : p));
      if (selectedId) {
        setRoster(r =>
          r.map(s =>
            s.student_id === selectedId
              ? { ...s, compliance_rate: computeCompliance(updated) }
              : s,
          ),
        );
      }
      return updated;
    });
    setUpdatingId(null);
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const selectedStudent = roster.find(s => s.student_id === selectedId) ?? null;
  const activePx      = prescriptions.filter(p => p.status === 'active');
  const inProgressPx  = prescriptions.filter(p => p.status === 'in_progress');
  const completedPx   = prescriptions.filter(p => p.status === 'completed');
  const revokedPx     = prescriptions.filter(p => p.status === 'revoked');
  const orderedPx     = [...activePx, ...inProgressPx, ...completedPx, ...revokedPx];
  const nonRevoked    = prescriptions.filter(p => p.status !== 'revoked');

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex md:h-screen md:overflow-hidden">

      {/* ── Roster sidebar ──────────────────────────────────────────────────── */}
      <aside
        className={`
          flex flex-col shrink-0 w-full md:w-72 border-r border-white/[0.07] bg-slate-950
          md:sticky md:top-0 md:h-screen md:overflow-y-auto
          ${mobileShowDetail ? 'hidden md:flex' : 'flex'}
        `}
      >
        {/* Header */}
        <div className="px-4 py-4 border-b border-white/[0.07] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center">
              <Users className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-none">Coach Hub</h1>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {loadingRoster ? 'Loading…' : `${roster.length} active student${roster.length !== 1 ? 's' : ''}`}
              </p>
            </div>
          </div>
        </div>

        {/* Invite card */}
        {inviteCode && <InviteCard code={inviteCode} />}

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {loadingRoster ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
            </div>
          ) : roster.length === 0 ? (
            <div className="text-center py-14 px-4">
              <Users className="w-8 h-8 text-slate-700 mx-auto mb-2" />
              <p className="text-sm text-slate-500 font-medium">No active students</p>
              <p className="text-xs text-slate-700 mt-1">Invite students to your roster to get started.</p>
            </div>
          ) : (
            roster.map(student => (
              <RosterItem
                key={student.student_id}
                student={student}
                selected={selectedId === student.student_id}
                onClick={() => {
                  setSelectedId(student.student_id);
                  setMobileShowDetail(true);
                }}
              />
            ))
          )}
        </div>
      </aside>

      {/* ── Detail panel ────────────────────────────────────────────────────── */}
      <div
        className={`
          flex-1 min-w-0 overflow-y-auto pb-20 md:pb-0
          ${mobileShowDetail ? 'block' : 'hidden md:block'}
        `}
      >
        {/* Mobile back */}
        {mobileShowDetail && (
          <div className="md:hidden px-4 pt-4 mb-2">
            <button
              onClick={() => setMobileShowDetail(false)}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to roster
            </button>
          </div>
        )}

        {!selectedId ? (
          /* Empty state — desktop only, mobile shows roster */
          <div className="hidden md:flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-white/[0.07] flex items-center justify-center mb-4">
              <Users className="w-7 h-7 text-slate-700" />
            </div>
            <p className="text-base font-bold text-white">Select a golfer from your roster to view telemetry.</p>
            <p className="text-sm text-slate-500 mt-1 max-w-xs">
              Training status, launch monitor data, and drill compliance will appear here.
            </p>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-4 py-6 sm:px-6 space-y-6">

            {/* Student header */}
            {selectedStudent && (
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800 border border-white/10 flex items-center justify-center shrink-0">
                  <span className="text-sm font-black text-slate-300">
                    {initials(selectedStudent.full_name, selectedStudent.email)}
                  </span>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white leading-tight">
                    {selectedStudent.full_name || selectedStudent.email}
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                    <span className="text-xs text-slate-500">{selectedStudent.email}</span>
                    {selectedStudent.primary_launch_monitor_type && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          {selectedStudent.primary_launch_monitor_type}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {loadingDetail ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
              </div>
            ) : (
              <>
                {/* ── Telemetry Matrix ─────────────────────────────────────── */}
                <section>
                  <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-3">
                    Telemetry Matrix
                  </p>
                  <TelemetryMatrix session={latestSession} />
                </section>

                {/* ── Drill Compliance ─────────────────────────────────────── */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-600">
                      Drill Compliance
                    </p>
                    {nonRevoked.length > 0 && (
                      <span className="text-[10px] text-slate-600">
                        {completedPx.length} / {nonRevoked.length} completed
                      </span>
                    )}
                  </div>

                  {orderedPx.length === 0 ? (
                    <div className="bg-slate-900 border border-white/[0.07] rounded-2xl px-5 py-8 text-center">
                      <Dumbbell className="w-7 h-7 text-slate-700 mx-auto mb-2" />
                      <p className="text-sm text-slate-500">No drills assigned yet.</p>
                    </div>
                  ) : (
                    <div className="bg-slate-900 border border-white/[0.07] rounded-2xl overflow-hidden divide-y divide-white/[0.05]">
                      {orderedPx.map(px => (
                        <DrillItem
                          key={px.id}
                          prescription={px}
                          onStatusChange={handleStatusChange}
                          onRevoke={handleRevoke}
                          updating={updatingId === px.id}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
