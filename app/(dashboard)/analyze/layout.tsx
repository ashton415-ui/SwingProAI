import { getServerSession } from "@/utils/supabase/server";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import type { SubscriptionTier } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * Analyze layout injects the user's subscription tier into a cookie-like
 * header so the client page can read it without an extra fetch.
 * We use a data attribute on a hidden div — clean, no extra round-trips.
 */
export default async function AnalyzeLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("subscription_tier, subscription_status")
    .eq("id", session.user.id)
    .single();

  const tier: SubscriptionTier = (profile?.subscription_tier ?? "par") as SubscriptionTier;

  return (
    <>
      {/* Hidden server-rendered data node — client reads this to know the tier */}
      <div id="__swingpro_tier" data-tier={tier} className="hidden" />
      {children}
    </>
  );
}
