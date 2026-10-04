"use client";

/** The plans checkout sells. The server alone decides the price and tier. */
type CheckoutPlan = "par" | "birdie" | "eagle";

interface CheckoutButtonProps {
  plan: CheckoutPlan;
  label: string;
  className?: string;
}

export function CheckoutButton({ plan, label, className }: CheckoutButtonProps) {
  const url = `/api/stripe/checkout?plan=${encodeURIComponent(plan)}`;

  return (
    <a
      href={url}
      className={className}
    >
      {label}
    </a>
  );
}
