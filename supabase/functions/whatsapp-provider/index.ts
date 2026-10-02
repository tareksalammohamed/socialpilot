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

type ProviderRuntime = {
  providerKey: ProviderKey;
  displayName: string;
  baseUrl: string;
  secret: string;
  enabled: boolean;
  priority: number;
  status: 'not_configured' | 'connected' | 'error';
  lastError: string | null;
};

type StartResult = {
  state: string;
  qrBase64: string | null;
  qrCode: string | null;
  pairingCode: string | null;
  sessionToken: string | null;
};

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

function normalizeState(value: unknown): string {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/\s+/g, '_');
}

function connectedState(provider: ProviderKey, state: string): boolean {
  if (provider === 'evolution') return ['open', 'connected'].includes(state);
  if (provider === 'waha') return ['working', 'connected', 'authenticated'].includes(state);
  return ['connected', 'islogged', 'logged', 'open', 'inchat', 'ischat'].includes(state.replace(/\s+/g, ''));
}

function instanceName(workspaceId: string): string {
  return `socialpilot_${workspaceId.replace(/-/g, '')}`;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requireAdmin(req: Request, workspaceId: string): Promise<{ userId: string } | { response: Response }> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return { response: json(401, { error: 'Unauthorized' }) };
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth.user) return { response: json(401, { error: 'Unauthorized' }) };

  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (!member || !['owner', 'admin'].includes(String(member.role))) {
    return { response: json(403, { error: 'ربط WhatsApp متاح لمالك أو Admin مساحة العمل فقط' }) };
  }
  return { userId: auth.user.id };
}

async function providerRuntimes(): Promise<ProviderRuntime[]> {
  const [{ data: configs, error }, { data: secrets }] = await Promise.all([
    supabase
      .from('whatsapp_provider_configs')
      .select('provider_key,display_name,base_url,enabled,priority,status,last_error')
      .order('priority')
      .order('provider_key'),
    supabase
      .from('whatsapp_provider_secrets')
      .select('provider_key,primary_secret'),
  ]);
  if (error) throw error;

  const secretMap = new Map((secrets ?? []).map((row) => [String(row.provider_key), String(row.primary_secret)]));
  return (configs ?? [])
    .filter((row) => validProvider(row.provider_key))
    .map((row) => ({
      providerKey: row.provider_key as ProviderKey,
      displayName: String(row.display_name ?? LABELS[row.provider_key as ProviderKey]),
      baseUrl: row.base_url ? normalizeBaseUrl(String(row.base_url)) : '',
      secret: secretMap.get(String(row.provider_key)) ?? '',
      enabled: Boolean(row.enabled),
      priority: Number(row.priority ?? 999),
      status: row.status as ProviderRuntime['status'],
      lastError: typeof row.last_error === 'string' ? row.last_error : null,
    }));
}

function healthyProviders(runtimes: ProviderRuntime[], exclude?: ProviderKey | null): ProviderRuntime[] {
  return runtimes
    .filter((runtime) => runtime.providerKey !== exclude)
    .filter((runtime) => runtime.enabled && runtime.status === 'connected' && runtime.baseUrl && runtime.secret)
    .sort((a, b) => a.priority - b.priority || a.providerKey.localeCompare(b.providerKey));
}

function publicMethod(runtime: ProviderRuntime, activeProvider: ProviderKey | null) {
  return {
    providerKey: runtime.providerKey,
    displayName: runtime.displayName,
    priority: runtime.priority,
    status: runtime.status,
    lastError: runtime.lastError,
    available: Boolean(runtime.enabled && runtime.status === 'connected' && runtime.baseUrl && runtime.secret),
    active: activeProvider === runtime.providerKey,
  };
}

async function loadAccount(workspaceId: string) {
  const { data } = await supabase
    .from('social_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'whatsapp')
    .maybeSingle();
  return data;
}

async function loadTokens(accountId?: string | null): Promise<{ accessToken: string | null; webhookSecret: string | null }> {
  if (!accountId) return { accessToken: null, webhookSecret: null };
  const { data } = await supabase
    .from('social_account_tokens')
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

async function evolutionState(runtime: ProviderRuntime, instance: string): Promise<string> {
  let result = await requestJson(
    `${runtime.baseUrl}/instance/connectionState/${encodeURIComponent(instance)}`,
    { headers: { apikey: runtime.secret } },
  );
  if (result.response.ok) {
    const nested = result.body.instance as Record<string, unknown> | undefined;
    return normalizeState(nested?.state ?? result.body.state);
  }
  result = await requestJson(
    `${runtime.baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
    { headers: { apikey: runtime.secret } },
  );
  if (!result.response.ok) return 'missing';
  const rows = Array.isArray(result.body) ? result.body : ((result.body.instances as unknown[]) ?? []);
  const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  return normalizeState(row?.connectionStatus ?? row?.connectionState ?? row?.state);
}

async function evolutionStart(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<StartResult> {
  let state = await evolutionState(runtime, instance);
  if (state === 'missing' || state === 'unknown') {
    const created = await requestJson(`${runtime.baseUrl}/instance/create`, {
      method: 'POST',
      headers: { apikey: runtime.secret, 'Content-Type': 'application/json' },
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
      url: `${supabaseUrl}/functions/v1/whatsapp-provider-webhook?provider=evolution`,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['QRCODE_UPDATED','CONNECTION_UPDATE','MESSAGES_UPSERT','MESSAGES_UPDATE','SEND_MESSAGE','SEND_MESSAGE_UPDATE'],
      headers: { 'x-socialpilot-secret': webhookSecret },
    },
  };
  let hook = await requestJson(`${runtime.baseUrl}/webhook/set/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: { apikey: runtime.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload),
  });
  if (hook.response.status === 404) {
    hook = await requestJson(`${runtime.baseUrl}/event/webhook/set/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: runtime.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });
  }
  if (!hook.response.ok) throw new Error(`Evolution webhook HTTP ${hook.response.status}`);

  let connect = await requestJson(`${runtime.baseUrl}/instance/connect/${encodeURIComponent(instance)}`, {
    headers: { apikey: runtime.secret, Accept: 'application/json' },
  });
  if (!connect.response.ok && connect.response.status !== 409) {
    connect = await requestJson(`${runtime.baseUrl}/instance/connect/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: runtime.secret, Accept: 'application/json' },
    });
  }
  if (!connect.response.ok && connect.response.status !== 409) {
    throw new Error(String(connect.body.message ?? connect.body.error ?? `Evolution connect HTTP ${connect.response.status}`));
  }

  state = await evolutionState(runtime, instance);
  return { state, ...qrFrom(connect.body), sessionToken: null };
}

async function evolutionDisconnect(runtime: ProviderRuntime, instance: string): Promise<void> {
  const headers = { apikey: runtime.secret };
  await fetch(`${runtime.baseUrl}/instance/logout/${encodeURIComponent(instance)}`, { method: 'DELETE', headers }).catch(() => null);
  await fetch(`${runtime.baseUrl}/instance/delete/${encodeURIComponent(instance)}`, { method: 'DELETE', headers }).catch(() => null);
}

async function wahaState(runtime: ProviderRuntime, instance: string): Promise<string> {
  const result = await requestJson(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
    headers: { 'X-Api-Key': runtime.secret, Accept: 'application/json' },
  });
  if (result.response.status === 404) return 'missing';
  if (!result.response.ok) return 'unknown';
  return normalizeState(result.body.status ?? result.body.state);
}

async function wahaStart(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<StartResult> {
  const sessionConfig = {
    name: instance,
    start: true,
    config: {
      client: { deviceName: 'SocialPilot', browserName: 'Chrome' },
      ignore: { status: true, groups: true, channels: true },
      webhooks: [{
        url: `${supabaseUrl}/functions/v1/whatsapp-provider-webhook?provider=waha`,
        events: ['message', 'message.ack', 'session.status'],
        hmac: { key: webhookSecret },
        customHeaders: [{ name: 'x-socialpilot-secret', value: webhookSecret }],
        retries: { policy: 'exponential', delaySeconds: 2, attempts: 8 },
      }],
    },
  };

  let state = await wahaState(runtime, instance);
  if (state === 'missing' || state === 'unknown') {
    let created = await requestJson(`${runtime.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'X-Api-Key': runtime.secret, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(sessionConfig),
    });
    if (!created.response.ok && [400, 409, 422].includes(created.response.status)) {
      created = await requestJson(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
        method: 'PUT',
        headers: { 'X-Api-Key': runtime.secret, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(sessionConfig),
      });
    }
    if (!created.response.ok && created.response.status !== 409) {
      throw new Error(String(created.body.message ?? created.body.error ?? `WAHA create HTTP ${created.response.status}`));
    }
  }

  const started = await requestJson(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}/start`, {
    method: 'POST',
    headers: { 'X-Api-Key': runtime.secret, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  if (!started.response.ok && ![409, 422].includes(started.response.status)) {
    throw new Error(String(started.body.message ?? started.body.error ?? `WAHA start HTTP ${started.response.status}`));
  }

  state = await wahaState(runtime, instance);
  if (connectedState('waha', state)) {
    return { state, qrBase64: null, qrCode: null, pairingCode: null, sessionToken: null };
  }

  const qrResponse = await fetch(`${runtime.baseUrl}/api/${encodeURIComponent(instance)}/auth/qr`, {
    headers: { 'X-Api-Key': runtime.secret, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });

  let qrBase64: string | null = null;
  let qrCode: string | null = null;
  if (qrResponse.ok) {
    const contentType = qrResponse.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await qrResponse.json().catch(() => ({})) as Record<string, unknown>;
      const qr = qrFrom(body);
      qrBase64 = qr.qrBase64 ?? (typeof body.data === 'string' ? body.data : null);
      qrCode = qr.qrCode;
    } else {
      const bytes = new Uint8Array(await qrResponse.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
      }
      qrBase64 = `data:${contentType || 'image/png'};base64,${btoa(binary)}`;
    }
  }

  return { state, qrBase64, qrCode, pairingCode: null, sessionToken: null };
}

async function wahaDisconnect(runtime: ProviderRuntime, instance: string): Promise<void> {
  const headers = { 'X-Api-Key': runtime.secret, Accept: 'application/json' };
  await fetch(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}/logout`, { method: 'POST', headers }).catch(() => null);
  await fetch(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}`, { method: 'DELETE', headers }).catch(() => null);
}

async function wppGenerateToken(runtime: ProviderRuntime, instance: string): Promise<string> {
  const result = await requestJson(
    `${runtime.baseUrl}/api/${encodeURIComponent(instance)}/${encodeURIComponent(runtime.secret)}/generate-token`,
    { method: 'POST', headers: { Accept: 'application/json' } },
  );
  const token = typeof result.body.token === 'string'
    ? result.body.token
    : typeof result.body.full === 'string'
      ? result.body.full
      : null;
  if (!result.response.ok || !token) {
    throw new Error(String(result.body.message ?? result.body.error ?? `WPPConnect token HTTP ${result.response.status}`));
  }
  return token;
}

async function wppRequest(
  runtime: ProviderRuntime,
  instance: string,
  path: string,
  token: string,
  init: RequestInit = {},
) {
  return requestJson(`${runtime.baseUrl}/api/${encodeURIComponent(instance)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function wppState(runtime: ProviderRuntime, instance: string, token: string): Promise<string> {
  const result = await wppRequest(runtime, instance, '/check-connection-session', token);
  if (!result.response.ok) return result.response.status === 404 ? 'missing' : 'unknown';
  return normalizeState(result.body.status ?? result.body.message ?? result.body.state ?? result.body.response);
}

async function wppStart(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<StartResult> {
  const token = await wppGenerateToken(runtime, instance);
  const webhook = `${supabaseUrl}/functions/v1/whatsapp-provider-webhook?provider=wppconnect&secret=${encodeURIComponent(webhookSecret)}`;
  const started = await wppRequest(runtime, instance, '/start-session', token, {
    method: 'POST',
    body: JSON.stringify({ webhook, waitQrCode: true }),
  });
  if (!started.response.ok && started.response.status !== 409) {
    throw new Error(String(started.body.message ?? started.body.error ?? `WPPConnect start HTTP ${started.response.status}`));
  }

  const state = await wppState(runtime, instance, token);
  let qr = qrFrom(started.body);
  if (!connectedState('wppconnect', state) && !qr.qrBase64 && !qr.qrCode) {
    const qrResult = await wppRequest(runtime, instance, '/qrcode-session', token);
    if (qrResult.response.ok) qr = qrFrom(qrResult.body);
  }
  return { state, ...qr, sessionToken: token };
}

async function wppDisconnect(runtime: ProviderRuntime, instance: string, token?: string | null): Promise<void> {
  const bearer = token && !token.endsWith('-provider') && token !== 'provider-session'
    ? token
    : await wppGenerateToken(runtime, instance);
  await fetch(`${runtime.baseUrl}/api/${encodeURIComponent(instance)}/logout-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
  }).catch(() => null);
}

async function providerState(
  runtime: ProviderRuntime,
  instance: string,
  sessionToken?: string | null,
): Promise<{ state: string; sessionToken?: string | null }> {
  if (runtime.providerKey === 'evolution') return { state: await evolutionState(runtime, instance) };
  if (runtime.providerKey === 'waha') return { state: await wahaState(runtime, instance) };
  const token = sessionToken && !sessionToken.endsWith('-provider') && sessionToken !== 'provider-session'
    ? sessionToken
    : await wppGenerateToken(runtime, instance);
  return { state: await wppState(runtime, instance, token), sessionToken: token };
}

async function startProvider(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<StartResult> {
  if (runtime.providerKey === 'evolution') return evolutionStart(runtime, instance, webhookSecret);
  if (runtime.providerKey === 'waha') return wahaStart(runtime, instance, webhookSecret);
  return wppStart(runtime, instance, webhookSecret);
}

async function disconnectProvider(
  runtime: ProviderRuntime,
  instance: string,
  sessionToken?: string | null,
): Promise<void> {
  if (runtime.providerKey === 'evolution') return evolutionDisconnect(runtime, instance);
  if (runtime.providerKey === 'waha') return wahaDisconnect(runtime, instance);
  return wppDisconnect(runtime, instance, sessionToken);
}

async function saveAccount(params: {
  workspaceId: string;
  runtime: ProviderRuntime;
  instance: string;
  webhookSecret: string;
  result: StartResult;
  previousAccount?: Record<string, unknown> | null;
}) {
  const connected = connectedState(params.runtime.providerKey, params.result.state);
  const previousMetadata = (params.previousAccount?.metadata ?? {}) as Record<string, unknown>;
  const { data: account, error } = await supabase
    .from('social_accounts')
    .upsert({
      workspace_id: params.workspaceId,
      platform: 'whatsapp',
      external_id: params.instance,
      handle: typeof params.previousAccount?.handle === 'string' ? params.previousAccount.handle : 'WhatsApp Web',
      display_name: typeof params.previousAccount?.display_name === 'string' ? params.previousAccount.display_name : 'WhatsApp',
      status: connected ? 'connected' : 'error',
      needs_reconnect: !connected,
      metadata: {
        ...previousMetadata,
        provider: params.runtime.providerKey,
        provider_label: params.runtime.displayName,
        instance_name: params.instance,
        onboarding_state: connected ? 'ready' : 'scan_qr',
        provider_state: params.result.state,
        provider_switched_at: previousMetadata.provider && previousMetadata.provider !== params.runtime.providerKey
          ? new Date().toISOString()
          : previousMetadata.provider_switched_at ?? null,
      },
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,platform' })
    .select()
    .single();
  if (error || !account) throw new Error(error?.message ?? 'تعذّر حفظ جلسة WhatsApp');

  await supabase.from('social_account_tokens').upsert({
    account_id: account.id,
    access_token: params.result.sessionToken ?? `${params.runtime.providerKey}-provider`,
    refresh_token: params.webhookSecret,
    token_type: `whatsapp_${params.runtime.providerKey}`,
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

  const runtimes = await providerRuntimes();
  let account = await loadAccount(workspaceId);
  const metadata = (account?.metadata ?? {}) as Record<string, unknown>;
  const currentProvider = validProvider(metadata.provider) ? metadata.provider : null;
  const methods = runtimes.map((runtime) => publicMethod(runtime, currentProvider));

  if (body.action === 'list_methods') {
    return json(200, { methods, activeProvider: currentProvider });
  }

  const instance = String(metadata.instance_name ?? instanceName(workspaceId));
  const tokens = await loadTokens(account?.id);

  try {
    if (body.action === 'status') {
      if (!account || !currentProvider) {
        return json(200, {
          configured: healthyProviders(runtimes).length > 0,
          connected: false,
          state: 'not_created',
          providerKey: null,
          providerLabel: null,
          alternatives: healthyProviders(runtimes).map((runtime) => runtime.providerKey),
        });
      }
      const runtime = runtimes.find((row) => row.providerKey === currentProvider);
      if (!runtime || !runtime.enabled || runtime.status !== 'connected') {
        return json(200, {
          configured: healthyProviders(runtimes).length > 0,
          connected: false,
          state: 'provider_unavailable',
          providerKey: currentProvider,
          providerLabel: LABELS[currentProvider],
          alternatives: healthyProviders(runtimes, currentProvider).map((row) => row.providerKey),
        });
      }

      const statusResult = await providerState(runtime, instance, tokens.accessToken);
      if (statusResult.sessionToken && statusResult.sessionToken !== tokens.accessToken && account.id) {
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
        providerLabel: runtime.displayName,
        account,
        alternatives: healthyProviders(runtimes, currentProvider).map((row) => row.providerKey),
      });
    }

    if (body.action === 'disconnect') {
      if (account && currentProvider) {
        const runtime = runtimes.find((row) => row.providerKey === currentProvider);
        if (runtime) {
          await disconnectProvider(runtime, instance, tokens.accessToken).catch(() => undefined);
        }
        await supabase.from('social_accounts').delete().eq('id', account.id).eq('workspace_id', workspaceId);
      }
      return json(200, {
        ok: true,
        configured: healthyProviders(runtimes).length > 0,
        connected: false,
        state: 'disconnected',
        providerKey: currentProvider,
        providerLabel: currentProvider ? LABELS[currentProvider] : null,
        alternatives: healthyProviders(runtimes, currentProvider).map((row) => row.providerKey),
      });
    }

    if (
      body.providerKey
      && account?.status === 'connected'
      && currentProvider
      && body.providerKey !== currentProvider
      && body.action !== 'switch'
    ) {
      return json(409, {
        error: `WhatsApp متصل عبر ${LABELS[currentProvider]}. افصل الجلسة أولًا أو استخدم التحويل المنظم.`,
        currentProvider,
        alternatives: healthyProviders(runtimes, currentProvider).map((row) => row.providerKey),
      });
    }

    if (body.action === 'switch' && account && currentProvider) {
      const runtime = runtimes.find((row) => row.providerKey === currentProvider);
      if (runtime) {
        await disconnectProvider(runtime, instance, tokens.accessToken).catch(() => undefined);
      }
    }

    let candidates: ProviderRuntime[];
    if (body.providerKey && validProvider(body.providerKey)) {
      candidates = runtimes.filter((runtime) => runtime.providerKey === body.providerKey);
    } else if (body.action === 'switch') {
      candidates = healthyProviders(runtimes, currentProvider);
    } else {
      const currentHealthy = currentProvider
        ? runtimes.find((runtime) => runtime.providerKey === currentProvider && runtime.enabled && runtime.status === 'connected')
        : null;
      candidates = currentHealthy
        ? [currentHealthy, ...healthyProviders(runtimes, currentProvider)]
        : healthyProviders(runtimes);
    }

    if (candidates.length === 0) {
      return json(409, { error: 'لا يوجد WhatsApp Provider سليم ومفعّل', attempts: [], methods });
    }

    const webhookSecret = body.action === 'switch' || !tokens.webhookSecret
      ? randomSecret()
      : tokens.webhookSecret;
    const attempts: Array<{ provider: ProviderKey; ok: boolean; error?: string }> = [];

    for (const runtime of candidates) {
      if (!runtime.enabled || runtime.status !== 'connected' || !runtime.baseUrl || !runtime.secret) {
        attempts.push({ provider: runtime.providerKey, ok: false, error: 'provider_not_healthy' });
        continue;
      }

      try {
        const result = await startProvider(runtime, instance, webhookSecret);
        account = await saveAccount({
          workspaceId,
          runtime,
          instance,
          webhookSecret,
          result,
          previousAccount: account,
        });
        attempts.push({ provider: runtime.providerKey, ok: true });

        return json(200, {
          ok: true,
          configured: true,
          connected: connectedState(runtime.providerKey, result.state),
          state: result.state,
          providerKey: runtime.providerKey,
          providerLabel: runtime.displayName,
          qrBase64: result.qrBase64,
          qrCode: result.qrCode,
          pairingCode: result.pairingCode,
          accountId: account.id,
          attempts,
          alternatives: healthyProviders(runtimes, runtime.providerKey).map((row) => row.providerKey),
        });
      } catch (error) {
        attempts.push({
          provider: runtime.providerKey,
          ok: false,
          error: error instanceof Error ? error.message : 'provider_start_failed',
        });
        // Best-effort cleanup before trying the next provider.
        await disconnectProvider(runtime, instance, tokens.accessToken).catch(() => undefined);
      }
    }

    return json(502, {
      error: 'فشلت كل طرق ربط WhatsApp المتاحة',
      attempts,
      alternatives: healthyProviders(runtimes).map((row) => row.providerKey),
    });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'تعذّر تشغيل WhatsApp Provider Router' });
  }
});
