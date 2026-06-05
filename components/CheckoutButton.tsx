"use client";

interface CheckoutButtonProps {
  priceId: string;
  tier: string;
  label: string;
  className?: string;
}

export function CheckoutButton({ priceId, tier, label, className }: CheckoutButtonProps) {
  const url = `/api/stripe/checkout?priceId=${encodeURIComponent(priceId)}&tier=${encodeURIComponent(tier)}`;

  return (
    <a
      href={url}
      className={className}
    >
      {label}
    </a>
  );
}
