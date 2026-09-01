CREATE TABLE IF NOT EXISTS public.halfawake_netease_session (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  cookie_ciphertext TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  refreshed_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  profile JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.halfawake_netease_session ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.halfawake_netease_session IS
  'Encrypted server-side NetEase session. No anonymous RLS policy by design.';
