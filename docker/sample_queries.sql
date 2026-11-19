-- Select any query below, right-click -> "QueryAutopsy: Inspect Query Performance (EXPLAIN ANALYZE)"

-- 1. Triggers SEQ_SCAN_LARGE_TABLE on orders (missing index on user_id)
SELECT id, status, amount_cents, created_at
FROM orders
WHERE user_id = 42;

-- 2. Triggers SEQ_SCAN + SORT (potential disk spill if work_mem is low)
SELECT user_id, status, amount_cents, payload
FROM orders
WHERE status = 'pending'
ORDER BY amount_cents DESC, payload ASC;

-- 3. Parameterized query example (QueryAutopsy will prompt for $1)
SELECT id, status, amount_cents
FROM orders
WHERE user_id = $1 AND status = $2;

-- 4. Fast Index Scan baseline on users.id (Primary Key)
SELECT id, email, plan_tier
FROM users
WHERE id = 42;
