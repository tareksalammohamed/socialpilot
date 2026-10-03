import { closeSession, isWahaConnected, isWppConnected, wppConnectionState } from '../functions/_shared/whatsapp-session.ts';

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
const wahaWebhook = await loadHandler('../functions/whatsapp-waha-webhook/index.ts');
const evolutionWebhook = await loadHandler('../functions/whatsapp-evolution-webhook/index.ts');
const legacyEvolution = await loadHandler('../functions/whatsapp-evolution/index.ts');
const accountSync = await loadHandler('../functions/account-sync/index.ts');
globalThis.fetch = realFetch;

type Call = { url: URL; method: string; body: Record<string, unknown> | null };
type FixtureOptions = {
  closeStatus?: number; wahaEnabled?: boolean; current?: string; newAccount?: boolean;
  saveFailure?: boolean; applyFailure?: boolean; lookupFailure?: boolean; messageFailure?: boolean;
  conversationFailure?: boolean; inactive?: boolean; wahaExisting?: boolean; wppConnected?: boolean;
  ackFailure?: boolean;
  startFailure?: boolean; wppLogoutMissing?: boolean; wppCloseFailure?: boolean;
  beforeWahaStart?: () => Promise<void>;
};
async function fixture(run: (calls: Call[], readAccount: () => Record<string, unknown> | null) => Promise<void>, options: FixtureOptions = {}) {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  let leased = false;
  let wahaCreated = options.wahaExisting ?? false;
  let account: Record<string, unknown> | null = options.newAccount ? null : {
    id: 'account-1', workspace_id: 'workspace-1', platform: 'whatsapp', status: 'connected', metadata: {
      provider: options.current ?? 'evolution', instance_name: 'session-1', preserved_setting: 'keep',
      ...(options.inactive ? { session_active: false } : {}),
    },
  };
  let tokens = { account_id: 'account-1', access_token: 'test-session-token', refresh_token: 'a'.repeat(64) as string | null };
  const failure = () => json({ code: 'TEST_FAILURE', message: 'Simulated persistence failure' }, 500);
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    calls.push({ url, method: req.method, body });
    if (url.hostname === 'evolution.test') {
      if (url.pathname.startsWith('/instance/delete/')) return json({}, options.closeStatus ?? 200);
      if (url.pathname.includes('/connectionState/')) return json({ instance: { state: 'open' } });
      if (url.pathname.startsWith('/webhook/set/')) return json({});
      if (url.pathname.startsWith('/instance/connect/')) return json({});
    }
    if (url.hostname === 'waha.test') {
      if (req.method === 'DELETE') return json({}, options.closeStatus ?? 200);
      if (req.method === 'POST' && url.pathname === '/api/sessions') { wahaCreated = true; return json({}); }
      if (req.method === 'PUT') return json({});
      if (req.method === 'POST' && url.pathname.endsWith('/start')) {
        await options.beforeWahaStart?.();
        return json({}, options.startFailure ? 503 : 200);
      }
      if (req.method === 'GET' && url.pathname.includes('/api/sessions/')) return wahaCreated ? json({ status: 'WORKING' }) : json({}, 404);
    }
    if (url.hostname === 'wpp.test') {
      if (url.pathname.endsWith('/generate-token')) return json({ token: 'raw-wpp-token', full: 'session-1:raw-wpp-token' });
      assert(req.headers.get('authorization') === 'Bearer raw-wpp-token' || req.headers.get('authorization') === 'Bearer test-session-token', 'Use the raw WPP bearer');
      if (url.pathname.endsWith('/start-session')) return json({ status: 'CLOSED', qrcode: null });
      if (url.pathname.endsWith('/check-connection-session')) return json({ status: options.wppConnected ?? true, message: options.wppConnected === false ? 'Disconnected' : 'Connected' });
      if (url.pathname.endsWith('/qrcode-session')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
      if (url.pathname.endsWith('/logout-session')) return json({}, options.wppLogoutMissing ? 404 : options.closeStatus ?? 200);
      if (url.pathname.endsWith('/close-session')) return json({ status: !options.wppCloseFailure }, options.wppCloseFailure ? 500 : 200);
    }
    if (url.hostname !== 'database.test') throw new Error(`Unexpected provider request: ${url}`);
    if (url.pathname === '/auth/v1/user') return json({ id: 'user-1' });
    const table = url.pathname.split('/').pop();
    if (table === 'whatsapp_claim_operation') { if (leased) return json(false); leased = true; return json(true); }
    if (table === 'whatsapp_release_operation') { leased = false; return json(null); }
    if (table === 'whatsapp_save_session') {
      if (options.saveFailure) return failure();
      const patch = body?.p_account as Record<string, unknown>;
      account = { ...account, id: 'account-1', workspace_id: 'workspace-1', ...patch };
      tokens = { ...tokens, ...body?.p_tokens as typeof tokens };
      return json(account);
    }
    if (table === 'whatsapp_invalidate_session') {
      if (!account) return json(null);
      account = { ...account, status: 'error', needs_reconnect: true, metadata: {
        ...account.metadata as Record<string, unknown>, session_active: false,
        provider_state: 'disconnected', onboarding_state: 'disconnected',
      } };
      tokens.refresh_token = null;
      return json(account);
    }
    if (table === 'whatsapp_apply_state') {
      if (options.applyFailure) return failure();
      if (!account || body?.p_secret !== tokens.refresh_token || (account.metadata as Record<string, unknown>).session_active === false) return json(null);
      const metadata = account.metadata as Record<string, unknown>;
      const last = String(metadata.state_observed_at ?? '');
      if (last && String(body?.p_observed_at) <= last) return json(account);
      const patch = body?.p_patch as Record<string, unknown>;
      account = { ...account, ...patch, metadata: { ...metadata, ...patch.metadata as Record<string, unknown>, state_observed_at: body?.p_observed_at } };
      return json(account);
    }
    if (table === 'workspace_members') return json({ id: 'member-1', role: 'admin' });
    if (table === 'social_platform_apps') return json({ enabled: true, has_secret: true });
    if (table === 'social_platform_app_secrets') return json({ app_secret: JSON.stringify({ version: 1, activeProvider: 'evolution', providers: {
      evolution: { baseUrl: 'https://evolution.test', credential: 'test-key', enabled: true, status: 'connected' },
      waha: { baseUrl: 'https://waha.test', credential: 'test-key', enabled: options.wahaEnabled ?? true, status: 'connected' },
      wppconnect: { baseUrl: 'https://wpp.test', credential: 'test-key', enabled: true, status: 'connected' },
    } }) });
    if (table === 'social_accounts') return options.lookupFailure ? failure() : json(account);
    if (table === 'social_account_tokens') return json(tokens);
    if (table === 'inbox_conversations') return options.conversationFailure ? failure() : json({ id: 'conversation-1' });
    if (table === 'inbox_messages') {
      if (options.ackFailure) return req.method === 'PATCH' ? failure() : json({ id: 'message-1', metadata: {} });
      return options.messageFailure ? failure() : json(null);
    }
    throw new Error(`Unexpected database request: ${url}`);
  };
  try { await run(calls, () => account); } finally { globalThis.fetch = originalFetch; }
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
    assert(calls.some((c) => c.url.pathname.endsWith('/whatsapp_invalidate_session')));
    const state = await (await provider(request('status'))).json();
    assert(state.account.needs_reconnect === true);
    assert(state.account.metadata.preserved_setting === 'keep');
    assert(state.account.metadata.onboarding_state === 'disconnected');
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
    const patch = calls.find((c) => c.url.pathname.endsWith('/whatsapp_apply_state'))?.body?.p_patch as Record<string, unknown>;
    assert(patch?.status === 'error' && patch.needs_reconnect === true);
  }, { current: 'wppconnect' });
});

Deno.test('legacy WPPConnect callbacks resolve session by secret', async () => {
  await fixture(async (calls) => {
    assert((await wppWebhook(new Request(`https://app.test?secret=${'a'.repeat(64)}`, {
      method: 'POST', body: JSON.stringify({ body: { event: 'status-find', status: 'CONNECTED' } }),
    }))).status === 200);
    assert(calls.some((c) => c.url.pathname.endsWith('/whatsapp_apply_state') && (c.body?.p_patch as Record<string, unknown>)?.status === 'connected'));
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

Deno.test('account and webhook credentials are persisted before the replacement starts', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('switch', 'waha'))).status === 200);
    const prepared = calls.findIndex((c) => c.url.pathname.endsWith('/whatsapp_save_session'));
    const opened = calls.findIndex((c) => c.url.hostname === 'waha.test');
    assert(prepared >= 0 && prepared < opened, 'Callbacks must resolve the pending session');
    const saved = calls[prepared].body;
    assert((saved?.p_tokens as Record<string, unknown>).refresh_token);
    assert((saved?.p_account as { metadata: Record<string, unknown> }).metadata.session_active === true);
  });
});

Deno.test('failed atomic persistence never starts or cleans up an unopened provider', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('switch', 'waha'))).status === 502);
    assert(!calls.some((c) => c.url.hostname === 'waha.test'));
    assert(calls.some((c) => c.url.pathname.endsWith('/whatsapp_release_operation')));
  }, { saveFailure: true });
});

Deno.test('concurrent operations cannot open a second provider', async () => {
  let unblock: () => void = () => {};
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const wait = new Promise<void>((resolve) => { unblock = resolve; });
  await fixture(async (calls) => {
    const first = provider(request('switch', 'waha'));
    await started;
    try {
      assert((await provider(request('switch', 'wppconnect'))).status === 409);
      assert(!calls.some((c) => c.url.hostname === 'wpp.test'));
    } finally { unblock(); }
    assert((await first).status === 200);
  }, { beforeWahaStart: async () => { notifyStarted(); await wait; } });
});

Deno.test('legacy Evolution cannot overwrite or disconnect another provider', async () => {
  await fixture(async (calls) => {
    for (const action of ['start', 'disconnect', 'status']) assert((await legacyEvolution(request(action))).status === 409);
    assert(!calls.some((c) => c.url.hostname === 'evolution.test'));
  }, { current: 'wppconnect' });
});

Deno.test('WAHA reconnect refreshes webhook configuration and uses only WORKING as ready', async () => {
  assert(isWahaConnected('WORKING'));
  assert(!isWahaConnected('authenticated') && !isWahaConnected('STARTING'));
  await fixture(async (calls) => {
    assert((await provider(request('start'))).status === 200);
    assert(calls.some((c) => c.url.hostname === 'waha.test' && c.method === 'PUT'));
  }, { current: 'waha', wahaExisting: true });
});

Deno.test('WPP boolean connection responses and binary QR images are supported', async () => {
  assert(wppConnectionState({ status: true, message: 'Connected' }) === 'connected');
  assert(wppConnectionState({ status: false, message: 'Connected' }) === 'disconnected');
  await fixture(async (calls) => {
    const started = await (await provider(request('start', 'wppconnect'))).json();
    assert(started.connected === false && started.qrBase64 === 'data:image/png;base64,iVBORw==');
    const config = calls.find((c) => c.url.pathname.endsWith('/start-session'))?.body;
    assert(config?.waitQrCode === false, 'Do not wait for a slow browser/scan inside a short Edge request');
    const polled = await (await provider(request('status'))).json();
    assert(polled.qrBase64 === started.qrBase64, 'Delayed/renewed QR is returned by polling');
  }, { newAccount: true, wppConnected: false });
});

Deno.test('WPP QR browser is explicitly closed when logout returns 404', async () => {
  await fixture(async (calls) => {
    assert((await provider(request('switch', 'waha'))).status === 200);
    assert(calls.some((c) => c.url.hostname === 'wpp.test' && c.url.pathname.endsWith('/close-session')));
  }, { current: 'wppconnect', wppLogoutMissing: true });
  await fixture(async (calls) => {
    assert((await provider(request('switch', 'waha'))).status === 502);
    assert(!calls.some((c) => c.url.hostname === 'waha.test'));
  }, { current: 'wppconnect', wppLogoutMissing: true, wppCloseFailure: true });
});

function wppEvent(body: unknown, secret = 'a'.repeat(64)) {
  return new Request(`https://app.test?session=session-1&secret=${secret}`, { method: 'POST', body: JSON.stringify(body) });
}
function evolutionEvent(body: unknown, secret = 'a'.repeat(64)) {
  return new Request('https://app.test', { method: 'POST', headers: { 'x-socialpilot-secret': secret }, body: JSON.stringify(body) });
}
async function wahaEvent(body: unknown, corruptSignature = false): Promise<Request> {
  const raw = JSON.stringify(body);
  const secret = 'a'.repeat(64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hmac = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://app.test', { method: 'POST', body: raw, headers: {
    'x-socialpilot-secret': secret, 'x-webhook-hmac': corruptSignature ? 'bad' : hmac, 'x-webhook-hmac-algorithm': 'sha512',
  } });
}

Deno.test('WAHA real HMAC and Evolution/WPP session secrets reject forged callbacks', async () => {
  await fixture(async () => {
    assert((await wahaWebhook(await wahaEvent({ session: 'session-1', event: 'session.status', payload: { status: 'WORKING' } }))).status === 200);
    assert((await wahaWebhook(await wahaEvent({ session: 'session-1', event: 'session.status', payload: { status: 'WORKING' } }, true))).status === 401);
    assert((await wahaWebhook(new Request('https://app.test', { method: 'POST', body: 'null' }))).status === 400);
  }, { current: 'waha' });
  await fixture(async () => {
    assert((await evolutionWebhook(evolutionEvent({ instance: 'session-1', event: 'connection.update', data: { state: 'open' } }, 'wrong'))).status === 401);
    assert((await wppWebhook(wppEvent({ event: 'status-find', status: 'CONNECTED' }, 'b'.repeat(64)))).status === 401);
  });
});

Deno.test('disconnected sessions and older signed state events cannot restore connection', async () => {
  await fixture(async (calls) => {
    assert((await wppWebhook(wppEvent({ event: 'status-find', status: 'CONNECTED' }))).status === 200);
    assert(!calls.some((c) => c.url.pathname.endsWith('/whatsapp_apply_state')));
  }, { current: 'wppconnect', inactive: true });
  await fixture(async (_calls, readAccount) => {
    const now = Date.now();
    await wahaWebhook(await wahaEvent({ session: 'session-1', event: 'session.status', timestamp: now, payload: { status: 'STOPPED' } }));
    await wahaWebhook(await wahaEvent({ session: 'session-1', event: 'session.status', timestamp: now - 10_000, payload: { status: 'WORKING' } }));
    assert((readAccount()?.metadata as Record<string, unknown>).provider_state === 'STOPPED');
    const status = await (await provider(request('list_methods'))).json();
    assert(status.activeProvider === 'waha');
    const polled = await (await provider(request('status'))).json();
    assert(polled.connected === false);
  }, { current: 'waha', wahaEnabled: false });
});

Deno.test('provider/database failures are persisted or returned instead of false success', async () => {
  await fixture(async () => {
    const response = await provider(request('status'));
    const status = await response.json();
    assert(status.connected === false && status.account.status === 'error');
  }, { current: 'waha', wahaEnabled: false });
  await fixture(async (calls) => {
    assert((await provider(request('start'))).status === 502);
    assert(!calls.some((c) => c.url.hostname === 'evolution.test'));
  }, { lookupFailure: true });
  await fixture(async () => {
    assert((await wppWebhook(wppEvent({ event: 'status-find', status: 'CONNECTED' }))).status === 500);
  }, { current: 'wppconnect', applyFailure: true });
});

Deno.test('all providers return failure when an inbound message cannot be saved', async () => {
  for (const conversationFailure of [true, false]) {
    const options = { conversationFailure, messageFailure: !conversationFailure };
    await fixture(async () => {
      assert((await wppWebhook(wppEvent({ event: 'onmessage', id: 'msg-1', from: '123@c.us', body: 'hello' }))).status === 500);
    }, { ...options, current: 'wppconnect' });
    await fixture(async () => {
      assert((await wahaWebhook(await wahaEvent({ session: 'session-1', event: 'message', payload: { id: 'msg-1', from: '123@c.us', body: 'hello' } }))).status === 500);
    }, { ...options, current: 'waha' });
    await fixture(async () => {
      assert((await evolutionWebhook(evolutionEvent({ instance: 'session-1', event: 'messages.upsert', data: { key: { id: 'msg-1', remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'hello' } } }))).status === 500);
    }, { ...options, current: 'evolution' });
  }
});

Deno.test('account-sync uses the same lifecycle and never reactivates an intentional disconnect', async () => {
  await fixture(async (calls) => {
    const response = await accountSync(new Request('https://app.test', { method: 'POST',
      headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'account-1' }),
    }));
    assert(response.status === 200);
    assert(calls.some((c) => c.url.pathname.endsWith('/whatsapp_claim_operation')));
    assert(!calls.some((c) => c.method === 'PATCH' || c.url.hostname === 'wpp.test'));
  }, { current: 'wppconnect', inactive: true });
});

Deno.test('every provider switch direction preserves identity and closes the previous session first', async () => {
  const hosts: Record<string, string> = { evolution: 'evolution.test', waha: 'waha.test', wppconnect: 'wpp.test' };
  for (const current of Object.keys(hosts)) {
    for (const target of Object.keys(hosts).filter((key) => key !== current)) {
      await fixture(async (calls) => {
        const response = await provider(request('switch', target));
        const body = await response.json();
        assert(response.status === 200 && body.accountId === 'account-1' && body.providerKey === target, `${current} -> ${target}`);
        const closed = calls.findIndex((c) => c.url.hostname === hosts[current]);
        const opened = calls.findIndex((c) => c.url.hostname === hosts[target]);
        assert(closed >= 0 && opened > closed);
      }, { current });
    }
  }
});

Deno.test('account-sync retains the webhook watchdog inside its lifecycle lease', async () => {
  await fixture(async (calls) => {
    assert((await accountSync(new Request('https://app.test', { method: 'POST',
      headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'account-1' }),
    }))).status === 200);
    assert(calls.some((c) => c.url.hostname === 'waha.test' && c.method === 'PUT'));
    assert(calls.some((c) => c.url.pathname.endsWith('/whatsapp_claim_operation')));
  }, { current: 'waha', wahaExisting: true });
});

Deno.test('all providers return failure when delivery acknowledgements cannot be saved', async () => {
  await fixture(async () => {
    assert((await wppWebhook(wppEvent({ event: 'onack', id: 'msg-1', ack: 2 }))).status === 500);
  }, { current: 'wppconnect', ackFailure: true });
  await fixture(async () => {
    assert((await wahaWebhook(await wahaEvent({ session: 'session-1', event: 'message.ack', payload: { id: 'msg-1', ack: 2 } }))).status === 500);
  }, { current: 'waha', ackFailure: true });
  await fixture(async () => {
    assert((await evolutionWebhook(evolutionEvent({ instance: 'session-1', event: 'messages.update', data: { key: { id: 'msg-1' }, status: 2 } }))).status === 500);
  }, { current: 'evolution', ackFailure: true });
});
