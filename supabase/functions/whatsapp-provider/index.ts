import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const supabase = createClient(
  supabaseUrl,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type ProviderKey = 'evolution' | 'waha' | 'wppconnect';
type Action = 'list_methods' | 'start' | 'status' | 'disconnect' | 'switch';

type ProviderConfig = {
  baseUrl: string;
  credential: string;
  enabled: boolean;
  priority: number;
  status: 'not_configured' | 'connected' | 'error';
  lastError: string | null;
  lastTestAt: string | null;
};

type ProviderBundle = {
  version: 1;
  activeProvider: ProviderKey | null;
  providers: Partial<Record<ProviderKey, ProviderConfig>>;
};

const PROVIDERS: ProviderKey[] = ['evolution', 'waha', 'wppconnect'];
const LABELS: Record<ProviderKey, string> = {
  evolution: 'Evolution / Baileys',
  waha: 'WAHA',
  wppconnect: 'WPPConnect',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function validProvider(value: unknown): value is ProviderKey {
  return value === 'evolution' || value === 'waha' || value === 'wppconnect';
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function instanceName(workspaceId: string): string {
  return `socialpilot_${workspaceId.replace(/-/g, '')}`;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeState(value: unknown): string {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/\s+/g, '_');
}

function connectedState(provider: ProviderKey, state: string): boolean {
  if (provider === 'evolution') return ['open', 'connected'].includes(state);
  if (provider === 'waha') return ['working', 'connected', 'authenticated'].includes(state);
  return ['connected', 'islogged', 'logged', 'open', 'inchat', 'ischat'].includes(state);
}

function parseBundle(secretValue: unknown, legacyBaseUrl?: unknown): ProviderBundle {
  const raw = typeof secretValue === 'string' ? secretValue.trim() : '';
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as ProviderBundle;
      if (parsed?.version === 1 && parsed.providers && typeof parsed.providers === 'object') {
        return parsed;
      }
    } catch {
      // Legacy Evolution secret below.
    }
  }

  const legacyUrl = typeof legacyBaseUrl === 'string' && /^https?:\/\//i.test(legacyBaseUrl)
    ? normalizeBaseUrl(legacyBaseUrl)
    : '';
  if (raw && legacyUrl) {
    return {
      version: 1,
      activeProvider: 'evolution',
      providers: {
        evolution: {
          baseUrl: legacyUrl,
          credential: raw,
          enabled: true,
          priority: 10,
          status: 'connected',
          lastError: null,
          lastTestAt: null,
        },
      },
    };
  }
  return { version: 1, activeProvider: null, providers: {} };
}

async function providerBundle(): Promise<ProviderBundle> {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps')
      .select('app_id,enabled,has_secret')
      .eq('platform_key', 'whatsapp')
      .maybeSingle(),
    supabase.from('social_platform_app_secrets')
      .select('app_secret')
      .eq('platform_key', 'whatsapp')
      .maybeSingle(),
  ]);
  if (!app?.has_secret || !secret?.app_secret) {
    return { version: 1, activeProvider: null, providers: {} };
  }
  return parseBundle(secret.app_secret, app.app_id);
}

function healthyProviders(bundle: ProviderBundle, exclude?: ProviderKey | null): ProviderKey[] {
  return PROVIDERS
    .filter((provider) => provider !== exclude)
    .filter((provider) => {
      const config = bundle.providers[provider];
      return Boolean(config?.enabled && config.status === 'connected' && config.baseUrl && config.credential);
    })
    .sort((a, b) => {
      if (a === bundle.activeProvider) return -1;
      if (b === bundle.activeProvider) return 1;
      return (bundle.providers[a]?.priority ?? 999) - (bundle.providers[b]?.priority ?? 999);
    });
}

function publicMethod(provider: ProviderKey, config: ProviderConfig | undefined, activeProvider: ProviderKey | null) {
  return {
    providerKey: provider,
    displayName: LABELS[provider],
    priority: config?.priority ?? (provider === 'evolution' ? 10 : provider === 'waha' ? 20 : 30),
    status: config?.status ?? 'not_configured',
    lastError: config?.lastError ?? null,
    available: Boolean(config?.enabled && config.status === 'connected' && config.baseUrl && config.credential),
    active: activeProvider === provider,
  };
}

async function requireAdmin(req: Request, workspaceId: string): Promise<{ userId: string } | { response: Response }> {
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
  return { userId: auth.user.id };
}

async function loadAccount(workspaceId: string) {
  const { data } = await supabase.from('social_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'whatsapp')
    .maybeSingle();
  return data;
}

async function loadTokens(accountId?: string | null): Promise<{ accessToken: string | null; webhookSecret: string | null }> {
  if (!accountId) return { accessToken: null, webhookSecret: null };
  const { data } = await supabase.from('social_account_tokens')
    .select('access_token,refresh_token')
    .eq('account_id', accountId)
    .maybeSingle();
  return {
    accessToken: typeof data?.access_token === 'string' ? data.access_token : null,
    webhookSecret: typeof data?.refresh_token === 'string' ? data.refresh_token : null,
  };
}

async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, body };
}

function qrFrom(body: Record<string, unknown>) {
  const qrcode = body.qrcode as Record<string, unknown> | undefined;
  const data = body.data as Record<string, unknown> | undefined;
  const base64 = [qrcode?.base64, body.base64, body.qrCode, body.qrcode, data?.base64, data?.qrcode, data?.qrCode]
    .find((value) => typeof value === 'string' && value.length > 20) as string | undefined;
  const code = [qrcode?.code, body.code, data?.code, data?.value]
    .find((value) => typeof value === 'string' && value.length > 3) as string | undefined;
  const pairing = [qrcode?.pairingCode, body.pairingCode, body.pairing_code, data?.pairingCode]
    .find((value) => typeof value === 'string' && value.length > 2) as string | undefined;
  return { qrBase64: base64 ?? null, qrCode: code ?? null, pairingCode: pairing ?? null };
}

async function evolutionState(config: ProviderConfig, instance: string): Promise<string> {
  let result = await requestJson(
    `${normalizeBaseUrl(config.baseUrl)}/instance/connectionState/${encodeURIComponent(instance)}`,
    { headers: { apikey: config.credential } },
  );
  if (result.response.ok) {
    const nested = result.body.instance as Record<string, unknown> | undefined;
    return normalizeState(nested?.state ?? result.body.state);
  }
  result = await requestJson(
    `${normalizeBaseUrl(config.baseUrl)}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
    { headers: { apikey: config.credential } },
  );
  if (!result.response.ok) return 'missing';
  const rows = Array.isArray(result.body) ? result.body : ((result.body.instances as unknown[]) ?? []);
  const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  return normalizeState(row?.connectionStatus ?? row?.connectionState ?? row?.state);
}

async function evolutionStart(config: ProviderConfig, instance: string, webhookSecret: string) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  let state = await evolutionState(config, instance);

  if (state === 'missing' || state === 'unknown') {
    const created = await requestJson(`${baseUrl}/instance/create`, {
      method: 'POST',
      headers: { apikey: config.credential, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceName: instance,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        rejectCall: true,
        groupsIgnore: true,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        syncFullHistory: false,
      }),
    });
    if (!created.response.ok && created.response.status !== 409) {
      throw new Error(String(created.body.message ?? created.body.error ?? `Evolution create HTTP ${created.response.status}`));
    }
  }

  const webhookPayload = {
    webhook: {
      enabled: true,
      url: `${supabaseUrl}/functions/v1/whatsapp-evolution-webhook`,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE', 'SEND_MESSAGE_UPDATE'],
      headers: { 'x-socialpilot-secret': webhookSecret },
    },
  };
  let hook = await requestJson(`${baseUrl}/webhook/set/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: { apikey: config.credential, 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload),
  });
  if (hook.response.status === 404) {
    hook = await requestJson(`${baseUrl}/event/webhook/set/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: config.credential, 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });
  }
  if (!hook.response.ok) throw new Error(`Evolution webhook HTTP ${hook.response.status}`);

  let connect = await requestJson(`${baseUrl}/instance/connect/${encodeURIComponent(instance)}`, {
    headers: { apikey: config.credential, Accept: 'application/json' },
  });
  if (!connect.response.ok && connect.response.status !== 409) {
    connect = await requestJson(`${baseUrl}/instance/connect/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: config.credential, Accept: 'application/json' },
    });
  }
  if (!connect.response.ok && connect.response.status !== 409) {
    throw new Error(String(connect.body.message ?? connect.body.error ?? `Evolution connect HTTP ${connect.response.status}`));
  }

  state = await evolutionState(config, instance);
  return { state, ...qrFrom(connect.body), sessionToken: null as string | null };
}

async function evolutionDisconnect(config: ProviderConfig, instance: string): Promise<void> {
  const headers = { apikey: config.credential };
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  await fetch(`${baseUrl}/instance/logout/${encodeURIComponent(instance)}`, { method: 'DELETE', headers }).catch(() => null);
  await fetch(`${baseUrl}/instance/delete/${encodeURIComponent(instance)}`, { method: 'DELETE', headers }).catch(() => null);
}

async function wahaState(config: ProviderConfig, instance: string): Promise<string> {
  const result = await requestJson(
    `${normalizeBaseUrl(config.baseUrl)}/api/sessions/${encodeURIComponent(instance)}`,
    { headers: { 'X-Api-Key': config.credential, Accept: 'application/json' } },
  );
  if (result.response.status === 404) return 'missing';
  if (!result.response.ok) return 'unknown';
  return normalizeState(result.body.status ?? result.body.state);
}

async function wahaStart(config: ProviderConfig, instance: string, webhookSecret: string) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const headers = {
    'X-Api-Key': config.credential,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const sessionConfig = {
    name: instance,
    start: true,
    config: {
      client: { deviceName: 'SocialPilot', browserName: 'Chrome' },
      ignore: { status: true, groups: true, channels: true },
      webhooks: [{
        url: `${supabaseUrl}/functions/v1/whatsapp-waha-webhook`,
        events: ['message', 'message.ack', 'session.status'],
        hmac: { key: webhookSecret },
        customHeaders: [{ name: 'x-socialpilot-secret', value: webhookSecret }],
        retries: { policy: 'exponential', delaySeconds: 2, attempts: 8 },
      }],
    },
  };

  let state = await wahaState(config, instance);
  if (state === 'missing' || state === 'unknown') {
    let created = await requestJson(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sessionConfig),
    });
    if (!created.response.ok && [400, 409, 422].includes(created.response.status)) {
      created = await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(sessionConfig),
      });
    }
    if (!created.response.ok && created.response.status !== 409) {
      throw new Error(String(created.body.message ?? created.body.error ?? `WAHA create HTTP ${created.response.status}`));
    }
  }

  const started = await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}/start`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  if (!started.response.ok && ![409, 422].includes(started.response.status)) {
    throw new Error(String(started.body.message ?? started.body.error ?? `WAHA start HTTP ${started.response.status}`));
  }

  state = await wahaState(config, instance);
  if (connectedState('waha', state)) {
    return { state, qrBase64: null, qrCode: null, pairingCode: null, sessionToken: null as string | null };
  }

  const qrResponse = await fetch(`${baseUrl}/api/${encodeURIComponent(instance)}/auth/qr`, {
    headers: { 'X-Api-Key': config.credential, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });

  let qrBase64: string | null = null;
  let qrCode: string | null = null;
  if (qrResponse.ok) {
    const contentType = qrResponse.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await qrResponse.json().catch(() => ({})) as Record<string, unknown>;
      const qr = qrFrom(body);
      qrBase64 = qr.qrBase64;
      qrCode = qr.qrCode;
      if (!qrBase64 && typeof body.data === 'string') qrBase64 = body.data;
    } else {
      const bytes = new Uint8Array(await qrResponse.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
      }
      qrBase64 = `data:${contentType || 'image/png'};base64,${btoa(binary)}`;
    }
  }

  return { state, qrBase64, qrCode, pairingCode: null, sessionToken: null as string | null };
}

async function wahaDisconnect(config: ProviderConfig, instance: string): Promise<void> {
  const headers = { 'X-Api-Key': config.credential, Accept: 'application/json' };
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}/logout`, { method: 'POST', headers }).catch(() => null);
  await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}`, { method: 'DELETE', headers }).catch(() => null);
}

function wppBearer(body: Record<string, unknown>): string | null {
  if (typeof body.token === 'string') return body.token;
  if (typeof body.full === 'string') return body.full.replace(/^wppconnect:/, '');
  return null;
}

async function wppGenerateToken(config: ProviderConfig, instance: string): Promise<string> {
  const result = await requestJson(
    `${normalizeBaseUrl(config.baseUrl)}/api/${encodeURIComponent(instance)}/${encodeURIComponent(config.credential)}/generate-token`,
    { method: 'POST', headers: { Accept: 'application/json' } },
  );
  const token = wppBearer(result.body);
  if (!result.response.ok || !token) {
    throw new Error(String(result.body.message ?? result.body.error ?? `WPPConnect token HTTP ${result.response.status}`));
  }
  return token;
}

async function wppRequest(
  config: ProviderConfig,
  instance: string,
  path: string,
  token: string,
  init: RequestInit = {},
) {
  return requestJson(`${normalizeBaseUrl(config.baseUrl)}/api/${encodeURIComponent(instance)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function wppState(config: ProviderConfig, instance: string, token: string): Promise<string> {
  const result = await wppRequest(config, instance, '/check-connection-session', token);
  if (!result.response.ok) return result.response.status === 404 ? 'missing' : 'unknown';
  return normalizeState(result.body.status ?? result.body.message ?? result.body.state ?? result.body.response);
}

async function wppStart(config: ProviderConfig, instance: string, webhookSecret: string) {
  const token = await wppGenerateToken(config, instance);
  const webhook = `${supabaseUrl}/functions/v1/whatsapp-wppconnect-webhook?secret=${encodeURIComponent(webhookSecret)}&session=${encodeURIComponent(instance)}`;
  const started = await wppRequest(config, instance, '/start-session', token, {
    method: 'POST',
    body: JSON.stringify({ webhook, waitQrCode: true }),
  });
  if (!started.response.ok && started.response.status !== 409) {
    throw new Error(String(started.body.message ?? started.body.error ?? `WPPConnect start HTTP ${started.response.status}`));
  }

  const state = await wppState(config, instance, token);
  let qr = qrFrom(started.body);
  if (!connectedState('wppconnect', state) && !qr.qrBase64 && !qr.qrCode) {
    const qrResult = await wppRequest(config, instance, '/qrcode-session', token);
    if (qrResult.response.ok) qr = qrFrom(qrResult.body);
  }
  return { state, ...qr, sessionToken: token };
}

async function wppDisconnect(config: ProviderConfig, instance: string, token?: string | null): Promise<void> {
  const bearer = token && token !== 'provider-session' ? token : await wppGenerateToken(config, instance);
  await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/${encodeURIComponent(instance)}/logout-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
  }).catch(() => null);
}

async function startProvider(
  provider: ProviderKey,
  config: ProviderConfig,
  instance: string,
  webhookSecret: string,
) {
  if (provider === 'evolution') return evolutionStart(config, instance, webhookSecret);
  if (provider === 'waha') return wahaStart(config, instance, webhookSecret);
  return wppStart(config, instance, webhookSecret);
}

async function providerState(
  provider: ProviderKey,
  config: ProviderConfig,
  instance: string,
  sessionToken?: string | null,
): Promise<{ state: string; sessionToken?: string | null }> {
  if (provider === 'evolution') return { state: await evolutionState(config, instance) };
  if (provider === 'waha') return { state: await wahaState(config, instance) };
  const token = sessionToken && sessionToken !== 'provider-session'
    ? sessionToken
    : await wppGenerateToken(config, instance);
  return { state: await wppState(config, instance, token), sessionToken: token };
}

async function disconnectProvider(
  provider: ProviderKey,
  config: ProviderConfig,
  instance: string,
  sessionToken?: string | null,
): Promise<void> {
  if (provider === 'evolution') return evolutionDisconnect(config, instance);
  if (provider === 'waha') return wahaDisconnect(config, instance);
  return wppDisconnect(config, instance, sessionToken);
}

async function saveAccount(params: {
  workspaceId: string;
  provider: ProviderKey;
  instance: string;
  webhookSecret: string;
  result: Awaited<ReturnType<typeof startProvider>>;
  previousAccount?: Record<string, unknown> | null;
}) {
  const connected = connectedState(params.provider, params.result.state);
  const previousMetadata = (params.previousAccount?.metadata ?? {}) as Record<string, unknown>;

  const { data: account, error } = await supabase.from('social_accounts').upsert({
    workspace_id: params.workspaceId,
    platform: 'whatsapp',
    external_id: params.instance,
    handle: typeof params.previousAccount?.handle === 'string' ? params.previousAccount.handle : 'WhatsApp Web',
    display_name: typeof params.previousAccount?.display_name === 'string' ? params.previousAccount.display_name : 'WhatsApp',
    status: connected ? 'connected' : 'error',
    needs_reconnect: !connected,
    metadata: {
      ...previousMetadata,
      provider: params.provider,
      provider_label: LABELS[params.provider],
      instance_name: params.instance,
      onboarding_state: connected ? 'ready' : 'scan_qr',
      provider_state: params.result.state,
      provider_switched_at: previousMetadata.provider && previousMetadata.provider !== params.provider
        ? new Date().toISOString()
        : previousMetadata.provider_switched_at ?? null,
    },
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,platform' }).select().single();

  if (error || !account) throw new Error(error?.message ?? 'تعذّر حفظ جلسة WhatsApp');

  await supabase.from('social_account_tokens').upsert({
    account_id: account.id,
    access_token: params.result.sessionToken ?? 'provider-session',
    refresh_token: params.webhookSecret,
    token_type: `whatsapp_${params.provider}`,
    expires_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_id' });

  return account;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await req.json().catch(() => ({})) as {
    action?: Action;
    workspaceId?: string;
    providerKey?: ProviderKey;
  };
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId || !body.action) return json(400, { error: 'workspaceId و action مطلوبين' });

  const auth = await requireAdmin(req, workspaceId);
  if ('response' in auth) return auth.response;

  const bundle = await providerBundle();
  const methods = PROVIDERS.map((provider) => publicMethod(provider, bundle.providers[provider], bundle.activeProvider));

  if (body.action === 'list_methods') {
    return json(200, { methods, activeProvider: bundle.activeProvider });
  }

  let account = await loadAccount(workspaceId);
  const metadata = (account?.metadata ?? {}) as Record<string, unknown>;
  const currentProvider = validProvider(metadata.provider) ? metadata.provider : null;
  const instance = String(metadata.instance_name ?? instanceName(workspaceId));
  const tokens = await loadTokens(account?.id);

  try {
    if (body.action === 'status') {
      if (!account || !currentProvider) {
        return json(200, {
          configured: healthyProviders(bundle).length > 0,
          connected: false,
          state: 'not_created',
          providerKey: null,
          alternatives: healthyProviders(bundle),
        });
      }
      const config = bundle.providers[currentProvider];
      if (!config?.enabled || config.status !== 'connected') {
        return json(200, {
          configured: healthyProviders(bundle).length > 0,
          connected: false,
          state: 'provider_unavailable',
          providerKey: currentProvider,
          providerLabel: LABELS[currentProvider],
          alternatives: healthyProviders(bundle, currentProvider),
        });
      }

      const statusResult = await providerState(currentProvider, config, instance, tokens.accessToken);
      if (statusResult.sessionToken && statusResult.sessionToken !== tokens.accessToken && account?.id) {
        await supabase.from('social_account_tokens').update({
          access_token: statusResult.sessionToken,
          updated_at: new Date().toISOString(),
        }).eq('account_id', account.id);
      }
      const connected = connectedState(currentProvider, statusResult.state);
      const { data: updated } = await supabase.from('social_accounts').update({
        status: connected ? 'connected' : 'error',
        needs_reconnect: !connected,
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          provider_state: statusResult.state,
          onboarding_state: connected ? 'ready' : 'scan_qr',
        },
      }).eq('id', account.id).select().single();
      if (updated) account = updated;

      return json(200, {
        configured: true,
        connected,
        state: statusResult.state,
        providerKey: currentProvider,
        providerLabel: LABELS[currentProvider],
        account,
        alternatives: healthyProviders(bundle, currentProvider),
      });
    }

    if (body.action === 'disconnect') {
      if (account && currentProvider) {
        const config = bundle.providers[currentProvider];
        if (config) {
          await disconnectProvider(currentProvider, config, instance, tokens.accessToken).catch(() => undefined);
        }
        await supabase.from('social_accounts').delete().eq('id', account.id).eq('workspace_id', workspaceId);
      }
      return json(200, {
        ok: true,
        configured: healthyProviders(bundle).length > 0,
        connected: false,
        state: 'disconnected',
        providerKey: currentProvider,
        alternatives: healthyProviders(bundle, currentProvider),
      });
    }

    let candidates: ProviderKey[];
    if (body.action === 'switch') {
      if (account && currentProvider) {
        const currentConfig = bundle.providers[currentProvider];
        if (currentConfig) {
          await disconnectProvider(currentProvider, currentConfig, instance, tokens.accessToken).catch(() => undefined);
        }
      }
      candidates = body.providerKey && validProvider(body.providerKey)
        ? [body.providerKey]
        : healthyProviders(bundle, currentProvider);
    } else {
      if (account?.status === 'connected' && currentProvider && !body.providerKey) {
        const config = bundle.providers[currentProvider];
        if (config) {
          const statusResult = await providerState(currentProvider, config, instance, tokens.accessToken);
          if (connectedState(currentProvider, statusResult.state)) {
            return json(200, {
              ok: true,
              configured: true,
              connected: true,
              state: statusResult.state,
              providerKey: currentProvider,
              providerLabel: LABELS[currentProvider],
              accountId: account.id,
              alternatives: healthyProviders(bundle, currentProvider),
            });
          }
        }
      }

      candidates = body.providerKey && validProvider(body.providerKey)
        ? [body.providerKey]
        : currentProvider && bundle.providers[currentProvider]?.enabled && bundle.providers[currentProvider]?.status === 'connected'
          ? [currentProvider, ...healthyProviders(bundle, currentProvider)]
          : healthyProviders(bundle);
    }

    candidates = candidates.filter((provider, index) => candidates.indexOf(provider) === index);
    if (candidates.length === 0) {
      return json(409, { error: 'لا يوجد WhatsApp Provider سليم ومفعّل', attempts: [], methods });
    }

    if (body.providerKey && account?.status === 'connected' && currentProvider && body.providerKey !== currentProvider && body.action !== 'switch') {
      return json(409, {
        error: `WhatsApp متصل عبر ${LABELS[currentProvider]}. استخدم التحويل المنظم لمزود آخر بدل تشغيل جلستين لنفس الرقم.`,
        currentProvider,
        alternatives: healthyProviders(bundle, currentProvider),
      });
    }

    const webhookSecret = body.action === 'switch' || !tokens.webhookSecret
      ? randomSecret()
      : tokens.webhookSecret;
    const attempts: Array<{ provider: ProviderKey; ok: boolean; error?: string }> = [];

    for (const provider of candidates) {
      const config = bundle.providers[provider];
      if (!config?.enabled || config.status !== 'connected') {
        attempts.push({ provider, ok: false, error: 'provider_not_healthy' });
        continue;
      }

      try {
        const result = await startProvider(provider, config, instance, webhookSecret);
        account = await saveAccount({
          workspaceId,
          provider,
          instance,
          webhookSecret,
          result,
          previousAccount: account,
        });
        attempts.push({ provider, ok: true });

        return json(200, {
          ok: true,
          configured: true,
          connected: connectedState(provider, result.state),
          state: result.state,
          providerKey: provider,
          providerLabel: LABELS[provider],
          qrBase64: result.qrBase64,
          qrCode: result.qrCode,
          pairingCode: result.pairingCode,
          accountId: account.id,
          attempts,
          alternatives: healthyProviders(bundle, provider),
        });
      } catch (error) {
        attempts.push({
          provider,
          ok: false,
          error: error instanceof Error ? error.message : 'provider_start_failed',
        });
      }
    }

    return json(502, {
      error: 'فشلت كل طرق ربط WhatsApp المتاحة',
      attempts,
      alternatives: healthyProviders(bundle),
    });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'تعذّر تشغيل WhatsApp Provider Router' });
  }
});
