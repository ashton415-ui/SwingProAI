import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Clock, BookOpen, Target, CheckCircle2 } from 'lucide-react';

interface LessonContent {
  id: string;
  title: string;
  duration: string;
  level: string;
  intro: string;
  sections: { heading: string; body: string }[];
  keyPoints: string[];
  drill: { title: string; steps: string[] };
}

const LESSON_CONTENT: Record<string, LessonContent> = {
  'setup-fundamentals': {
    id: 'setup-fundamentals',
    title: 'Setup & Address Fundamentals',
    duration: '8 min',
    level: 'Beginner',
    intro:
      'Before you can develop a consistent swing, you need a consistent setup. Tour pros attribute up to 80% of their ball-striking quality to their pre-shot routine and address position.',
    sections: [
      {
        heading: 'Grip Pressure',
        body:
          'Hold the club with the same pressure you\'d use to hold a tube of toothpaste without squeezing paste out — firm enough to keep control, light enough that your forearms stay relaxed. Tension in the hands travels up the arms and kills club-head speed.',
      },
      {
        heading: 'Stance Width',
        body:
          'For full shots, your feet should be roughly shoulder-width apart (measured inside of heels). For short irons go slightly narrower; for the driver go slightly wider. A wider base increases stability during the hip turn; a narrower one makes it easier to shift weight.',
      },
      {
        heading: 'Ball Position',
        body:
          'Ball position moves forward as loft decreases: short irons (center), mid-irons (1–2 inches forward of center), long irons and hybrids (3 inches forward), fairway woods (3–4 inches), driver (opposite left heel). Incorrect ball position is the single most common cause of directional errors.',
      },
      {
        heading: 'Spine Tilt & Posture',
        body:
          'Hinge forward at the hips (not the waist) until the club rests on the ground. Let your knees flex slightly — about 20–30°. Your spine should be straight, not hunched. Let your arms hang naturally from your shoulders. Maintain a slight secondary tilt away from the target to encourage an upward attack angle with the driver.',
      },
    ],
    keyPoints: [
      'Grip pressure: 4-5 out of 10',
      'Feet shoulder-width apart for full shots',
      'Ball position moves forward with longer clubs',
      'Hinge from the hips, not the waist',
      'Slight knee flex — athletically ready',
    ],
    drill: {
      title: 'Mirror Drill',
      steps: [
        'Stand in front of a full-length mirror in your practice setup.',
        'Check that your spine is straight and you\'ve hinged from the hips.',
        'Verify your arms hang below your shoulders — not reaching out.',
        'Take 10 practice address positions, stepping in fresh each time.',
        'Film from down the line to compare to tour pro setup images.',
      ],
    },
  },
  'takeaway-mechanics': {
    id: 'takeaway-mechanics',
    title: 'The Perfect Takeaway',
    duration: '10 min',
    level: 'Beginner',
    intro:
      'The takeaway sets the tone for everything that follows. A poor first 18 inches forces compensations throughout the backswing, downswing, and impact.',
    sections: [
      {
        heading: 'One-Piece Movement',
        body:
          'The takeaway should be a one-piece move: hands, arms, and shoulders all rotating together as one connected unit. Avoid letting the hands lead or the clubhead fan open independently.',
      },
      {
        heading: 'Club Path in the First 24 Inches',
        body:
          'As you rotate away, the clubhead should track along or just inside the target line for the first 12 inches, then naturally move to the inside as your body turns. Any early "over the top" tendency starts here.',
      },
      {
        heading: 'Wrist Hinge Timing',
        body:
          'Wrist hinge happens naturally as the club reaches parallel to the ground — not before. Early wrist hinge promotes a steep, out-to-in path. Let gravity and momentum set the wrists at the right moment.',
      },
    ],
    keyPoints: [
      'Hands, arms, and shoulders move together',
      'Clubhead stays connected to the body turn',
      'No early wrist hinge in the first 18 inches',
      'Trail elbow stays soft and close to the body',
    ],
    drill: {
      title: 'Alignment Stick Takeaway Drill',
      steps: [
        'Place an alignment stick along your target line, just outside the ball.',
        'Take your address position and rehearse the takeaway slowly.',
        'The grip should stay level or slightly above the hands at the halfway point.',
        'Check that the toe of the club points straight up when the shaft is parallel to the ground.',
        'Repeat 20 times slowly before hitting balls.',
      ],
    },
  },
  'swing-plane-101': {
    id: 'swing-plane-101',
    title: 'Swing Plane 101',
    duration: '12 min',
    level: 'Intermediate',
    intro:
      'Swing plane is the angle at which the club travels around your body. It dictates your shot shape, contact quality, and your ability to attack from the inside — the hallmark of tour-level ball-striking.',
    sections: [
      {
        heading: 'What Is Swing Plane?',
        body:
          'Imagine a pane of glass resting on your shoulders and running through the ball. An on-plane swing keeps the club shaft on or near this glass throughout the motion. Deviation above it creates an over-the-top, steep path; deviation below it creates an under-the-plane, shallow path.',
      },
      {
        heading: 'Over-the-Top',
        body:
          'The most common fault in amateur golf. The downswing begins with the shoulders, casting the club outside the target line. This produces an out-to-in swing path, leading to pulls, pull-cuts, and the dreaded slice.',
      },
      {
        heading: 'Under-Plane',
        body:
          'Less common. The club gets stuck too shallow behind the body, forcing you to flip your hands through impact to square the face. Results in pushes, push-draws, and inconsistent contact.',
      },
      {
        heading: 'The Solution: Transition',
        body:
          'A good on-plane swing starts the downswing with the lower body while the upper body and arms stay back. The right elbow drops in front of the right hip. This creates the slot that enables an inside attack angle.',
      },
    ],
    keyPoints: [
      'Swing plane is the angle of club travel around your body',
      'Over-the-top = steep, out-to-in = slice/pull',
      'Under-plane = stuck, in-to-out = push/push-draw',
      'Transition starts from the ground up',
      'Right elbow drops in front of hip on downswing',
    ],
    drill: {
      title: 'Headcover Under-Arm Drill',
      steps: [
        'Tuck a headcover under your trail arm, between your upper arm and body.',
        'Make a half-swing back and through.',
        'If the headcover falls on the downswing, your elbow is casting over the top.',
        'Focus on keeping the trail elbow connected through the transition.',
        'Once you can hold it through 20 consecutive reps, remove the headcover.',
      ],
    },
  },
};

export function generateStaticParams() {
  return Object.keys(LESSON_CONTENT).map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const lesson = LESSON_CONTENT[params.id];
  return { title: lesson ? `${lesson.title} — SwingMaster` : 'Lesson Not Found — SwingMaster' };
}

export default function LessonDetailPage({ params }: { params: { id: string } }) {
  const lesson = LESSON_CONTENT[params.id];
  if (!lesson) notFound();

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 sm:px-6">
      {/* Back */}
      <Link
        href="/lessons"
        className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-400 transition-colors mb-6"
      >
        <ChevronLeft className="w-3.5 h-3.5" /> All Lessons
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[9px] font-black uppercase tracking-widest bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded-full">
            {lesson.level}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-slate-600">
            <Clock className="w-3 h-3" /> {lesson.duration}
          </span>
        </div>
        <h1 className="text-2xl font-bold text-white tracking-tight">{lesson.title}</h1>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">{lesson.intro}</p>
      </div>

      {/* Content sections */}
      <div className="space-y-6 mb-8">
        {lesson.sections.map((sec, i) => (
          <div key={i} className="bg-slate-900 border border-white/10 rounded-2xl px-5 py-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center">
                <span className="text-[10px] font-black text-white">{i + 1}</span>
              </div>
              <h2 className="text-sm font-bold text-white">{sec.heading}</h2>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">{sec.body}</p>
          </div>
        ))}
      </div>

      {/* Key points */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-3.5 h-3.5 text-indigo-400" />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">Key Takeaways</p>
        </div>
        <div className="space-y-2">
          {lesson.keyPoints.map((pt, i) => (
            <div key={i} className="flex items-start gap-3">
              <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
              <p className="text-sm text-slate-300">{pt}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Drill */}
      <div className="bg-indigo-500/[0.06] border border-indigo-500/20 rounded-2xl px-5 py-5">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="w-4 h-4 text-indigo-400" />
          <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400">Practice Drill</p>
        </div>
        <h3 className="text-sm font-bold text-white mb-4">{lesson.drill.title}</h3>
        <div className="space-y-3">
          {lesson.drill.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="shrink-0 w-5 h-5 rounded-full bg-indigo-600/40 border border-indigo-500/30 flex items-center justify-center text-[10px] font-black text-indigo-300 mt-0.5">
                {i + 1}
              </span>
              <p className="text-sm text-slate-300 leading-relaxed">{step}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
