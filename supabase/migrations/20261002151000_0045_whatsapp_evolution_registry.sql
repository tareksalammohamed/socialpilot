INSERT INTO public.social_platform_apps (
  platform_key, display_name, enabled, has_secret, status
)
VALUES ('whatsapp', 'واتساب — Evolution/Baileys', false, false, 'not_configured')
ON CONFLICT (platform_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    updated_at = now();
