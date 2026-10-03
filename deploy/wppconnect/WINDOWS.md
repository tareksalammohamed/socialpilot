# WPPConnect on Windows without Docker

The application and database stay on Vercel/Supabase. Only the WhatsApp browser
session runs on your Windows computer. Keep the computer powered, online and
awake. No VPS or Docker is needed.

## Install the pinned provider

Install Git and the Node.js version declared by WPPConnect **v2.10.28**
(`22.22.2`), then run in PowerShell in a private folder:

```powershell
git clone --depth 1 --branch v2.10.28 https://github.com/wppconnect-team/wppconnect-server.git
Set-Location wppconnect-server
corepack yarn install --immutable
corepack yarn build
```

Create a `.env` with `SECRET_KEY=<a long random private secret>`,
`HOST=http://localhost`, `PORT=21465` and `TOKEN_STORE_TYPE=file`.
Keep the secret private; enter the same value in SocialPilot's WPPConnect panel.
Preserve the `tokens` and `userDataDir` folders between restarts.

In `src/config.ts`, set `webhook.readMessage` to `false` and
`webhook.allUnreadOnStart` to `true`, then build again. This allows unread
messages to be replayed on restart; SocialPilot handles `unreadmessages` and
deduplicates saved messages. WPPConnect's stock webhook sender does not provide
a durable retry queue, so this is recovery assistance, not a delivery guarantee.

Start the service:

```powershell
corepack yarn start
```

Use Windows Task Scheduler to start the service on login, with the provider
folder as its working directory. Disable sleep while plugged in. This setup
has not been run on your particular computer yet.

## Connect Supabase to the local service

Supabase cannot reach `localhost` on your computer. A tunnel provides HTTPS
without opening a router port. For a free initial test, install `cloudflared`
from Cloudflare's official distribution and run in a second terminal:

```powershell
cloudflared tunnel --url http://localhost:21465
```

Enter the displayed `https://…trycloudflare.com` address as WPPConnect Base URL
in SocialPilot, enter the Secret Key, test the provider, and enable it. Select
WPPConnect for the WhatsApp connection (use controlled switching if the number
already belongs to another provider), then scan the QR.

Quick Tunnels require no account or domain, but the URL changes on each tunnel
restart and they have no uptime guarantee. Update the Base URL and retest after
each restart. For a stable production address, a named tunnel requires a domain
you control. Do not promise a permanent free domain as part of this setup.
Do not add an interactive email-login gate: Supabase needs unattended API access.
The provider API must still require its bearer/secret authentication.

Before relying on it, verify QR scanning, incoming/outgoing text and media,
restart recovery, disconnect and reconnect with the actual phone. Automatic
AI replies also depend on the separately configured AI provider.

Sources:
- https://github.com/wppconnect-team/wppconnect-server/tree/v2.10.28
- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
