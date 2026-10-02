# WAHA fallback provider for SocialPilot

WAHA is the first fallback after Evolution.

## Production setup

1. Run this stack on a persistent Linux VPS/container host.
2. Put it behind HTTPS (Nginx/Caddy/Cloudflare Tunnel or equivalent).
3. Copy `.env.example` to `.env` and replace the API key with a long random value.
4. Start with `docker compose up -d`.
5. In SocialPilot Super Admin → WhatsApp Provider Router:
   - Base URL: the public HTTPS URL.
   - API Key: the plain value used by `X-Api-Key`.
   - Priority: normally `20`.

The image is pinned to `latest-2026.8.2` rather than an unbounded `latest` tag.

SocialPilot creates one WAHA session per workspace, configures signed/custom-header webhooks, and stores WhatsApp media privately in Supabase.
