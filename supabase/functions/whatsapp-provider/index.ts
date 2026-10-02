import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Provider = 'evolution' | 'waha' | 'wppconnect';
type Action = 'providers' | 'start' | 'status' | 'disconnect';
type PairingMode = 'qr' | 'code';

type ProviderConfig = {
  provider: Provider;
  platformKey: 'whatsapp' | 'whatsapp_waha' | 'whatsapp_wppconnect';
  baseUrl: string;
  secret: string;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Provider Base URL غير صالح');
  return parsed.toString().replace(/\/$/, '');
}

function platformKey(provider: Provider): ProviderConfig['platformKey'] {
  if (provider === 'waha') return 'whatsapp_waha';
  if (provider === 'wppconnect') return 'whatsapp_wppconnect';
  return 'whatsapp';
}

function providerLabel(provider: Provider): string {
  if (provider === 'waha') return 'WAHA';
  if (provider === 'wppconnect') return 'WPPConnect';
  return 'Evolution';
}

function instanceName(workspaceId: string): string {
  return `socialpilot_${workspaceId.replace(/-/g, '')}`;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requireAdmin(req: Request, workspaceId: string): Promise<{ userId: string; token: string } | { response: Response }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return { response: json(401, { error: 'Unauthorized' }) };
  const { data: auth } = await supabase.auth.getUser(token);
  if (!auth.user) return { response: json(401, { error: 'Unauthorized' }) };

  const { data: member } = await supabase.from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!member || !['owner', 'admin'].includes(String(member.role))) {
    return { response: json(403, { error: 'ربط WhatsApp متاح لمالك أو Admin مساحة العمل فقط' }) };
  }
  return { userId: auth.user.id, token };
}

async function loadConfig(provider: Provider): Promise<ProviderConfig> {
  const key = platformKey(provider);
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps')
      .select('app_id,enabled,status')
      .eq('platform_key', key)
      .maybeSingle(),
    supabase.from('social_platform_app_secrets')
      .select('app_secret')
      .eq('platform_key', key)
      .maybeSingle(),
  ]);
  if (!app?.enabled || app.status !== 'connected' || !app.app_id || !secret?.app_secret) {
    throw new Error(`${providerLabel(provider)} غير مُعد أو غير سليم في Super Admin`);
  }
  return {
    provider,
    platformKey: key,
    baseUrl: normalizeBaseUrl(String(app.app_id)),
    secret: String(secret.app_secret),
  };
}

async function listProviders() {
  const keys = ['whatsapp', 'whatsapp_waha', 'whatsapp_wppconnect'];
  const { data } = await supabase.from('social_platform_apps')
    .select('platform_key,display_name,enabled,status,last_error,last_test_at')
    .in('platform_key', keys)
    .order('platform_key');

  const byKey = new Map((data ?? []).map((row) => [row.platform_key, row]));
  return ([
    ['evolution', 'whatsapp', ['qr']],
    ['waha', 'whatsapp_waha', ['qr', 'code']],
    ['wppconnect', 'whatsapp_wppconnect', ['qr']],
  ] as const).map(([provider, key, methods]) => {
    const row = byKey.get(key);
    return {
      provider,
      key,
      displayName: row?.display_name ?? providerLabel(provider),
      configured: Boolean(row?.enabled && row?.status === 'connected'),
      enabled: Boolean(row?.enabled),
      status: row?.status ?? 'not_configured',
      lastError: row?.last_error ?? null,
      lastTestAt: row?.last_test_at ?? null,
      methods,
      recommended: provider === 'evolution',
      fallbackOrder: provider === 'evolution' ? 1 : provider === 'waha' ? 2 : 3,
    };
  });
}

async function loadAccount(workspaceId: string) {
  const { data } = await supabase.from('social_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'whatsapp')
    .maybeSingle();
  return data;
}

async function loadTokenRow(accountId: string) {
  const { data } = await supabase.from('social_account_tokens')
    .select('access_token,refresh_token')
    .eq('account_id', accountId)
    .maybeSingle();
  return data;
}

async function saveAccount(params: {
  workspaceId: string;
  provider: Provider;
  name: string;
  account: Record<string, unknown> | null;
  webhookSecret: string;
  providerToken?: string;
}) {
  const existingMetadata = (params.account?.metadata ?? {}) as Record<string, unknown>;
  const { data: saved, error } = await supabase.from('social_accounts').upsert({
    workspace_id: params.workspaceId,
    platform: 'whatsapp',
    external_id: String(params.account?.external_id ?? params.name),
    handle: params.account?.handle ?? 'WhatsApp Web',
    display_name: params.account?.display_name ?? 'WhatsApp',
    status: 'error',
    needs_reconnect: true,
    metadata: {
      ...existingMetadata,
      provider: params.provider,
      instance_name: params.name,
      onboarding_state: 'scan_qr',
      provider_state: 'starting',
      switched_at: existingMetadata.provider && existingMetadata.provider !== params.provider
        ? new Date().toISOString()
        : existingMetadata.switched_at ?? null,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,platform' }).select().single();
  if (error || !saved) throw new Error(error?.message ?? 'تعذّر حفظ WhatsApp account');

  await supabase.from('social_account_tokens').upsert({
    account_id: saved.id,
    access_token: params.providerToken ?? `${params.provider}-provider`,
    refresh_token: params.webhookSecret,
    token_type: 'provider_session',
    expires_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_id' });

  return saved;
}

async function callEvolutionUserFunction(
  token: string,
  workspaceId: string,
  action: 'start' | 'status' | 'disconnect',
): Promise<Record<string, unknown>> {
  const response = await fetch(`${supabaseUrl}/functions/v1/whatsapp-evolution`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(Deno.env.get('SUPABASE_ANON_KEY') ? { apikey: Deno.env.get('SUPABASE_ANON_KEY')! } : {}),
    },
    body: JSON.stringify({ workspaceId, action }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Evolution HTTP ${response.status}`);
  return body;
}

async function wahaFetch(
  cfg: ProviderConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      'X-Api-Key': cfg.secret,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, body };
}

async function wahaStart(
  cfg: ProviderConfig,
  name: string,
  webhookSecret: string,
  pairingMode: PairingMode,
  phoneNumber?: string,
) {
  const sessionBody = {
    name,
    config: {
      metadata: { socialpilot: true },
      webhooks: [{
        url: `${supabaseUrl}/functions/v1/whatsapp-waha-webhook`,
        events: ['session.status', 'message.any', 'message.ack'],
        hmac: { key: webhookSecret },
        retries: { policy: 'linear', delaySeconds: 2, attempts: 4 },
      }],
    },
  };

  let result = await wahaFetch(cfg, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify(sessionBody),
  });
  if ([400, 409, 422].includes(result.response.status)) {
    result = await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(sessionBody),
    });
    await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(name)}/start`, { method: 'POST' });
  }
  if (!result.response.ok && ![200, 201, 409, 422].includes(result.response.status)) {
    throw new Error(typeof result.body.message === 'string' ? result.body.message : `WAHA create HTTP ${result.response.status}`);
  }

  if (pairingMode === 'code') {
    const number = String(phoneNumber ?? '').replace(/\D/g, '');
    if (!number) throw new Error('رقم الهاتف مطلوب للحصول على Pairing Code');
    const code = await wahaFetch(cfg, `/api/${encodeURIComponent(name)}/auth/request-code`, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: number }),
    });
    if (!code.response.ok || typeof code.body.code !== 'string') {
      throw new Error(typeof code.body.message === 'string' ? code.body.message : 'WAHA لم يُرجع Pairing Code');
    }
    return { pairingCode: code.body.code as string, qrBase64: null };
  }

  const qr = await wahaFetch(cfg, `/api/${encodeURIComponent(name)}/auth/qr?format=image`, {
    headers: { Accept: 'application/json' },
  });
  const data = typeof qr.body.data === 'string' ? qr.body.data : null;
  return { pairingCode: null, qrBase64: data };
}

async function wahaState(cfg: ProviderConfig, name: string) {
  const result = await wahaFetch(cfg, `/api/sessions/${encodeURIComponent(name)}`);
  if (result.response.status === 404) return { state: 'missing', connected: false, raw: result.body };
  const state = String(result.body.status ?? 'unknown').toUpperCase();
  return { state, connected: state === 'WORKING', raw: result.body };
}

async function wahaDisconnect(cfg: ProviderConfig, name: string) {
  await wahaFetch(cfg, '/api/sessions/logout', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

async function generateWppToken(cfg: ProviderConfig, name: string): Promise<string> {
  const response = await fetch(
    `${cfg.baseUrl}/api/${encodeURIComponent(name)}/${encodeURIComponent(cfg.secret)}/generate-token`,
    { method: 'POST' },
  );
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `WPPConnect token HTTP ${response.status}`);
  if (typeof body.token === 'string') return body.token;
  if (typeof body.full === 'string') return body.full.replace(/^wppconnect:/i, '');
  throw new Error('WPPConnect لم يُرجع session token');
}

async function wppFetch(
  cfg: ProviderConfig,
  name: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${cfg.baseUrl}/api/${encodeURIComponent(name)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, body };
}

function extractWppQr(body: Record<string, unknown>): string | null {
  const candidates = [body.qrcode, body.qrCode, body.qrcodeBase64, body.base64, body.urlCode];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 20) {
      const match = value.match(/^data:image\/[^;]+;base64,(.+)$/);
      return match ? match[1] : value;
    }
  }
  return null;
}

async function wppStart(
  cfg: ProviderConfig,
  name: string,
  token: string,
  webhookSecret: string,
) {
  const webhook = `${supabaseUrl}/functions/v1/whatsapp-wppconnect-webhook?secret=${encodeURIComponent(webhookSecret)}`;
  const started = await wppFetch(cfg, name, token, '/start-session', {
    method: 'POST',
    body: JSON.stringify({ webhook, waitQrCode: true }),
  });
  if (!started.response.ok) {
    throw new Error(typeof started.body.message === 'string' ? started.body.message : `WPPConnect start HTTP ${started.response.status}`);
  }

  let qrBase64 = extractWppQr(started.body);
  if (!qrBase64) {
    const qr = await wppFetch(cfg, name, token, '/qrcode-session');
    qrBase64 = extractWppQr(qr.body);
  }
  return { qrBase64, pairingCode: null };
}

async function wppState(cfg: ProviderConfig, name: string, token: string) {
  const result = await wppFetch(cfg, name, token, '/check-connection-session');
  if (result.response.status === 404) return { state: 'missing', connected: false, raw: result.body };
  const rawState = result.body.status ?? result.body.state ?? result.body.message;
  const state = String(rawState ?? 'unknown').toUpperCase();
  const connected = ['CONNECTED', 'ISLOGGED', 'INCHAT', 'OPEN', 'WORKING'].some((value) => state.includes(value));
  return { state, connected, raw: result.body };
}

async function wppDisconnect(cfg: ProviderConfig, name: string, token: string) {
  await wppFetch(cfg, name, token, '/logout-session', { method: 'POST' });
}

async function markDisconnected(account: Record<string, unknown> | null, state = 'disconnected') {
  if (!account?.id) return;
  await supabase.from('social_accounts').update({
    status: 'error',
    needs_reconnect: true,
    last_sync_at: new Date().toISOString(),
    metadata: {
      ...((account.metadata ?? {}) as Record<string, unknown>),
      provider_state: state,
      onboarding_state: 'disconnected',
      disconnected_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }).eq('id', account.id);
}

async function disconnectProvider(
  provider: Provider,
  account: Record<string, unknown> | null,
  token: string,
  workspaceId: string,
) {
  if (!account) return;
  const name = String((account.metadata as Record<string, unknown> | null)?.instance_name ?? instanceName(workspaceId));
  try {
    if (provider === 'evolution') {
      await callEvolutionUserFunction(token, workspaceId, 'disconnect');
      return;
    }
    const cfg = await loadConfig(provider);
    if (provider === 'waha') {
      await wahaDisconnect(cfg, name);
    } else {
      const row = await loadTokenRow(String(account.id));
      const providerToken = typeof row?.access_token === 'string' ? row.access_token : '';
      if (providerToken) await wppDisconnect(cfg, name, providerToken);
    }
  } finally {
    await markDisconnected(account);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await req.json().catch(() => ({})) as {
    action?: Action;
    workspaceId?: string;
    provider?: Provider;
    pairingMode?: PairingMode;
    phoneNumber?: string;
  };
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId || !body.action) return json(400, { error: 'workspaceId و action مطلوبين' });

  const auth = await requireAdmin(req, workspaceId);
  if ('response' in auth) return auth.response;

  try {
    if (body.action === 'providers') {
      const account = await loadAccount(workspaceId);
      return json(200, {
        providers: await listProviders(),
        activeProvider: (account?.metadata as Record<string, unknown> | null)?.provider ?? null,
        accountStatus: account?.status ?? null,
      });
    }

    const account = await loadAccount(workspaceId);
    const currentProvider = ((account?.metadata as Record<string, unknown> | null)?.provider ?? null) as Provider | null;

    if (body.action === 'disconnect') {
      if (currentProvider) await disconnectProvider(currentProvider, account, auth.token, workspaceId);
      else await markDisconnected(account);
      return json(200, { ok: true, connected: false, state: 'disconnected', accountId: account?.id ?? null });
    }

    if (body.action === 'status') {
      if (!account || !currentProvider) {
        return json(200, { configured: true, connected: false, state: 'not_created', provider: null });
      }
      if (currentProvider === 'evolution') {
        const result = await callEvolutionUserFunction(auth.token, workspaceId, 'status');
        return json(200, { ...result, provider: 'evolution' });
      }

      const cfg = await loadConfig(currentProvider);
      const name = String((account.metadata as Record<string, unknown> | null)?.instance_name ?? instanceName(workspaceId));
      let state: { state: string; connected: boolean; raw: Record<string, unknown> };
      if (currentProvider === 'waha') {
        state = await wahaState(cfg, name);
      } else {
        const tokenRow = await loadTokenRow(String(account.id));
        const providerToken = typeof tokenRow?.access_token === 'string' ? tokenRow.access_token : '';
        if (!providerToken) throw new Error('WPPConnect session token مفقود');
        state = await wppState(cfg, name, providerToken);
      }

      await supabase.from('social_accounts').update({
        status: state.connected ? 'connected' : 'error',
        needs_reconnect: !state.connected,
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((account.metadata ?? {}) as Record<string, unknown>),
          provider_state: state.state,
          onboarding_state: state.connected ? 'ready' : 'scan_qr',
        },
      }).eq('id', account.id);

      return json(200, {
        configured: true,
        provider: currentProvider,
        connected: state.connected,
        state: state.state,
        accountId: account.id,
      });
    }

    const provider = body.provider ?? 'evolution';
    const cfg = await loadConfig(provider);
    if (currentProvider && currentProvider !== provider) {
      await disconnectProvider(currentProvider, account, auth.token, workspaceId);
    }

    if (provider === 'evolution') {
      const result = await callEvolutionUserFunction(auth.token, workspaceId, 'start');
      return json(200, { ...result, provider: 'evolution', methods: ['qr'] });
    }

    const name = instanceName(workspaceId);
    const oldToken = account?.id ? await loadTokenRow(String(account.id)) : null;
    const webhookSecret = typeof oldToken?.refresh_token === 'string' && currentProvider === provider
      ? oldToken.refresh_token
      : randomSecret();

    let providerToken: string | undefined;
    if (provider === 'wppconnect') {
      providerToken = await generateWppToken(cfg, name);
    }

    const saved = await saveAccount({
      workspaceId,
      provider,
      name,
      account,
      webhookSecret,
      providerToken,
    });

    let pairing: { qrBase64: string | null; pairingCode: string | null };
    let state: { state: string; connected: boolean; raw: Record<string, unknown> };

    if (provider === 'waha') {
      pairing = await wahaStart(
        cfg,
        name,
        webhookSecret,
        body.pairingMode === 'code' ? 'code' : 'qr',
        body.phoneNumber,
      );
      state = await wahaState(cfg, name);
    } else {
      pairing = await wppStart(cfg, name, providerToken!, webhookSecret);
      state = await wppState(cfg, name, providerToken!);
    }

    await supabase.from('social_accounts').update({
      status: state.connected ? 'connected' : 'error',
      needs_reconnect: !state.connected,
      last_sync_at: new Date().toISOString(),
      metadata: {
        ...((saved.metadata ?? {}) as Record<string, unknown>),
        provider,
        instance_name: name,
        provider_state: state.state,
        onboarding_state: state.connected ? 'ready' : pairing.pairingCode ? 'pairing_code' : 'scan_qr',
      },
    }).eq('id', saved.id);

    return json(200, {
      ok: true,
      configured: true,
      provider,
      connected: state.connected,
      state: state.state,
      qrBase64: pairing.qrBase64,
      pairingCode: pairing.pairingCode,
      accountId: saved.id,
      methods: provider === 'waha' ? ['qr', 'code'] : ['qr'],
    });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'تعذّر تشغيل WhatsApp provider' });
  }
});
