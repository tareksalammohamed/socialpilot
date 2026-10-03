# WPPConnect fallback provider for SocialPilot

WPPConnect is the second fallback provider.

For a Windows computer without Docker or a VPS, follow [WINDOWS.md](WINDOWS.md).

## Production setup

1. Run on a persistent Linux VPS/container host behind HTTPS.
2. Copy `.env.example` to `.env` and replace `SECRET_KEY`.
3. Start with `docker compose up -d`.
4. In SocialPilot Super Admin → WhatsApp Provider Router:
   - Base URL: the public HTTPS URL.
   - Secret Key: the exact `SECRET_KEY`.
   - Priority: normally `30`.

The container is pinned to `2.10.28` rather than `latest`.

SocialPilot generates a WPPConnect bearer token per workspace session and stores it only server-side. The per-workspace webhook URL also contains an independent random ingress token.

Because WPPConnect is the last fallback, do not run the same WhatsApp number simultaneously on another provider. Switch only through SocialPilot's controlled reconnect flow.
