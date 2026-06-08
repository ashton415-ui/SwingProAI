import Link from 'next/link';
import { BookOpen, Clock, Lock, ChevronRight, Zap } from 'lucide-react';

export const metadata = { title: 'Lessons — SwingMaster' };

interface Lesson {
  id: string;
  title: string;
  description: string;
  duration: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  locked: boolean;
  category: string;
}

const LESSONS: Lesson[] = [
  {
    id: 'setup-fundamentals',
    title: 'Setup & Address Fundamentals',
    description: 'Grip pressure, stance width, ball position, and spine tilt. The foundation of every repeatable swing.',
    duration: '8 min',
    level: 'beginner',
    locked: false,
    category: 'Foundations',
  },
  {
    id: 'takeaway-mechanics',
    title: 'The Perfect Takeaway',
    description: 'One-piece takeaway, club path in the first 24 inches, and avoiding early wrist hinge.',
    duration: '10 min',
    level: 'beginner',
    locked: false,
    category: 'Foundations',
  },
  {
    id: 'swing-plane-101',
    title: 'Swing Plane 101',
    description: 'Understanding on-plane vs. over-the-top vs. under-plane, and why it dictates your shot shape.',
    duration: '12 min',
    level: 'intermediate',
    locked: false,
    category: 'Mechanics',
  },
  {
    id: 'hip-rotation-power',
    title: 'Hip Rotation & Power Generation',
    description: 'How to sequence your downswing for maximum club head speed without sacrificing contact quality.',
    duration: '15 min',
    level: 'intermediate',
    locked: true,
    category: 'Power',
  },
  {
    id: 'impact-position',
    title: 'Mastering Impact Position',
    description: 'Forward shaft lean, lag retention, and how tour players compress the ball differently than amateurs.',
    duration: '14 min',
    level: 'intermediate',
    locked: true,
    category: 'Mechanics',
  },
  {
    id: 'short-game-masterclass',
    title: 'Short Game Masterclass',
    description: 'Pitch shots, bump-and-runs, bunker play, and the 100-yard-and-in scoring zone.',
    duration: '20 min',
    level: 'advanced',
    locked: true,
    category: 'Short Game',
  },
  {
    id: 'driver-distance',
    title: 'Add 20 Yards with Your Driver',
    description: 'Attack angle, launch conditions, gear effect, and why your spin rate is costing you distance.',
    duration: '18 min',
    level: 'advanced',
    locked: true,
    category: 'Power',
  },
];

const LEVEL_STYLE = {
  beginner:     'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
  intermediate: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400',
  advanced:     'bg-amber-500/10 border-amber-500/20 text-amber-400',
};

const CATEGORIES = Array.from(new Set(LESSONS.map((l) => l.category)));

export default function LessonsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Lessons</h1>
        <p className="text-sm text-slate-400 mt-1">Structured coaching programs built on biomechanics.</p>
      </div>

      {CATEGORIES.map((cat) => {
        const items = LESSONS.filter((l) => l.category === cat);
        return (
          <div key={cat}>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-600 mb-3">{cat}</p>
            <div className="space-y-2">
              {items.map((lesson) => (
                <Link
                  key={lesson.id}
                  href={lesson.locked ? '/upgrade' : `/lessons/${lesson.id}`}
                  className="flex items-start gap-4 bg-slate-900 border border-white/10 rounded-2xl px-5 py-4 hover:bg-slate-800 transition-colors"
                >
                  <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center mt-0.5 ${
                    lesson.locked ? 'bg-slate-800 border border-white/5' : 'bg-indigo-600/20 border border-indigo-500/20'
                  }`}>
                    {lesson.locked ? <Lock className="w-3.5 h-3.5 text-slate-600" /> : <BookOpen className="w-3.5 h-3.5 text-indigo-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-sm font-semibold ${lesson.locked ? 'text-slate-500' : 'text-white'}`}>
                        {lesson.title}
                      </p>
                      <span className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full border ${LEVEL_STYLE[lesson.level]}`}>
                        {lesson.level}
                      </span>
                    </div>
                    <p className={`text-xs mt-1 leading-relaxed ${lesson.locked ? 'text-slate-700' : 'text-slate-500'}`}>
                      {lesson.description}
                    </p>
                    <div className="flex items-center gap-1.5 mt-2">
                      <Clock className="w-3 h-3 text-slate-700" />
                      <span className="text-[10px] text-slate-600">{lesson.duration}</span>
                    </div>
                  </div>
                  <div className="shrink-0 mt-1">
                    {lesson.locked
                      ? <Zap className="w-4 h-4 text-amber-500" />
                      : <ChevronRight className="w-4 h-4 text-slate-700" />
                    }
                  </div>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
