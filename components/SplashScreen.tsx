"use client";

import { useEffect, useState } from "react";

export default function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    // Start fade-out after video plays (3.5s) then unmount
    const fadeTimer = setTimeout(() => setFading(true), 3500);
    const hideTimer = setTimeout(() => setVisible(false), 4200);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-golf-dark transition-opacity duration-700 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Subtle grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:40px_40px]" />

      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* Animated logo video */}
        <div className="w-56 h-56 rounded-[3rem] overflow-hidden border border-golf-green/20 shadow-[0_0_60px_rgba(74,222,128,0.15)]">
          <video
            src="/logo-animation.mp4"
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        </div>

        {/* Wordmark */}
        <div className="text-center">
          <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">
            Swing<span className="text-golf-green">Pro</span>AI
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-gray-600 mt-1">
            Golf Swing Analyzer
          </p>
        </div>

        {/* Loading bar */}
        <div className="w-40 h-0.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className="h-full bg-golf-green rounded-full"
            style={{
              animation: "loadbar 3.5s ease-out forwards",
            }}
          />
        </div>
      </div>

      <style jsx>{`
        @keyframes loadbar {
          from { width: 0% }
          to { width: 100% }
        }
      `}</style>
    </div>
  );
}
