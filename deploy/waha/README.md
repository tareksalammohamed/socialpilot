# SocialPilot WhatsApp Fallback — WAHA

WAHA is the first fallback provider after Evolution. The SocialPilot controller supports both QR and Pairing Code for this provider.

## Deployment

1. Copy `.env.example` to `.env`.
2. Replace `WAHA_API_KEY` with a long random secret.
3. Put the container behind a public HTTPS reverse proxy.
4. Run `docker compose pull && docker compose up -d`.
5. In SocialPilot → Super Admin → WhatsApp — WAHA, save the public Base URL and the same plain API key.

The stack pins the GOWS image `devlikeapro/waha:gows-2026.8.2` so this fallback uses a different WhatsApp engine family from Evolution/Baileys. Upgrade only after testing QR, inbound webhook, text, media and delivery acknowledgements.

SocialPilot creates the per-workspace WAHA session and HMAC-signed webhook automatically.
