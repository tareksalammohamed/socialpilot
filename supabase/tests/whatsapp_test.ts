import { closeSession, isWppConnected } from '../functions/_shared/whatsapp-session.ts';

type Handler = (req: Request) => Response | Promise<Response>;
function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) throw new Error(message);
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

// Capture the real HTTP handlers without opening a listener or touching live services.
Deno.env.set('SUPABASE_URL', 'https://database.test');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-only-service-role');
async function loadHandler(path: string): Promise<Handler> {
  const original = Deno.serve;
  let captured: Handler | undefined;
  Object.defineProperty(Deno, 'serve', { value: (handler: Handler) => { captured = handler; return {}; }, configurable: true });
  try { await import(path); } finally { Object.defineProperty(Deno, 'serve', { value: original, configurable: true }); }
  assert(captured, 'Expected a registered handler');
  return captured;
}
const realFetch = globalThis.fetch;
// Supabase captures fetch at client creation; delegate to each test's isolated mock.
globalThis.fetch = (input, init) => globalThis.fetch(input, init);
const provider = await loadHandler('../functions/whatsapp-provider/index.ts');
const legacyWebhook = await loadHandler('../functions/whatsapp-provider-webhook/index.ts');
const wppWebhook = await loadHandler('../functions/whatsapp-wppconnect-webhook/index.ts');
globalThis.fetch = realFetch;

type Call = { url: URL; method: string; body: Record<string, unknown> | null };
async function fixture(run: (calls: Call[]) => Promise<void>, options: { closeStatus?: number; wahaEnabled?: boolean; current?: string } = {}) {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  let wahaCreated = false;
  const account = { id: 'account-1', workspace_id: 'workspace-1', status: 'connected', metadata: {
    provider: options.current ?? 'evolution', instance_name: 'session-1', preserved_setting: 'keep',
  } };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url, method: request.method, body });
    if (url.hostname === 'evolution.test' && url.pathname.startsWith('/instance/delete/')) return json({}, options.closeStatus ?? 200);
    if (url.hostname === 'waha.test') {
      if (request.method === 'POST' && url.pathname === '/api/sessions') { wahaCreated = true; return json({}); }
      if (request.method === 'POST' && url.pathname.endsWith('/start')) return json({});
      if (request.method === 'GET' && url.pathname.endsWith('/session-1')) return wahaCreated ? json({ status: 'WORKING' }) : json({}, 404);
    }
    if (url.hostname !== 'database.test') throw new Error(`Unexpected provider request: ${url}`);
    if (url.pathname === '/auth/v1/user') return json({ id: 'user-1' });
    const table = url.pathname.split('/').pop();
    if (table === 'workspace_members') return json({ role: 'admin' });
    if (table === 'social_platform_apps') return json({ enabled: true, has_secret: true });
    if (table === 'social_platform_app_secrets') return json({ app_secret: JSON.stringify({ version: 1, activeProvider: 'evolution', providers: {
      evolution: { baseUrl: 'https://evolution.test', credential: 'test-key', enabled: true, status: 'connected' },
      waha: { baseUrl: 'https://waha.test', credential: 'test-key', enabled: options.wahaEnabled ?? true, status: 'connected' },
    } }) });
    if (table === 'social_accounts') return json({ ...account, ...(body ?? {}) });
    if (table === 'social_account_tokens') return json({ account_id: account.id, access_token: 'test-session-token', refresh_token: 'a'.repeat(64) });
    throw new Error(`Unexpected database request: ${url}`);
  };
  try { await run(calls); } finally { globalThis.fetch = originalFetch; }
}
function request(action: string, providerKey?: string) {
  return new Request('https://app.test', { method: 'POST', headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'workspace-1', action, ...(providerKey ? { providerKey } : {}) }) });
}

Deno.test('disconnect preserves the account and conversation history', async () => {
  await fixture(async (calls) => {
    const response = await provider(request('disconnect'));
    assert(response.status === 200);
    assert(!calls.some((c) => c.url.hostname === 'database.test' && c.method === 'DELETE'), 'Must never delete the account');
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.pathname.endsWith('/social_accounts'));
    assert(patch?.body?.needs_reconnect === true);
    assert((patch.body.metadata as Record<string, unknown>).preserved_setting === 'keep');
    assert((patch.body.metadata as Record<string, unknown>).onboarding_state === 'disconnected');
  });
});

Deno.test('failed disconnect does not report success or change stored state', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('disconnect'))).status === 502);
    assert(!calls.some((c) => c.method === 'PATCH' || (c.url.hostname === 'database.test' && c.method === 'DELETE')));
  }, { closeStatus: 503 });
});

Deno.test('switch stops when the previous provider cannot be closed', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('switch', 'waha'))).status === 502);
    assert(!calls.some((c) => c.url.hostname === 'waha.test'));
  }, { closeStatus: 503 });
});

Deno.test('unavailable replacement does not disconnect a working number', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('switch', 'waha'))).status === 409);
    assert(!calls.some((c) => c.url.hostname === 'evolution.test'));
  }, { wahaEnabled: false });
});

Deno.test('start cannot silently switch an existing number', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('start', 'waha'))).status === 409);
    assert(!calls.some((c) => c.url.hostname.endsWith('waha.test')));
  });
});

Deno.test('invalid action is rejected without authentication or provider side effects', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('typo'))).status === 400);
    assert(calls.length === 0);
  });
});

Deno.test('WPPConnect negative states are never treated as connected', () => {
  for (const state of ['disconnected', 'notLogged', 'not_logged', 'unlogged', 'unknown', '']) assert(!isWppConnected(state), state);
  for (const state of ['CONNECTED', 'isLogged', 'inChat']) assert(isWppConnected(state), state);
});

Deno.test('WPPConnect status callback updates account to reconnect on DISCONNECTED', async () => {
  await fixture(async (calls) => {
    const response = await wppWebhook(new Request(`https://app.test?session=session-1&secret=${'a'.repeat(64)}`, {
      method: 'POST', body: JSON.stringify({ event: 'status-find', status: 'DISCONNECTED' }),
    }));
    assert(response.status === 200);
    const patch = calls.find((c) => c.method === 'PATCH');
    assert(patch?.body?.status === 'error' && patch.body.needs_reconnect === true);
  }, { current: 'wppconnect' });
});

Deno.test('legacy WPPConnect callbacks resolve session by secret', async () => {
  await fixture(async (calls) => {
    assert((await wppWebhook(new Request(`https://app.test?secret=${'a'.repeat(64)}`, {
      method: 'POST', body: JSON.stringify({ body: { event: 'status-find', status: 'CONNECTED' } }),
    }))).status === 200);
    assert(calls.some((c) => c.method === 'PATCH' && c.body?.status === 'connected'));
  }, { current: 'wppconnect' });
});

Deno.test('legacy router preserves signed bytes and propagates authentication failure', async () => {
  const original = globalThis.fetch;
  const raw = '{ "session": "session-1", "payload": {"text":"مرحبا"} }';
  globalThis.fetch = async (input, init) => {
    const forwarded = new Request(input, init);
    assert(forwarded.url === 'https://database.test/functions/v1/whatsapp-waha-webhook');
    assert(await forwarded.text() === raw);
    assert(forwarded.headers.get('x-webhook-hmac') === 'signature');
    assert(forwarded.headers.get('x-socialpilot-secret') === 'secret');
    return json({ error: 'Invalid signature' }, 401);
  };
  try {
    const response = await legacyWebhook(new Request('https://app.test?provider=waha', { method: 'POST', body: raw,
      headers: { 'x-webhook-hmac': 'signature', 'x-socialpilot-secret': 'secret' } }));
    assert(response.status === 401);
    await response.text();
  } finally { globalThis.fetch = original; }
});

Deno.test('logout rejects a provider error inside HTTP 200', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(json({ status: false }));
  try {
    let rejected = false;
    try { await closeSession('https://provider.test/logout', { method: 'POST' }); } catch { rejected = true; }
    assert(rejected);
  } finally { globalThis.fetch = original; }
});

Deno.test('successful controlled switch preserves account identity and registers the dedicated webhook', async () => {
  await fixture(async (calls) => {
    const response = await provider(request('switch', 'waha'));
    assert(response.status === 200);
    const result = await response.json();
    assert(result.accountId === 'account-1' && result.providerKey === 'waha');
    const creation = calls.find((c) => c.url.hostname === 'waha.test' && c.url.pathname === '/api/sessions');
    const config = creation?.body?.config as { webhooks: Array<{ url: string }> };
    assert(config.webhooks[0].url === 'https://database.test/functions/v1/whatsapp-waha-webhook');
    assert(!calls.some((c) => c.url.hostname === 'database.test' && c.method === 'DELETE'));
    const closedIndex = calls.findIndex((c) => c.url.hostname === 'evolution.test');
    const openedIndex = calls.findIndex((c) => c.url.hostname === 'waha.test');
    assert(closedIndex >= 0 && closedIndex < openedIndex);
  });
});
