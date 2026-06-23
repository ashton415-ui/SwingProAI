// ... (keep all your existing imports the same)

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // ... (keep your existing session, user, and profile logic the same)

  return (
    <div className="flex min-h-screen bg-golf-dark overflow-x-hidden">
      {/* FIX: 
         1. Added 'hidden md:flex' to hide sidebar on mobile 
         2. Added 'z-20' to ensure sidebar sits on top of content
      */}
      <aside className="hidden md:flex w-64 bg-golf-header border-r border-white/5 flex-col fixed h-full overflow-y-auto z-20">
        {/* ... keep all your existing Sidebar content (Logo, Navs, Sign Out) ... */}
        <div className="px-6 py-7 border-b border-white/5">
           {/* (Keep your existing logo/profile code here) */}
        </div>
        {/* (Keep your existing nav sections: Nav — Golfer, Nav — Coach, etc.) */}
      </aside>

      {/* FIX: 
         1. Removed 'ml-64' (which forced the desktop width)
         2. Added 'md:ml-64' (only apply the margin on desktop)
      */}
      <main className="flex-1 w-full md:ml-64 min-h-screen">
        {children}
      </main>
    </div>
  );
}