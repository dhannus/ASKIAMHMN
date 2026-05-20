-- ════════════════════════════════════════════════════════════════════════════
-- Register ask.iamhmn.org as the first OAuth client.
--
-- Run on the HHTTPS server as:
--   sudo -u postgres psql -d hhttps -f register-oauth-client.sql
--
-- Notes:
--   - This is a PUBLIC CLIENT (no client_secret) using PKCE-only auth.
--   - Marked as `verified` because Daniel approves it as the first
--     verified platform under the "you verify the first one" rule.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO oauth_clients (
  client_id,
  name,
  description,
  homepage_url,
  redirect_uris,
  allowed_scopes,
  subject_type,
  verified,
  verified_at,
  contact_email
) VALUES (
  'ask-iamhmn',
  'ask.iamhmn.org',
  'Q&A forum for verified humans and machines — first reference platform for HHTTPS OAuth + machine tokens',
  'https://ask.iamhmn.org',
  '["https://ask.iamhmn.org/auth/callback"]',
  '["openid","role","verification_method"]',
  'pairwise',
  TRUE,
  NOW(),
  'admin@iamhmn.org'
)
ON CONFLICT (client_id) DO UPDATE
SET name           = EXCLUDED.name,
    description    = EXCLUDED.description,
    homepage_url   = EXCLUDED.homepage_url,
    redirect_uris  = EXCLUDED.redirect_uris,
    allowed_scopes = EXCLUDED.allowed_scopes,
    verified       = TRUE;

SELECT client_id, name, verified, homepage_url FROM oauth_clients WHERE client_id = 'ask-iamhmn';
