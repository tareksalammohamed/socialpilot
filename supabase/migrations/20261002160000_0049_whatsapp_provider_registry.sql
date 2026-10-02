-- Multi-provider WhatsApp gateway registry.
-- Keeps provider configuration independent from the social platform registry so
-- Evolution, WAHA and WPPConnect can coexist and work as controlled fallbacks.

CREATE TABLE IF NOT EXISTS public.whatsapp_provider_configs (
  provider_key text PRIMARY KEY
    CHECK (provider_key IN ('evolution','waha','wppconnect')),
  display_name text NOT NULL,
  base_url text,
  enabled boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100 CHECK (priority > 0),
  status text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured','connected','error')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  last_test_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_provider_secrets (
  provider_key text PRIMARY KEY
    REFERENCES public.whatsapp_provider_configs(provider_key) ON DELETE CASCADE,
  primary_secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_provider_secrets ENABLE ROW LEVEL SECURITY;

-- No client policies: all reads/writes go through Super Admin / service-role Edge Functions.

INSERT INTO public.whatsapp_provider_configs (
  provider_key, display_name, priority, capabilities
)
VALUES
  ('evolution', 'Evolution / Baileys', 10, '{"qr":true,"text":true,"media":true,"delivery":true,"webhooks":true}'::jsonb),
  ('waha', 'WAHA', 20, '{"qr":true,"text":true,"media":true,"delivery":true,"webhooks":true}'::jsonb),
  ('wppconnect', 'WPPConnect', 30, '{"qr":true,"text":true,"media":true,"delivery":true,"webhooks":true}'::jsonb)
ON CONFLICT (provider_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    priority = EXCLUDED.priority,
    capabilities = EXCLUDED.capabilities,
    updated_at = now();

-- Migrate the existing Evolution configuration if it exists.
INSERT INTO public.whatsapp_provider_configs (
  provider_key, display_name, base_url, enabled, priority, status, last_error, last_test_at
)
SELECT
  'evolution',
  'Evolution / Baileys',
  app_id,
  enabled,
  10,
  status,
  last_error,
  last_test_at
FROM public.social_platform_apps
WHERE platform_key = 'whatsapp'
  AND app_id IS NOT NULL
ON CONFLICT (provider_key) DO UPDATE
SET base_url = EXCLUDED.base_url,
    enabled = EXCLUDED.enabled,
    status = EXCLUDED.status,
    last_error = EXCLUDED.last_error,
    last_test_at = EXCLUDED.last_test_at,
    updated_at = now();

INSERT INTO public.whatsapp_provider_secrets (provider_key, primary_secret)
SELECT 'evolution', app_secret
FROM public.social_platform_app_secrets
WHERE platform_key = 'whatsapp'
  AND app_secret IS NOT NULL
ON CONFLICT (provider_key) DO UPDATE
SET primary_secret = EXCLUDED.primary_secret,
    updated_at = now();

DROP TRIGGER IF EXISTS trg_touch_whatsapp_provider_configs ON public.whatsapp_provider_configs;
CREATE TRIGGER trg_touch_whatsapp_provider_configs
BEFORE UPDATE ON public.whatsapp_provider_configs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_whatsapp_provider_configs_enabled_priority
  ON public.whatsapp_provider_configs(enabled, priority, provider_key);
