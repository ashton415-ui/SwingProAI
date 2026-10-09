/** The plans checkout sells. The server alone decides the price and tier. */
type CheckoutPlan = "par" | "birdie" | "eagle";

interface CheckoutButtonProps {
  plan: CheckoutPlan;
  label: string;
  className?: string;
}

/**
 * Starting checkout is a state change, so it is a same-origin form POST, never
 * a link. The form carries the plan selector and nothing else: price, trial,
 * customer and return URLs are all decided on the server.
 */
export function CheckoutButton({ plan, label, className }: CheckoutButtonProps) {
  return (
    <form method="POST" action="/api/stripe/checkout" className="w-full">
      <input type="hidden" name="plan" value={plan} />
      <button type="submit" className={`min-h-[44px] ${className ?? ""}`.trim()}>
        {label}
      </button>
    </form>
  );
}
