export default function BagLoading() {
  return (
    <div className="min-h-screen bg-slate-950">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        {/* Header skeleton */}
        <div className="mb-8 space-y-2">
          <div className="h-7 w-28 rounded-lg bg-white/10 animate-pulse" />
          <div className="h-4 w-64 rounded bg-white/5 animate-pulse" />
        </div>

        {/* Card skeleton */}
        <div className="bg-slate-900 rounded-2xl border border-white/10 overflow-hidden">
          {/* Card header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <div className="space-y-1.5">
              <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
              <div className="h-3 w-32 rounded bg-white/5 animate-pulse" />
            </div>
            <div className="h-7 w-24 rounded-lg bg-white/10 animate-pulse" />
          </div>

          {/* Row skeletons */}
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] last:border-0">
              <div className="w-7 h-7 rounded-lg bg-white/10 animate-pulse shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-40 rounded bg-white/10 animate-pulse" />
                <div className="h-3 w-24 rounded bg-white/5 animate-pulse" />
              </div>
              <div className="flex gap-4 shrink-0">
                <div className="h-8 w-16 rounded bg-white/5 animate-pulse" />
                <div className="h-5 w-16 rounded-full bg-white/5 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
