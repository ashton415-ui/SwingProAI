'use client';

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Send, Loader2, Bot, User, Zap, Sparkles } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const STARTER_PROMPTS = [
  'Why does my driver always go left?',
  'How do I stop coming over the top?',
  'Tips for a more consistent impact position',
  'What drill fixes early extension?',
];

export default function CoachPage() {
  const supabase = createClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(text?: string) {
    const userContent = (text ?? input).trim();
    if (!userContent || loading) return;
    setInput('');
    const next = [...messages, { role: 'user' as const, content: userContent }];
    setMessages(next);
    setLoading(true);

    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const json = await res.json();
      setMessages([...next, { role: 'assistant', content: json.reply ?? 'Sorry, I couldn\'t respond. Try again.' }]);
    } catch {
      setMessages([...next, { role: 'assistant', content: 'Network error. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] max-h-[calc(100dvh-3.5rem)]">
      {/* Header */}
      <div className="shrink-0 border-b border-white/[0.07] px-4 py-4 sm:px-6">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white leading-none">AI Golf Coach</h1>
            <p className="text-[10px] text-slate-500 mt-0.5">Ask anything about your swing</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-6 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center pt-10 text-center space-y-6">
              <div className="w-16 h-16 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
                <Sparkles className="w-7 h-7 text-indigo-400" />
              </div>
              <div>
                <p className="text-base font-bold text-white">Your AI Coach is ready</p>
                <p className="text-sm text-slate-500 mt-1">Ask about swing mechanics, drills, or course management.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                {STARTER_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => send(p)}
                    className="text-left text-xs font-medium text-slate-400 bg-slate-900 hover:bg-slate-800 border border-white/[0.07] hover:border-white/15 rounded-xl px-4 py-3 transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="shrink-0 w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center mt-0.5">
                  <Bot className="w-3.5 h-3.5 text-indigo-400" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-tr-sm'
                    : 'bg-slate-900 border border-white/[0.07] text-slate-200 rounded-tl-sm'
                }`}
              >
                {m.content.split('\n').map((line, li) => (
                  <span key={li}>{line}{li < m.content.split('\n').length - 1 ? <br /> : null}</span>
                ))}
              </div>
              {m.role === 'user' && (
                <div className="shrink-0 w-7 h-7 rounded-lg bg-slate-800 border border-white/10 flex items-center justify-center mt-0.5">
                  <User className="w-3.5 h-3.5 text-slate-400" />
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center">
                <Bot className="w-3.5 h-3.5 text-indigo-400" />
              </div>
              <div className="bg-slate-900 border border-white/[0.07] rounded-2xl rounded-tl-sm px-4 py-3.5">
                <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-white/[0.07] px-4 py-4 sm:px-6">
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Ask your coach something…"
            disabled={loading}
            className="flex-1 bg-slate-900 border border-white/10 focus:border-indigo-500/60 outline-none text-sm text-white placeholder-slate-600 rounded-xl px-4 py-3 transition-colors"
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || loading}
            className="w-11 h-11 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-colors shrink-0"
          >
            <Send className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
