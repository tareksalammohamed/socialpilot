# SocialPilot WhatsApp Recovery Provider — WPPConnect

WPPConnect is the third WhatsApp provider. Use it when the primary Evolution session and WAHA fallback are unavailable or incompatible with a specific WhatsApp runtime.

## Deployment

1. Copy `.env.example` to `.env`.
2. Set a long random `WPP_SECRET_KEY`.
3. Set `WPP_PUBLIC_URL` to the public HTTPS URL behind your reverse proxy.
4. Run `docker compose pull && docker compose up -d`.
5. In SocialPilot → Super Admin → WhatsApp — WPPConnect, save the Base URL and `WPP_SECRET_KEY`.

The stack pins `wppconnect/wppconnect-server:2.10.27` and persists tokens plus Chromium user data. SocialPilot generates a separate session token per workspace and injects a unique per-workspace webhook secret.

Provider switching is intentionally explicit: changing provider requires a new QR pair, but SocialPilot preserves the existing WhatsApp account row and Unified Inbox history.
