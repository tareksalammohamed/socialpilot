ALTER TABLE public.social_platform_apps
  DROP CONSTRAINT IF EXISTS social_platform_apps_platform_key_check;

ALTER TABLE public.social_platform_apps
  ADD CONSTRAINT social_platform_apps_platform_key_check
  CHECK (platform_key IN (
    'meta',
    'linkedin',
    'telegram',
    'x',
    'tiktok',
    'threads',
    'whatsapp',
    'whatsapp_waha',
    'whatsapp_wppconnect'
  ));

INSERT INTO public.social_platform_apps (platform_key, display_name, enabled, has_secret, status)
VALUES
  ('whatsapp_waha', 'واتساب — WAHA', false, false, 'not_configured'),
  ('whatsapp_wppconnect', 'واتساب — WPPConnect', false, false, 'not_configured')
ON CONFLICT (platform_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    updated_at = now();
