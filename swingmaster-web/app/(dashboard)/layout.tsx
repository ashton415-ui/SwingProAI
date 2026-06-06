import DashboardNav from '../../components/ui/DashboardNav';
import MobileNav from '../../components/ui/MobileNav';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-slate-950">
      {/* Sidebar — desktop only */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-white/10 bg-slate-900">
        <DashboardNav />
      </aside>

      {/* Main content — extra bottom padding on mobile keeps content above tab bar */}
      <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>

      {/* Bottom tab bar — mobile only */}
      <MobileNav />
    </div>
  );
}
