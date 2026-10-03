import { applySessionState, closeSession, isWahaConnected, isWppConnected, wppConnectionState } from './whatsapp-session.ts';
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
  preferred: boolean;
};

type StartResult = {
  state: string;
  qrBase64: string | null;
  qrCode: string | null;
  pairingCode: string | null;
  sessionToken: string | null;
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

function normalizeState(value: unknown): string {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/\s+/g, '_');
}

function connectedState(provider: ProviderKey, state: string): boolean {
  if (provider === 'evolution') return ['open', 'connected'].includes(state);
  if (provider === 'waha') return isWahaConnected(state);
  return isWppConnected(state);
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
  const [appResult, secretResult] = await Promise.all([
    supabase.from('social_platform_apps')
      .select('app_id,enabled,has_secret')
      .eq('platform_key', 'whatsapp')
      .maybeSingle(),
    supabase.from('social_platform_app_secrets')
      .select('app_secret')
      .eq('platform_key', 'whatsapp')
      .maybeSingle(),
  ]);

  if (appResult.error || secretResult.error) throw new Error('تعذّر قراءة إعدادات WhatsApp');
  const app = appResult.data;
  const secretRow = secretResult.data;
  const raw = typeof secretRow?.app_secret === 'string' ? secretRow.app_secret.trim() : '';
  const defaults: Record<ProviderKey, number> = { evolution: 10, waha: 20, wppconnect: 30 };
  const runtimes = PROVIDERS.map((providerKey) => ({
    providerKey,
    displayName: LABELS[providerKey],
    baseUrl: '',
    secret: '',
    enabled: false,
    priority: defaults[providerKey],
    status: 'not_configured' as ProviderRuntime['status'],
    lastError: null as string | null,
    preferred: false,
  }));

  if (raw.startsWith('{')) {
    try {
      const bundle = JSON.parse(raw) as {
        version?: number;
        activeProvider?: ProviderKey | null;
        providers?: Partial<Record<ProviderKey, {
          baseUrl?: string;
          credential?: string;
          enabled?: boolean;
          priority?: number;
          status?: ProviderRuntime['status'];
          lastError?: string | null;
        }>>;
      };
      for (const runtime of runtimes) {
        const config = bundle.providers?.[runtime.providerKey];
        if (!config) continue;
        runtime.baseUrl = config.baseUrl ? normalizeBaseUrl(config.baseUrl) : '';
        runtime.secret = config.credential ?? '';
        runtime.enabled = config.enabled === true;
        runtime.priority = Number(config.priority ?? runtime.priority);
        runtime.status = config.status ?? 'not_configured';
        runtime.lastError = config.lastError ?? null;
        runtime.preferred = bundle.activeProvider === runtime.providerKey;
      }
      return runtimes.sort((a, b) =>
        Number(b.preferred) - Number(a.preferred)
        || a.priority - b.priority
        || a.providerKey.localeCompare(b.providerKey)
      );
    } catch {
      throw new Error('WhatsApp provider registry is invalid JSON');
    }
  }

  // Backward compatibility for the single-provider Evolution setup.
  if (raw && typeof app?.app_id === 'string' && /^https?:\/\//i.test(app.app_id)) {
    const evolution = runtimes.find((runtime) => runtime.providerKey === 'evolution');
    if (evolution) {
      evolution.baseUrl = normalizeBaseUrl(app.app_id);
      evolution.secret = raw;
      evolution.enabled = Boolean(app.enabled);
      evolution.status = app.enabled ? 'connected' : 'error';
      evolution.preferred = true;
    }
  }

  return runtimes;
}

function healthyProviders(runtimes: ProviderRuntime[], exclude?: ProviderKey | null): ProviderRuntime[] {
  return runtimes
    .filter((runtime) => runtime.providerKey !== exclude)
    .filter((runtime) => runtime.enabled && runtime.status === 'connected' && runtime.baseUrl && runtime.secret)
    .sort((a, b) =>
      Number(b.preferred) - Number(a.preferred)
      || a.priority - b.priority
      || a.providerKey.localeCompare(b.providerKey)
    );
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
  const { data, error } = await supabase
    .from('social_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'whatsapp')
    .maybeSingle();
  if (error) throw new Error('تعذّر قراءة حساب WhatsApp');
  return data;
}

async function loadTokens(accountId?: string | null): Promise<{ accessToken: string | null; webhookSecret: string | null }> {
  if (!accountId) return { accessToken: null, webhookSecret: null };
  const { data, error } = await supabase
    .from('social_account_tokens')
    .select('access_token,refresh_token')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error('تعذّر قراءة بيانات جلسة WhatsApp');
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
  if (!result.response.ok) {
    if (result.response.status === 404) return 'missing';
    throw new Error(`Evolution state HTTP ${result.response.status}`);
  }
  const rows = Array.isArray(result.body) ? result.body : ((result.body.instances as unknown[]) ?? []);
  const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  return normalizeState(row?.connectionStatus ?? row?.connectionState ?? row?.state);
}

async function configureEvolutionWebhook(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<void> {
  const webhookPayload = {
    webhook: {
      enabled: true,
      url: `${supabaseUrl}/functions/v1/whatsapp-evolution-webhook`,
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

  await configureEvolutionWebhook(runtime, instance, webhookSecret);

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
  await closeSession(`${runtime.baseUrl}/instance/delete/${encodeURIComponent(instance)}`, { method: 'DELETE', headers });
}

async function wahaState(runtime: ProviderRuntime, instance: string): Promise<string> {
  const result = await requestJson(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
    headers: { 'X-Api-Key': runtime.secret, Accept: 'application/json' },
  });
  if (result.response.status === 404) return 'missing';
  if (!result.response.ok) throw new Error(`WAHA state HTTP ${result.response.status}`);
  return normalizeState(result.body.status ?? result.body.state);
}

function wahaSessionConfig(instance: string, webhookSecret: string) {
  return {
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
}

async function configureWahaWebhook(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<void> {
  const configured = await requestJson(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
    method: 'PUT', headers: { 'X-Api-Key': runtime.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(wahaSessionConfig(instance, webhookSecret)),
  });
  if (!configured.response.ok) throw new Error(`WAHA webhook configuration HTTP ${configured.response.status}`);
}

async function wahaStart(runtime: ProviderRuntime, instance: string, webhookSecret: string): Promise<StartResult> {
  const sessionConfig = wahaSessionConfig(instance, webhookSecret);

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

  if (state !== 'missing' && state !== 'unknown') {
    await configureWahaWebhook(runtime, instance, webhookSecret);
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
  await closeSession(`${runtime.baseUrl}/api/sessions/${encodeURIComponent(instance)}`, { method: 'DELETE', headers });
}

async function wppGenerateToken(runtime: ProviderRuntime, instance: string): Promise<string> {
  const result = await requestJson(
    `${runtime.baseUrl}/api/${encodeURIComponent(instance)}/${encodeURIComponent(runtime.secret)}/generate-token`,
    { method: 'POST', headers: { Accept: 'application/json' } },
  );
  const token = typeof result.body.token === 'string'
    ? result.body.token
    : typeof result.body.full === 'string'
      ? result.body.full.slice(result.body.full.indexOf(':') + 1)
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
  if (!result.response.ok) {
    if (result.response.status === 404) return 'missing';
    throw new Error(`WPPConnect state HTTP ${result.response.status}`);
  }
  return wppConnectionState(result.body);
}

async function providerQr(runtime: ProviderRuntime, instance: string, token: string) {
  const encoded = encodeURIComponent(instance);
  const path = runtime.providerKey === 'wppconnect' ? `/api/${encoded}/qrcode-session`
    : runtime.providerKey === 'waha' ? `/api/${encoded}/auth/qr` : `/instance/connect/${encoded}`;
  const headers: Record<string, string> = runtime.providerKey === 'wppconnect' ? { Authorization: `Bearer ${token}` }
    : runtime.providerKey === 'waha' ? { 'X-Api-Key': runtime.secret } : { apikey: runtime.secret };
  const response = await fetch(`${runtime.baseUrl}${path}`, {
    headers: { ...headers, Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return { qrBase64: null, qrCode: null, pairingCode: null };
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('image/')) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new Error('QR image exceeds size limit');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { qrBase64: `data:${contentType.split(';')[0]};base64,${btoa(binary)}`, qrCode: null, pairingCode: null };
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const qr = qrFrom(body);
  return { ...qr, qrBase64: qr.qrBase64 ?? (typeof body.data === 'string' ? body.data : null) };
}

async function wppStart(runtime: ProviderRuntime, instance: string, webhookSecret: string, token: string): Promise<StartResult> {
  const webhook = `${supabaseUrl}/functions/v1/whatsapp-wppconnect-webhook?session=${encodeURIComponent(instance)}&secret=${encodeURIComponent(webhookSecret)}`;
  const started = await wppRequest(runtime, instance, '/start-session', token, {
    method: 'POST',
    body: JSON.stringify({ webhook, waitQrCode: false }),
  });
  if ((!started.response.ok && started.response.status !== 409) || started.body.status === false) {
    throw new Error(String(started.body.message ?? started.body.error ?? `WPPConnect start HTTP ${started.response.status}`));
  }

  const state = await wppState(runtime, instance, token);
  let qr = qrFrom(started.body);
  if (!connectedState('wppconnect', state) && !qr.qrBase64 && !qr.qrCode) {
    qr = await providerQr(runtime, instance, token);
  }
  return { state, ...qr, sessionToken: token };
}

async function wppDisconnect(runtime: ProviderRuntime, instance: string, token?: string | null): Promise<void> {
  const bearer = token && !token.endsWith('-provider') && token !== 'provider-session'
    ? token
    : await wppGenerateToken(runtime, instance);
  const loggedOut = await wppRequest(runtime, instance, '/logout-session', bearer, { method: 'POST' });
  if (loggedOut.response.status === 404) {
    // WPP returns 404 for an unauthenticated QR browser too. It does not mean
    // the browser has stopped; explicitly close it before allowing a switch.
    await closeSession(`${runtime.baseUrl}/api/${encodeURIComponent(instance)}/close-session`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    }, false);
  } else if (!loggedOut.response.ok || loggedOut.body.status === false) {
    throw new Error(`WPPConnect logout HTTP ${loggedOut.response.status}`);
  }
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

async function startProvider(runtime: ProviderRuntime, instance: string, webhookSecret: string, sessionToken: string): Promise<StartResult> {
  if (runtime.providerKey === 'evolution') return evolutionStart(runtime, instance, webhookSecret);
  if (runtime.providerKey === 'waha') return wahaStart(runtime, instance, webhookSecret);
  return wppStart(runtime, instance, webhookSecret, sessionToken);
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

async function invalidateSession(accountId: string, operationId: string) {
  const { data, error } = await supabase.rpc('whatsapp_invalidate_session', {
    p_account_id: accountId, p_operation_id: operationId,
  });
  if (error || !data) throw new Error('تعذّر حفظ حالة الفصل');
  return data;
}

async function prepareSession(params: {
  workspaceId: string; operationId: string; runtime: ProviderRuntime; instance: string;
  webhookSecret: string; sessionToken: string; previousAccount: Record<string, unknown> | null;
}) {
  const previous = params.previousAccount;
  const metadata = (previous?.metadata ?? {}) as Record<string, unknown>;
  const { state_observed_at: _oldObservation, ...preservedMetadata } = metadata;
  void _oldObservation;
  const { data, error } = await supabase.rpc('whatsapp_save_session', {
    p_workspace_id: params.workspaceId, p_operation_id: params.operationId,
    p_account: {
      external_id: previous?.external_id ?? params.instance,
      handle: previous?.handle ?? 'WhatsApp Web', display_name: previous?.display_name ?? 'WhatsApp',
      status: 'error', needs_reconnect: true,
      metadata: { ...preservedMetadata, provider: params.runtime.providerKey,
        provider_label: params.runtime.displayName, instance_name: params.instance,
        session_active: true, session_generation: params.operationId,
        onboarding_state: 'starting', provider_state: 'starting',
        provider_switched_at: metadata.provider && metadata.provider !== params.runtime.providerKey
          ? new Date().toISOString() : metadata.provider_switched_at ?? null,
      },
    },
    p_tokens: { access_token: params.sessionToken, refresh_token: params.webhookSecret,
      token_type: `whatsapp_${params.runtime.providerKey}` },
  });
  if (error || !data) throw new Error('تعذّر حفظ حساب وبيانات جلسة WhatsApp');
  return data;
}

// Internal account-sync callers already verified workspace membership. This
// argument is never read from a request body or header.
export async function handleWhatsAppProvider(req: Request, expectedProvider?: ProviderKey, authorizedWorkspaceId?: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await req.json().catch(() => null) as {
    action?: Action; workspaceId?: string; providerKey?: ProviderKey;
  } | null;
  if (!body || !['list_methods', 'start', 'status', 'disconnect', 'switch'].includes(String(body.action))
    || (body.providerKey !== undefined && !validProvider(body.providerKey))) {
    return json(400, { error: 'Invalid WhatsApp action or provider' });
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
  if (!workspaceId) return json(400, { error: 'workspaceId مطلوب' });
  if (expectedProvider && body.action === 'switch') return json(400, { error: 'استخدم التحويل المنظم من إعدادات WhatsApp' });
  const operationId = crypto.randomUUID();
  let claimed = false;
  try {
    if (authorizedWorkspaceId !== workspaceId) {
      const auth = await requireAdmin(req, workspaceId);
      if ('response' in auth) return auth.response;
    }
    if (body.action !== 'list_methods') {
      const { data, error } = await supabase.rpc('whatsapp_claim_operation', {
        p_workspace_id: workspaceId, p_operation_id: operationId,
      });
      if (error) throw new Error('تعذّر بدء عملية WhatsApp؛ تحقق من تحديث قاعدة البيانات');
      if (data !== true) return json(409, { error: 'توجد عملية ربط أو فصل قيد التنفيذ؛ انتظر ثم حاول مرة أخرى' });
      claimed = true;
    }
    const runtimes = await providerRuntimes();
    let account = await loadAccount(workspaceId);
    const metadata = (account?.metadata ?? {}) as Record<string, unknown>;
    const currentProvider = validProvider(metadata.provider) ? metadata.provider : null;
    const methods = runtimes.map((runtime) => publicMethod(runtime, currentProvider));
    if (body.action === 'list_methods') return json(200, { methods, activeProvider: currentProvider });
    if (expectedProvider && currentProvider && currentProvider !== expectedProvider) {
      return json(409, { error: 'المسار القديم لا يمكنه تغيير مزود الرقم؛ استخدم التحويل المنظم', currentProvider });
    }
    if (expectedProvider && body.action === 'start') body.providerKey = expectedProvider;
    const instance = String(metadata.instance_name ?? instanceName(workspaceId));
    const tokens = await loadTokens(account?.id);
    const alternatives = (exclude: ProviderKey | null = currentProvider) =>
      healthyProviders(runtimes, exclude).map((runtime) => runtime.providerKey);

    if (body.action === 'status') {
      if (!account || !currentProvider) return json(200, {
        configured: healthyProviders(runtimes).length > 0, connected: false,
        state: 'not_created', providerKey: null, providerLabel: null, alternatives: alternatives(null),
      });
      // An intentional disconnect stays disconnected even if an old callback or
      // an orphaned provider still claims the session is open.
      if (metadata.session_active === false) return json(200, {
        configured: healthyProviders(runtimes).length > 0, connected: false, state: 'disconnected',
        providerKey: currentProvider, providerLabel: LABELS[currentProvider], account, alternatives: alternatives(),
      });
      const runtime = runtimes.find((row) => row.providerKey === currentProvider);
      const observedAt = new Date().toISOString();
      let state = 'provider_unavailable';
      let statusError: string | undefined;
      if (runtime?.enabled && runtime.status === 'connected' && runtime.baseUrl && runtime.secret) {
        try {
          // Preserve account-sync's webhook watchdog under the same operation lease.
          // Avoid changing session configuration on each three-second QR poll.
          if (authorizedWorkspaceId === workspaceId && tokens.webhookSecret) {
            if (currentProvider === 'evolution') await configureEvolutionWebhook(runtime, instance, tokens.webhookSecret);
            if (currentProvider === 'waha') await configureWahaWebhook(runtime, instance, tokens.webhookSecret);
          }
          const result = await providerState(runtime, instance, tokens.accessToken);
          state = result.state;
          if (result.sessionToken && result.sessionToken !== tokens.accessToken) {
            const { error } = await supabase.from('social_account_tokens').update({
              access_token: result.sessionToken, updated_at: new Date().toISOString(),
            }).eq('account_id', account.id);
            if (error) throw new Error('تعذّر حفظ رمز جلسة WhatsApp');
          }
        } catch (error) { statusError = error instanceof Error ? error.message : 'Provider unavailable'; }
      }
      const connected = connectedState(currentProvider, state);
      if (!tokens.webhookSecret) throw new Error('بيانات الجلسة ناقصة؛ أعد ربط WhatsApp');
      const updated = await applySessionState(supabase, account.id, tokens.webhookSecret, {
        status: connected ? 'connected' : 'error', needs_reconnect: !connected,
        metadata: { provider_state: state, onboarding_state: connected ? 'ready' : 'scan_qr' },
      }, observedAt, operationId);
      if (!updated) throw new Error('تغيّرت الجلسة أثناء الفحص؛ أعد المحاولة');
      const qr = updated.status !== 'connected' && runtime?.enabled && runtime.status === 'connected' && !statusError
        ? await providerQr(runtime, instance, tokens.accessToken ?? '') : {};
      return json(200, { configured: healthyProviders(runtimes).length > 0,
        connected: updated.status === 'connected', state: (updated.metadata as Record<string, unknown>).provider_state,
        providerKey: currentProvider, providerLabel: LABELS[currentProvider], account: updated,
        alternatives: alternatives(), ...qr, ...(statusError ? { lastError: statusError } : {}),
      });
    }

    if (body.action === 'disconnect') {
      if (account && currentProvider && metadata.session_active !== false) {
        const runtime = runtimes.find((row) => row.providerKey === currentProvider);
        if (!runtime?.baseUrl || !runtime.secret) throw new Error('بيانات المزود مطلوبة لتأكيد إغلاق الجلسة');
        await disconnectProvider(runtime, instance, tokens.accessToken);
        account = await invalidateSession(account.id, operationId);
      }
      return json(200, { ok: true, configured: healthyProviders(runtimes).length > 0,
        connected: false, state: 'disconnected', accountId: account?.id ?? null,
        providerKey: currentProvider, providerLabel: currentProvider ? LABELS[currentProvider] : null,
        alternatives: alternatives(),
      });
    }

    let candidates: ProviderRuntime[];
    if (body.providerKey) candidates = runtimes.filter((runtime) => runtime.providerKey === body.providerKey);
    else if (body.action === 'switch') candidates = healthyProviders(runtimes, currentProvider);
    else candidates = currentProvider ? healthyProviders(runtimes).filter((runtime) => runtime.providerKey === currentProvider)
      : healthyProviders(runtimes);
    candidates = candidates.filter((runtime) => runtime.enabled && runtime.status === 'connected' && runtime.baseUrl && runtime.secret);
    if (candidates.length === 0) return json(409, { error: 'لا يوجد WhatsApp Provider سليم ومفعّل', attempts: [], methods });
    if (account && currentProvider && body.action !== 'switch' && candidates.some((row) => row.providerKey !== currentProvider)) {
      return json(409, { error: 'استخدم التحويل المنظم لتغيير مزود الرقم الحالي', currentProvider });
    }
    if (body.action === 'switch' && account && currentProvider) {
      const previous = runtimes.find((row) => row.providerKey === currentProvider);
      if (!previous?.baseUrl || !previous.secret) throw new Error('بيانات المزود القديم مطلوبة لإغلاق الجلسة قبل التحويل');
      // Even a previously disconnected record can be the result of a failed
      // database write after remote logout. Confirm remote cleanup again.
      await disconnectProvider(previous, instance, tokens.accessToken);
      account = await invalidateSession(account.id, operationId);
    }
    const attempts: Array<{ provider: ProviderKey; ok: boolean; error?: string }> = [];
    for (const runtime of candidates) {
      const reconnecting = Boolean(account && currentProvider === runtime.providerKey && body.action !== 'switch');
      // Token generation does not start the WPP browser. Persist it before start.
      const sessionToken = runtime.providerKey === 'wppconnect'
        ? await wppGenerateToken(runtime, instance) : `${runtime.providerKey}-provider`;
      const webhookSecret = reconnecting && metadata.session_active !== false && tokens.webhookSecret
        ? tokens.webhookSecret : randomSecret();
      account = await prepareSession({ workspaceId, operationId, runtime, instance, webhookSecret, sessionToken, previousAccount: account });
      const observedAt = new Date().toISOString();
      try {
        const result = await startProvider(runtime, instance, webhookSecret, sessionToken);
        const connected = connectedState(runtime.providerKey, result.state);
        const updated = await applySessionState(supabase, account.id, webhookSecret, {
          status: connected ? 'connected' : 'error', needs_reconnect: !connected,
          metadata: { provider_state: result.state, onboarding_state: connected ? 'ready' : 'scan_qr' },
        }, observedAt, operationId);
        if (!updated) throw new Error('تعذّر تأكيد الجلسة الحالية');
        attempts.push({ provider: runtime.providerKey, ok: true });
        return json(200, { ok: true, configured: true, connected: updated.status === 'connected',
          state: (updated.metadata as Record<string, unknown>).provider_state,
          providerKey: runtime.providerKey, providerLabel: runtime.displayName,
          qrBase64: result.qrBase64, qrCode: result.qrCode, pairingCode: result.pairingCode,
          accountId: account.id, attempts, alternatives: alternatives(runtime.providerKey),
        });
      } catch (error) {
        attempts.push({ provider: runtime.providerKey, ok: false,
          error: error instanceof Error ? error.message : 'provider_start_failed' });
        // A transient reconnect failure must not destroy the existing session.
        if (reconnecting) break;
        await disconnectProvider(runtime, instance, sessionToken);
        account = await invalidateSession(account.id, operationId);
      }
    }
    return json(502, { error: 'فشلت كل طرق ربط WhatsApp المتاحة', attempts, alternatives: alternatives(null) });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'تعذّر تشغيل WhatsApp' });
  } finally {
    if (claimed) {
      const { error } = await supabase.rpc('whatsapp_release_operation', { p_workspace_id: workspaceId, p_operation_id: operationId });
      if (error) console.error('WhatsApp operation lease release failed');
    }
  }
}
