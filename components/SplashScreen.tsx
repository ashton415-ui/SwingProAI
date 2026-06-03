"use client";

import { useEffect, useRef, useState } from "react";

export default function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onEnded = () => {
      // Video finished — start fade then unmount
      setFading(true);
      setTimeout(() => setVisible(false), 800);
    };

    video.addEventListener("ended", onEnded);

    // Safety fallback: if video fails to load or stalls, dismiss after 12s
    const fallback = setTimeout(() => {
      setFading(true);
      setTimeout(() => setVisible(false), 800);
    }, 12000);

    return () => {
      video.removeEventListener("ended", onEnded);
      clearTimeout(fallback);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-golf-dark transition-opacity duration-700 ${
        fading ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      {/* Subtle grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:40px_40px]" />

      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* Animated logo video — larger */}
        <div className="w-72 h-72 rounded-[3rem] overflow-hidden border border-golf-green/20 shadow-[0_0_80px_rgba(74,222,128,0.2)]">
          <video
            ref={videoRef}
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
      </div>
    </div>
  );
}
