"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogIn, Zap } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      window.location.href = "/dashboard";
    }
  }

  return (
    <div className="min-h-screen bg-golf-dark flex items-center justify-center px-4">
      {/* Subtle grid bg */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:40px_40px]" />

      <div className="relative w-full max-w-md">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-20 h-20 bg-golf-green/5 border border-golf-green/20 rounded-3xl overflow-hidden mb-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/swingproai_logo.png" alt="SwingProAI" className="w-full h-full object-contain p-1" />
          </div>
          <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase">
            SWING<span className="text-golf-green">PRO</span>AI
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            Secure Session Login
          </p>
        </div>

        <div className="bg-golf-surface border border-white/5 rounded-5xl p-8">
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3.5 bg-black/40 border border-white/10 rounded-2xl text-white placeholder-gray-600 focus:outline-none focus:border-golf-green/50 focus:ring-1 focus:ring-golf-green/20 transition-all text-sm"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3.5 bg-black/40 border border-white/10 rounded-2xl text-white placeholder-gray-600 focus:outline-none focus:border-golf-green/50 focus:ring-1 focus:ring-golf-green/20 transition-all text-sm"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p className="text-red-400 text-xs font-bold bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] disabled:opacity-50 transition-all flex items-center justify-center gap-2 text-sm shadow-[0_0_20px_rgba(74,222,128,0.15)]"
            >
              <LogIn size={16} />
              {loading ? "Authenticating…" : "Start Session"}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-white/5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600">
              No account?{" "}
              <Link href="/signup" className="text-golf-green hover:underline">
                Create one
              </Link>
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 mt-6">
          <Zap size={10} className="text-golf-green" fill="currentColor" />
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-gray-600">
            AI-Integrated Swing Analysis
          </p>
        </div>
      </div>
    </div>
  );
}
