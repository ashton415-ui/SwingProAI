'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { linkStudentToCoach } from '@/app/actions/coach';
import { UserPlus, CheckCircle2, Loader2 } from 'lucide-react';

export default function ConnectToCoachForm() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || isPending) return;

    startTransition(() => {
      linkStudentToCoach(code).then((result) => {
        if (result.success) {
          setSuccess(true);
          router.refresh();
        } else {
          setError(result.error ?? 'Something went wrong.');
        }
      });
    });
  }

  if (success) {
    return (
      <div className="flex items-center gap-3 bg-emerald-500/[0.06] border border-emerald-500/20 rounded-2xl px-5 py-4">
        <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-white">Coach connected!</p>
          <p className="text-xs text-slate-400 mt-0.5">Your coach can now view your training data.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-white/10 rounded-2xl px-5 py-4">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus className="w-4 h-4 text-indigo-400 shrink-0" />
        <p className="text-sm font-semibold text-white">Connect to Your Coach</p>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Enter the 6-character code your coach shared with you.
      </p>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={handleInput}
          placeholder="AJP482"
          maxLength={6}
          spellCheck={false}
          disabled={isPending}
          className="flex-1 min-w-0 bg-slate-800 border border-white/10 focus:border-indigo-500/60 outline-none
            text-sm font-mono font-bold text-white placeholder-slate-600 tracking-[0.2em] uppercase
            rounded-xl px-3 py-2.5 transition-colors"
        />
        <button
          type="submit"
          disabled={code.length !== 6 || isPending}
          className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500
            disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold
            rounded-xl transition-colors"
        >
          {isPending
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : 'Connect'
          }
        </button>
      </form>

      {error && (
        <p className="text-xs text-red-400 mt-2 leading-snug">{error}</p>
      )}
    </div>
  );
}
