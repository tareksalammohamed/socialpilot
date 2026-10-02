-- Phase 2: register Threads and TikTok in the canonical integration registry.
INSERT INTO public.social_platform_apps (platform_key, display_name, scopes, enabled, has_secret, status)
VALUES
  ('threads', 'ثريدز', 'threads_basic,threads_content_publish,threads_manage_insights,threads_read_replies,threads_manage_replies', false, false, 'not_configured'),
  ('tiktok', 'تيك توك', 'user.info.basic,video.publish,video.upload', false, false, 'not_configured')
ON CONFLICT (platform_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    scopes = COALESCE(public.social_platform_apps.scopes, EXCLUDED.scopes),
    updated_at = now();
