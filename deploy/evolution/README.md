# SocialPilot WhatsApp Provider — Evolution/Baileys

This stack is intentionally separate from Vercel and Supabase because WhatsApp Web sessions need a persistent process and persistent session storage.

## Requirements

- Linux VPS with Docker Engine + Docker Compose.
- Public HTTPS hostname such as `wa.example.com` terminating TLS at a reverse proxy.
- Persistent storage for PostgreSQL, Redis, and Evolution instances.
- Do not expose PostgreSQL or Redis publicly.

## Deploy

1. Copy `.env.example` to `.env` and replace every placeholder with strong random values.
2. Point `EVOLUTION_PUBLIC_URL` to the HTTPS hostname used by the reverse proxy.
3. Run:

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. Confirm the API is reachable from the internet over HTTPS.
5. In SocialPilot → Super Admin → WhatsApp, enter:
   - Evolution Base URL = the public HTTPS URL.
   - Evolution API Key = `EVOLUTION_API_KEY`.
6. SocialPilot performs a live API health check before enabling the provider.
7. Workspace admins can then connect WhatsApp from the Integration Center by scanning the QR.

## Operational notes

- The stack pins Evolution API `v2.3.7`; do not use `latest` in production.
- Back up the PostgreSQL volume and instance volume.
- Keep the API key private. It is stored only in SocialPilot's server-side secret table.
- SocialPilot configures a unique signed webhook per workspace instance and re-applies it during account health checks.
- Put Evolution behind HTTPS and firewall the host. Only ports 80/443 should normally be public.
