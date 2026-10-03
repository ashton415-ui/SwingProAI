import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Search } from "lucide-react";
import { requireAdminForPage } from "@/lib/admin/admin-authority";
import { getAdminUserDirectoryPage } from "@/lib/admin/user-directory";
import {
  DEFAULT_PAGE_SIZE,
  DIRECTORY_ROLES,
  DIRECTORY_SUBSCRIPTION_STATUSES,
  DIRECTORY_SUBSCRIPTION_TIERS,
  MAX_SEARCH_LENGTH,
  parseDirectoryQuery,
  type AdminUserDirectoryEntry,
  type DirectoryQuery,
  type RawSearchParams,
} from "@/lib/admin/user-directory-dto";

// Sensitive admin read: always rendered per request, never cached.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TIER_LABEL: Record<string, string> = {
  par: "Par", birdie: "Birdie", eagle: "Eagle",
  coach_starter: "Coach Starter", coach_pro: "Coach Pro", none: "No plan",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active", trialing: "Trialing", past_due: "Past due", canceled: "Canceled", none: "None",
};
const ROLE_STYLE: Record<string, string> = {
  admin: "bg-red-500/20 text-red-400 border-red-500/30",
  coach: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  golfer: "bg-golf-green/10 text-golf-green border-golf-green/20",
};

type Tone = "good" | "warn" | "bad" | "muted";
const TONE: Record<Tone, string> = {
  good: "bg-golf-green/10 text-golf-green border-golf-green/20",
  warn: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  bad: "bg-red-500/10 text-red-400 border-red-500/30",
  muted: "bg-white/5 text-gray-400 border-white/10",
};

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${TONE[tone]}`}>
      {children}
    </span>
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const formatDate = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : "—");

/** Only statuses the data proves. Nothing here is inferred. */
function accountBadges(u: AdminUserDirectoryEntry) {
  const badges: { tone: Tone; label: string }[] = [];
  if (!u.auth.present) {
    badges.push({ tone: "bad", label: "No Auth account" });
  } else {
    badges.push(u.auth.emailConfirmed ? { tone: "good", label: "Confirmed" } : { tone: "warn", label: "Unconfirmed" });
    if (u.auth.banned) badges.push({ tone: "bad", label: "Banned" });
    if (u.auth.lastSignInAt === null) badges.push({ tone: "muted", label: "Never signed in" });
    if (u.auth.isSso) badges.push({ tone: "muted", label: "SSO" });
    for (const provider of u.auth.providers) badges.push({ tone: "muted", label: provider });
  }
  if (u.drift.profileMissing) badges.push({ tone: "bad", label: "Profile missing" });
  if (u.drift.emailMismatch) badges.push({ tone: "warn", label: "Email mismatch" });
  return badges;
}

function hrefFor(query: DirectoryQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.role) params.set("role", query.role);
  if (query.subscriptionTier) params.set("tier", query.subscriptionTier);
  if (query.subscriptionStatus) params.set("status", query.subscriptionStatus);
  if (query.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(query.pageSize));
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/admin/users?${qs}` : "/admin/users";
}

const selectClass =
  "min-h-11 bg-black/30 border border-white/10 rounded-2xl px-3 text-xs font-bold text-white focus:outline-none focus:border-golf-green/50";

export default async function AdminUsersPage({ searchParams }: { searchParams: RawSearchParams }) {
  const caller = await requireAdminForPage();
  const query = parseDirectoryQuery(searchParams ?? {});
  const result = await getAdminUserDirectoryPage(caller, query);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-2">All Users</h1>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-8">
        {result.status === "ok"
          ? `${result.page.directoryTotal} registered ${result.page.directoryTotal === 1 ? "account" : "accounts"} · complete directory`
          : "Directory status unknown"}
      </p>

      <form method="get" action="/admin/users" className="bg-golf-surface border border-white/5 rounded-4xl p-4 mb-6 grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto_auto] gap-3">
        <label className="relative">
          <span className="sr-only">Search users</span>
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="search"
            name="q"
            defaultValue={query.search ?? ""}
            maxLength={MAX_SEARCH_LENGTH}
            placeholder="Search name or email"
            className="w-full min-h-11 bg-black/30 border border-white/10 rounded-2xl pl-9 pr-3 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-golf-green/50"
          />
        </label>
        <select name="role" defaultValue={query.role ?? ""} aria-label="Role" className={selectClass}>
          <option value="">All roles</option>
          {DIRECTORY_ROLES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
        </select>
        <select name="tier" defaultValue={query.subscriptionTier ?? ""} aria-label="Membership" className={selectClass}>
          <option value="">All memberships</option>
          {DIRECTORY_SUBSCRIPTION_TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
        </select>
        <select name="status" defaultValue={query.subscriptionStatus ?? ""} aria-label="Subscription status" className={selectClass}>
          <option value="">All subscriptions</option>
          {DIRECTORY_SUBSCRIPTION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <div className="flex gap-2">
          <button type="submit" className="min-h-11 px-5 rounded-2xl bg-golf-green text-golf-dark text-[10px] font-black uppercase tracking-widest">
            Apply
          </button>
          <Link href="/admin/users" className="min-h-11 px-4 rounded-2xl border border-white/10 text-gray-400 text-[10px] font-black uppercase tracking-widest flex items-center">
            Reset
          </Link>
        </div>
      </form>

      {query.ignored.length > 0 && (
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400 mb-4">
          Some filters were not recognised and were ignored.
        </p>
      )}

      {result.status !== "ok" ? (
        <div className="bg-golf-surface rounded-5xl border border-red-500/20 py-16 px-6 text-center">
          <AlertTriangle size={32} className="text-red-400 mx-auto mb-4" />
          <p className="text-white font-black uppercase tracking-widest text-sm mb-2">
            {result.status === "incomplete" ? "User directory incomplete" : "User directory unavailable"}
          </p>
          <p className="text-gray-500 text-xs max-w-md mx-auto">
            {result.status === "incomplete"
              ? "The complete list of registered accounts could not be confirmed, so no partial list is shown."
              : "The user directory could not be loaded. No users are shown rather than an incomplete list. Please retry."}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-golf-surface rounded-5xl border border-white/5 overflow-hidden">
            {result.page.entries.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-gray-500 text-[10px] font-mono uppercase tracking-widest">No users match these filters</p>
              </div>
            ) : (
              <div className="overflow-x-auto w-full">
                <table className="w-full text-left min-w-[760px]">
                  <thead>
                    <tr className="bg-black/20 text-gray-600 text-[9px] uppercase tracking-[0.3em] font-black">
                      <th className="px-5 py-4">User</th>
                      <th className="px-5 py-4">Role</th>
                      <th className="px-5 py-4">Membership</th>
                      <th className="px-5 py-4">Subscription</th>
                      <th className="px-5 py-4">Account</th>
                      <th className="px-5 py-4">Joined</th>
                      <th className="px-5 py-4">Last sign-in</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {result.page.entries.map((u) => (
                      <tr key={u.id} className="hover:bg-white/5 transition-colors align-top">
                        <td className="px-5 py-4">
                          <p className="text-sm font-bold text-white">{u.displayName ?? "—"}</p>
                          <p className="text-[10px] text-gray-500 break-all">{u.email ?? "No email"}</p>
                        </td>
                        <td className="px-5 py-4">
                          {u.role ? (
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${ROLE_STYLE[u.role]}`}>
                              {u.role}
                            </span>
                          ) : <span className="text-xs text-gray-600">—</span>}
                        </td>
                        <td className="px-5 py-4">
                          <span className="text-xs font-mono text-gray-400">{u.subscriptionTier ? TIER_LABEL[u.subscriptionTier] : "—"}</span>
                        </td>
                        <td className="px-5 py-4">
                          <span className={`text-[9px] font-black uppercase ${u.subscriptionStatus === "active" || u.subscriptionStatus === "trialing" ? "text-golf-green" : u.subscriptionStatus === "past_due" ? "text-amber-400" : "text-gray-600"}`}>
                            {u.subscriptionStatus ? STATUS_LABEL[u.subscriptionStatus] : "—"}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-1 max-w-[220px]">
                            {accountBadges(u).map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}
                          </div>
                        </td>
                        <td className="px-5 py-4"><span className="text-xs font-mono text-gray-500">{formatDate(u.joinedAt)}</span></td>
                        <td className="px-5 py-4">
                          <span className="text-xs font-mono text-gray-500">
                            {u.auth.present ? (u.auth.lastSignInAt ? formatDate(u.auth.lastSignInAt) : "Never") : "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <nav aria-label="Pagination" className="flex items-center justify-between mt-6 gap-3">
            <p className="text-[10px] font-mono uppercase tracking-widest text-gray-500">
              {result.page.total === 0
                ? "0 results"
                : `${(result.page.page - 1) * result.page.pageSize + 1}–${(result.page.page - 1) * result.page.pageSize + result.page.entries.length} of ${result.page.total} · page ${result.page.page} of ${result.page.lastPage}`}
            </p>
            <div className="flex gap-2">
              {result.page.page > 1 ? (
                <Link href={hrefFor(query, result.page.page - 1)} className="min-h-11 min-w-11 px-4 rounded-2xl border border-white/10 text-white text-[10px] font-black uppercase tracking-widest flex items-center">
                  Previous
                </Link>
              ) : null}
              {result.page.hasMore ? (
                <Link href={hrefFor(query, result.page.page + 1)} className="min-h-11 min-w-11 px-4 rounded-2xl border border-white/10 text-white text-[10px] font-black uppercase tracking-widest flex items-center">
                  Next
                </Link>
              ) : null}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
