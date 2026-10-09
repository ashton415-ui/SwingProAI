import { createClient, getServerSession } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { CheckCircle, CreditCard, Zap } from "lucide-react";
import { CheckoutButton } from "@/components/CheckoutButton";
import { canManageBilling } from "@/lib/billing/manage-billing-eligibility";

const PLANS = [
  {
    id: "par" as const,
    name: "Par",
    price: "$7.99",
    period: "/ month",
    target: "The Casual Improver",
    popular: false,
    features: [
      "Up to 5 AI-powered video analyses per month",
      "Core biometrics: tempo & spine angle feedback",
      "Drill recommendations mapped to your swing flaws",
      "Progress dashboard with historical swing metrics",
    ],
  },
  {
    id: "birdie" as const,
    name: "Birdie",
    price: "$14.99",
    period: "/ month",
    target: "The Dedicated Amateur",
    popular: true,
    features: [
      "Unlimited swing analyses",
      "Advanced biomechanics: hip sway, head drop, club path vectors",
      "USGA-compliant handicap index tracking",
      "Stroke equity analytics: FIR, GIR, putts per round",
    ],
  },
  {
    id: "eagle" as const,
    name: "Eagle",
    price: "$24.99",
    period: "/ month",
    target: "The Competitive Player",
    popular: false,
    features: [
      "Everything in Birdie, plus:",
      "3D putting engine with LiDAR / ARCore green reading",
      "Premium course maps with green undulation heatmaps",
      "Real-time AI caddy with predictive club & aim suggestions",
      "AR smart glasses HUD via OpenXR",
    ],
  },
];

/** Statuses with a live Stripe subscription: these golfers manage, not buy. */
const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

const STATUS_COPY: Record<string, string> = {
  active: "Active",
  trialing: "Free trial",
  past_due: "Payment past due. Update your payment method in Manage billing.",
};

const BILLING_NOTICES: Record<string, string> = {
  unavailable: "Billing management is unavailable right now. Please try again shortly.",
  "auth-unavailable": "We couldn't confirm your session. Please try again shortly.",
};

/** Checkout outcomes. Generic by design: no billing identifier or provider detail. */
const CHECKOUT_NOTICES: Record<string, string> = {
  "in-progress": "A checkout is already in progress. Finish it, or try again in a few minutes.",
  processing: "Your checkout is complete and your plan is being activated. This page will update shortly.",
  "existing-subscription": "You already have a subscription. Use Manage billing to review it.",
  unavailable: "Checkout is unavailable right now. Please try again shortly.",
  "auth-unavailable": "We couldn't confirm your session. Please try again shortly.",
};

export default async function UpgradePage({
  searchParams,
}: {
  searchParams?: { billing?: string | string[]; checkout?: string | string[] };
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("subscription_status, subscription_tier, role, stripe_customer_id")
    .eq("id", session.user.id)
    .single();

  const currentTier = profile?.subscription_tier ?? "none";
  const isAdmin = profile?.role === "admin";

  // Decided here on the server; only booleans and labels reach the page.
  const status = profile?.subscription_status ?? "none";
  const canManage = canManageBilling(profile?.stripe_customer_id, status);
  const hasLiveSubscription = canManage && LIVE_SUBSCRIPTION_STATUSES.includes(status);
  const currentPlanName = hasLiveSubscription ? PLANS.find((p) => p.id === currentTier)?.name ?? null : null;

  const billing = searchParams?.billing;
  const checkout = searchParams?.checkout;
  const billingNotice =
    (typeof billing === "string" ? BILLING_NOTICES[billing] ?? null : null) ??
    (typeof checkout === "string" ? CHECKOUT_NOTICES[checkout] ?? null : null);

  return (
    <div className="px-6 py-10">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-golf-green/10 border border-golf-green/20 rounded-full text-golf-green text-[10px] font-bold tracking-[0.2em] uppercase mb-6">
            <Zap size={10} fill="currentColor" />
            Choose Your Plan
          </div>
          <h1 className="text-4xl md:text-6xl font-black italic tracking-tighter uppercase text-white">
            Unlock Your Game
          </h1>
          <p className="text-gray-500 mt-3 text-sm font-medium max-w-xl mx-auto">
            Eligible first-time subscribers receive a 7-day free trial. A card is required at checkout; billing starts when the trial ends.
          </p>
          {isAdmin && (
            <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-full text-red-400 text-[9px] font-black uppercase tracking-widest">
              Admin View — Checkout links are live Stripe sessions
            </div>
          )}
        </div>

        {billingNotice && (
          <div className="max-w-xl mx-auto mb-8 px-5 py-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 text-amber-300 text-sm font-medium text-center">
            {billingNotice}
          </div>
        )}

        {/* Plan & Billing — server-decided; no billing identifier is rendered */}
        {canManage && (
          <div className="max-w-xl mx-auto mb-12 bg-golf-surface rounded-5xl p-8 border border-golf-green/20">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-golf-green">Plan &amp; Billing</p>
            {hasLiveSubscription ? (
              <>
                <h2 className="text-2xl font-black italic tracking-tighter uppercase text-white mt-3">
                  {currentPlanName ?? "Your plan"}
                </h2>
                <p className="text-sm text-gray-400 mt-1">{STATUS_COPY[status]}</p>
              </>
            ) : (
              <h2 className="text-2xl font-black italic tracking-tighter uppercase text-white mt-3">
                Your subscription has ended
              </h2>
            )}
            <form method="POST" action="/api/stripe/portal" className="mt-6">
              <button
                type="submit"
                className="w-full min-h-[44px] py-3.5 flex items-center justify-center gap-2 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] hover:bg-[#22C55E] transition-all"
              >
                <CreditCard size={14} />
                Manage billing
              </button>
            </form>
          </div>
        )}

        {/* Pricing Cards — live subscribers manage their plan above instead */}
        {!hasLiveSubscription && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => {
            const isCurrent = currentTier === plan.id;

            return (
              <div
                key={plan.id}
                className={`relative bg-golf-surface rounded-5xl p-8 border flex flex-col ${
                  plan.popular
                    ? "border-golf-green/40 shadow-xl shadow-golf-green/10"
                    : "border-white/5"
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="bg-golf-green text-golf-dark text-[9px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full shadow-lg">
                      Most Popular
                    </span>
                  </div>
                )}

                <div className="mb-8">
                  <h3 className="text-2xl font-black italic tracking-tighter uppercase text-white">
                    {plan.name}
                  </h3>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-gray-600 mt-1">
                    {plan.target}
                  </p>
                  <div className="flex items-end gap-1 mt-5">
                    <span className="text-4xl font-mono font-black text-white">{plan.price}</span>
                    <span className="text-gray-500 mb-1 text-sm">{plan.period}</span>
                  </div>
                </div>

                <ul className="space-y-3.5 flex-1 mb-8">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-gray-400">
                      <CheckCircle size={14} className="text-golf-green shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <div className="w-full py-3.5 text-center bg-white/5 border border-white/10 text-gray-500 font-black uppercase tracking-widest rounded-2xl text-[10px]">
                    Current Plan
                  </div>
                ) : (
                  <CheckoutButton
                    plan={plan.id}
                    label={`Get ${plan.name}`}
                    className={`w-full py-3.5 font-black uppercase tracking-widest rounded-2xl transition-all text-[10px] disabled:opacity-60 ${
                      plan.popular
                        ? "bg-golf-green text-golf-dark hover:bg-[#22C55E] shadow-[0_0_20px_rgba(74,222,128,0.2)]"
                        : "bg-white/5 border border-white/10 text-white hover:bg-white/10"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
        )}

        <p className="text-center text-[10px] font-bold uppercase tracking-widest text-gray-700 mt-10">
          Secured by Stripe
        </p>
      </div>
    </div>
  );
}
