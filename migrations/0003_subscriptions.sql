-- One row per user who has ever subscribed. Stripe is the source of truth; the
-- webhook (src/billing.ts) rewrites the row from a fresh fetch on every change.
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_customer ON subscriptions (customer_id);
