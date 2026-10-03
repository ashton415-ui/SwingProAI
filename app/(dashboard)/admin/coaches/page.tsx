import Link from "next/link";
import { AlertTriangle, UserCheck } from "lucide-react";
import { requireAdminForPage } from "@/lib/admin/admin-authority";
import { getAdminUserDirectoryPage } from "@/lib/admin/user-directory";
import { MAX_PAGE_SIZE, parseDirectoryQuery, type RawSearchParams } from "@/lib/admin/user-directory-dto";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TIER_LABEL: Record<string, string> = {
  par: "Par", birdie: "Birdie", eagle: "Eagle",
  coach_starter: "Coach Starter", coach_pro: "Coach Pro", none: "No plan",
};
const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export default async function AdminCoachesPage({ searchParams }: { searchParams: RawSearchParams }) {
  const caller = await requireAdminForPage();

  // Every coach from the complete directory; only the page number is read
  // from the URL, the role filter is fixed here.
  const parsed = parseDirectoryQuery({ page: searchParams?.page });
  const result = await getAdminUserDirectoryPage(caller, {
    ...parsed,
    pageSize: MAX_PAGE_SIZE,
    search: null,
    role: "coach",
    subscriptionStatus: null,
    subscriptionTier: null,
  });

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-8">All Coaches</h1>

      {result.status !== "ok" ? (
        <div className="bg-golf-surface rounded-5xl border border-red-500/20 py-16 px-6 text-center">
          <AlertTriangle size={32} className="text-red-400 mx-auto mb-4" />
          <p className="text-white font-black uppercase tracking-widest text-sm mb-2">
            {result.status === "incomplete" ? "Coach directory incomplete" : "Coach directory unavailable"}
          </p>
          <p className="text-gray-500 text-xs max-w-md mx-auto">
            The complete list of coaches could not be confirmed, so no partial list is shown. Please retry.
          </p>
        </div>
      ) : (
        <>
          <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden">
            {result.page.total === 0 ? (
              <div className="py-20 text-center">
                <UserCheck size={32} className="text-gray-700 mx-auto mb-4" />
                <p className="text-gray-600 text-[10px] font-mono uppercase tracking-widest">No coaches yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto w-full">
                <table className="w-full text-left min-w-[680px]">
                  <thead>
                    <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                      <th className="px-6 py-4">Coach</th>
                      <th className="px-6 py-4">Plan</th>
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4">Joined</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {result.page.entries.map((c) => (
                      <tr key={c.id} className="hover:bg-white/5 transition-colors">
                        <td className="px-6 py-4">
                          <p className="font-bold text-white text-sm">{c.displayName ?? "—"}</p>
                          <p className="text-[10px] text-gray-500 break-all">{c.email ?? "No email"}</p>
                        </td>
                        <td className="px-6 py-4"><span className="text-xs font-mono text-gray-400">{c.subscriptionTier ? TIER_LABEL[c.subscriptionTier] : "—"}</span></td>
                        <td className="px-6 py-4">
                          <span className={`text-[9px] font-black uppercase ${c.subscriptionStatus === "active" ? "text-golf-green" : "text-gray-600"}`}>
                            {c.subscriptionStatus ?? "—"}
                          </span>
                        </td>
                        <td className="px-6 py-4"><span className="text-xs font-mono text-gray-600">{c.joinedAt ? DATE.format(new Date(c.joinedAt)) : "—"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {result.page.lastPage > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between mt-6 gap-3">
              <p className="text-[10px] font-mono uppercase tracking-widest text-gray-500">
                {result.page.total} coaches · page {result.page.page} of {result.page.lastPage}
              </p>
              <div className="flex gap-2">
                {result.page.page > 1 && (
                  <Link href={`/admin/coaches?page=${result.page.page - 1}`} className="min-h-11 min-w-11 px-4 rounded-2xl border border-white/10 text-white text-[10px] font-black uppercase tracking-widest flex items-center">
                    Previous
                  </Link>
                )}
                {result.page.hasMore && (
                  <Link href={`/admin/coaches?page=${result.page.page + 1}`} className="min-h-11 min-w-11 px-4 rounded-2xl border border-white/10 text-white text-[10px] font-black uppercase tracking-widest flex items-center">
                    Next
                  </Link>
                )}
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
