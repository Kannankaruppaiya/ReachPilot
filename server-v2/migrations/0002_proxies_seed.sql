-- ============================================================================
-- 0002 — Seed proxy pool for local development
-- Provides simulated residential proxies across multiple countries so the
-- onboarding proxy-assignment flow works out of the box.
-- ============================================================================

INSERT INTO proxies (provider, ip, country, healthy) VALUES
  ('simulator', '103.21.44.10',  'IN', true),
  ('simulator', '103.21.44.11',  'IN', true),
  ('simulator', '198.51.100.20', 'US', true),
  ('simulator', '198.51.100.21', 'US', true),
  ('simulator', '203.0.113.30',  'DE', true),
  ('simulator', '203.0.113.31',  'DE', true),
  ('simulator', '192.0.2.40',    'UK', true),
  ('simulator', '192.0.2.41',    'UK', true),
  ('simulator', '198.51.100.50', 'BR', true),
  ('simulator', '198.51.100.51', 'BR', true)
ON CONFLICT DO NOTHING;
