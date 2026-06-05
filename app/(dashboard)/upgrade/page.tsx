import { createClient, getServerSession } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { CheckCircle, Zap } from "lucide-react";

const PLANS = [
  {
    id: "par",
    name: "Par",
    price: "$9.99",
    period: "/ month",
    target: "The Casual Improver",
    priceEnvKey: "STRIPE_PAR_PRICE_ID",
    popular: false,
    features: [
      "Up to 5 AI-powered video analyses per month",
      "Core biometrics: tempo & spine angle feedback",
      "Drill recommendations mapped to your swing flaws",
      "Progress dashboard with historical swing metrics",
    ],
  },
  {
    id: "birdie",
    name: "Birdie",
    price: "$24.99",
    period: "/ month",
    target: "The Dedicated Amateur",
    priceEnvKey: "STRIPE_BIRDIE_PRICE_ID",
    popular: true,
    features: [
      "Unlimited swing analyses",
      "Advanced biomechanics: hip sway, head drop, club path vectors",
      "USGA-compliant handicap index tracking",
      "Stroke equity analytics: FIR, GIR, putts per round",
    ],
  },
  {
    id: "eagle",
    name: "Eagle",
    price: "$49.99",
    period: "/ month",
    target: "The Competitive Player",
    priceEnvKey: "STRIPE_EAGLE_PRICE_ID",
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

export default async function UpgradePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("subscription_status, subscription_tier, role")
    .eq("id", session.user.id)
    .single();

  const currentTier = profile?.subscription_tier ?? "none";
  const isAdmin = profile?.role === "admin";

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
            All plans include a 7-day free trial. Cancel anytime.
          </p>
          {isAdmin && (
            <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-full text-red-400 text-[9px] font-black uppercase tracking-widest">
              Admin View — Checkout links are live Stripe sessions
            </div>
          )}
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => {
            const isCurrent = currentTier === plan.id;
            const priceId = process.env[plan.priceEnvKey];

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
                  <form action="/api/stripe/checkout" method="POST">
                    <input type="hidden" name="priceId" value={priceId ?? ""} />
                    <input type="hidden" name="tier" value={plan.id} />
                    <button
                      type="submit"
                      className={`w-full py-3.5 font-black uppercase tracking-widest rounded-2xl transition-all text-[10px] ${
                        plan.popular
                          ? "bg-golf-green text-golf-dark hover:bg-[#22C55E] shadow-[0_0_20px_rgba(74,222,128,0.2)]"
                          : "bg-white/5 border border-white/10 text-white hover:bg-white/10"
                      }`}
                    >
                      Get {plan.name}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-center text-[10px] font-bold uppercase tracking-widest text-gray-700 mt-10">
          Secured by Stripe · Cancel anytime · No hidden fees
        </p>
      </div>
    </div>
  );
}
