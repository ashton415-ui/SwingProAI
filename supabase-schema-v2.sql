-- SwingProAI — Schema additions (run after supabase-schema.sql)
-- Paste into: Supabase Dashboard > SQL Editor > New query > Run

-- Add Stripe fields to users table
alter table public.users
  add column if not exists stripe_customer_id text unique,
  add column if not exists subscription_status text not null default 'none'
    check (subscription_status in ('active', 'trialing', 'past_due', 'canceled', 'none'));

-- Index for fast webhook lookups by Stripe customer ID
create index if not exists users_stripe_customer_id_idx
  on public.users(stripe_customer_id);
