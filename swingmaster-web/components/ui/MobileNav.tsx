{/* Tab bar */}
<nav className="fixed bottom-0 left-0 right-0 z-40 flex md:hidden bg-slate-900/95 backdrop-blur-sm border-t border-white/10 w-full overflow-hidden">
  {PRIMARY_TABS.map(({ label, href, icon: Icon }) => {
    const active = isActive(href);
    return (
      <Link
        key={href}
        href={href}
        onClick={() => !active && navigator.vibrate?.(10)}
        className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium transition-colors min-w-0 ${
          active ? 'text-indigo-400' : 'text-slate-500 active:text-slate-300'
        }`}
      >
        <Icon className={`w-5 h-5 transition-transform ${active ? 'scale-110' : ''}`} />
        <span className="truncate">{label}</span>
      </Link>
    );
  })}

  {/* More button */}
  <button
    onClick={() => {
      if (moreOpen) { haptic(); closeSheet(); } 
      else { navigator.vibrate?.(10); setMoreOpen(true); }
    }}
    className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium transition-colors min-w-0 ${
      moreIsActive || moreOpen ? 'text-indigo-400' : 'text-slate-500 active:text-slate-300'
    }`}
  >
    <MoreHorizontal className="w-5 h-5" />
    <span className="truncate">More</span>
  </button>
</nav>