-- Playground schema for testing QueryAutopsy diagnostics (Seq Scan, Sort Spill, Row Mismatch)

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  plan_tier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed 10,000 users
INSERT INTO users (email, country, plan_tier, created_at)
SELECT
  'user_' || g || '@example.com',
  (ARRAY['FR', 'US', 'DE', 'GB', 'JP'])[1 + (g % 5)],
  (ARRAY['free', 'pro', 'enterprise'])[1 + (g % 3)],
  NOW() - ((g % 365) || ' days')::INTERVAL
FROM generate_series(1, 10000) AS g;

-- Seed 150,000 orders (intentionally WITHOUT indexes on orders.user_id or orders.status)
INSERT INTO orders (user_id, status, amount_cents, payload, created_at)
SELECT
  1 + (g % 10000),
  CASE
    WHEN g % 100 = 0 THEN 'failed'
    WHEN g % 10 = 0 THEN 'pending'
    ELSE 'paid'
  END,
  100 + (g % 50000),
  repeat('x', 120),
  NOW() - ((g % 180) || ' days')::INTERVAL
FROM generate_series(1, 150000) AS g;

ANALYZE users;
ANALYZE orders;
