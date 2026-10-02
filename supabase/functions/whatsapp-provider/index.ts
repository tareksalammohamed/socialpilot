import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabase = createClient(
  supabaseUrl,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type ProviderKey = 'evolution' | 'waha' | 'wppconnect';
type Action = 'list_methods' | 'start' | 'status' | 'disconnect';

type ProviderConfig = {
  provider_key: ProviderKey;
  display_name: string;
  base_url: string;
  enabled: boolean;
  priority: number;
  status: 'not_configured' | 'connected' | 'error';
  last_error: string | null;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function instanceName(workspaceId: string): string {
  return `socialpilot_${workspaceId.replace(/-/g, '')}`;
}

function normalizeState(value: unknown): string {
  return String(value ?? 'unknown').trim().toLowerCase().replace(/\s+/g, '_');
}

function connectedState(provider: ProviderKey, state: string): boolean {
  if (provider === 'evolution') return ['open', 'connected'].includes(state);
  if (provider === 'waha') return ['working', 'connected', 'authenticated'].includes(state);
  return ['connected', 'islogged', 'logged', 'open', 'inchat'].includes(state);
}

async function requireAdmin(req: Request, workspaceId: string): Promise<{ userId: string } | { response: Response }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return { response: json(401, { error: 'Unauthorized' }) };
  const { data: auth } = await supabase.auth.getUser(token);
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

async function listMethods(): Promise<Array<ProviderConfig & { available: boolean }>> {
  const { data } = await supabase
    .from('whatsapp_provider_configs')
    .select('provider_key,display_name,base_url,enabled,priority,status,last_error')
    .order('priority')
    .order('provider_key');
  return (data ?? []).map((row) => ({
    ...(row as ProviderConfig),
    available: Boolean(row.enabled && row.status === 'connected' && row.base_url),
  }));
}

async function providerConfig(providerKey: ProviderKey): Promise<{ config: ProviderConfig; secret: string }> {
  const [{ data: config }, { data: secret }] = await Promise.all([
    supabase
      .from('whatsapp_provider_configs')
      .select('provider_key,display_name,base_url,enabled,priority,status,last_error')
      .eq('provider_key', providerKey)
      .maybeSingle(),
    supabase
      .from('whatsapp_provider_secrets')
      .select('primary_secret')
      .eq('provider_key', providerKey)
      .maybeSingle(),
  ]);
  if (!config || !config.enabled || config.status !== 'connected' || !config.base_url || !secret?.primary_secret) {
    throw new Error(`مزود ${providerKey} غير جاهز`);
  }
  return {
    config: config as ProviderConfig,
    secret: String(secret.primary_secret),
  };
}

async function firstAvailableProvider(): Promise<ProviderKey | null> {
  const methods = await listMethods();
  return methods.find((row) => row.available)?.provider_key ?? null;
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

async function loadTokens(accountId: string): Promise<{ accessToken: string | null; webhookSecret: string | null }> {
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

async function saveAccount(params: {
  workspaceId: string;
  provider: ProviderKey;
  instance: string;
  webhookSecret: string;
  sessionToken?: string | null;
  state: string;
}) {
  const connected = connectedState(params.provider, params.state);
  const { data: account, error } = await supabase
    .from('social_accounts')
    .upsert({
      workspace_id: params.workspaceId,
      platform: 'whatsapp',
      external_id: params.instance,
      handle: 'WhatsApp Web',
      display_name: 'WhatsApp',
      status: connected ? 'connected' : 'error',
      needs_reconnect: !connected,
      metadata: {
        provider: params.provider,
        instance_name: params.instance,
        onboarding_state: connected ? 'ready' : 'scan_qr',
        provider_state: params.state,
      },
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,platform' })
    .select()
    .single();
  if (error || !account) throw new Error(error?.message ?? 'تعذّر حفظ جلسة WhatsApp');

  await supabase.from('social_account_tokens').upsert({
    account_id: account.id,
    access_token: params.sessionToken ?? `${params.provider}-provider`,
    refresh_token: params.webhookSecret,
    token_type: 'provider_session',
    expires_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_id' });

  return account;
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

async function evolutionState(baseUrl: string, apiKey: string, instance: string): Promise<string> {
  let result = await requestJson(`${baseUrl}/instance/connectionState/${encodeURIComponent(instance)}`, {
    headers: { apikey: apiKey },
  });
  if (result.response.ok) {
    const nested = result.body.instance as Record<string, unknown> | undefined;
    return normalizeState(nested?.state ?? result.body.state);
  }

  result = await requestJson(
    `${baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
    { headers: { apikey: apiKey } },
  );
  if (!result.response.ok) return 'missing';
  const rows = Array.isArray(result.body) ? result.body : ((result.body.instances as unknown[]) ?? []);
  const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  return normalizeState(row?.connectionStatus ?? row?.connectionState ?? row?.state);
}

function qrFrom(body: Record<string, unknown>): { qrBase64: string | null; qrCode: string | null; pairingCode: string | null } {
  const qrcode = body.qrcode as Record<string, unknown> | undefined;
  const data = body.data as Record<string, unknown> | undefined;
  const candidates = [qrcode?.base64, body.base64, body.qrcode, data?.qrcode, data?.qrCode];
  const base64 = candidates.find((value) => typeof value === 'string' && value.length > 50) as string | undefined;
  const code = [qrcode?.code, body.code, data?.code].find((value) => typeof value === 'string') as string | undefined;
  const pairing = [qrcode?.pairingCode, body.pairingCode, data?.pairingCode].find((value) => typeof value === 'string') as string | undefined;
  return {
    qrBase64: base64 ?? null,
    qrCode: code ?? null,
    pairingCode: pairing ?? null,
  };
}

async function evolutionStart(params: {
  baseUrl: string; apiKey: string; instance: string; webhookSecret: string;
}) {
  const webhookUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/whatsapp-provider-webhook?provider=evolution`;
  let state = await evolutionState(params.baseUrl, params.apiKey, params.instance);

  if (state === 'missing' || state === 'unknown') {
    const created = await requestJson(`${params.baseUrl}/instance/create`, {
      method: 'POST',
      headers: { apikey: params.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceName: params.instance,
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
      throw new Error(`Evolution create HTTP ${created.response.status}`);
    }
  }

  const webhookPayload = {
    webhook: {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      events: [
        'QRCODE_UPDATED',
        'CONNECTION_UPDATE',
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'SEND_MESSAGE',
        'SEND_MESSAGE_UPDATE',
      ],
      headers: { 'x-socialpilot-secret': params.webhookSecret },
    },
  };
  let webhook = await requestJson(
    `${params.baseUrl}/webhook/set/${encodeURIComponent(params.instance)}`,
    {
      method: 'POST',
      headers: { apikey: params.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    },
  );
  if (webhook.response.status === 404) {
    webhook = await requestJson(
      `${params.baseUrl}/event/webhook/set/${encodeURIComponent(params.instance)}`,
      {
        method: 'POST',
        headers: { apikey: params.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      },
    );
  }
  if (!webhook.response.ok) throw new Error(`Evolution webhook HTTP ${webhook.response.status}`);

  let connect = await requestJson(
    `${params.baseUrl}/instance/connect/${encodeURIComponent(params.instance)}`,
    { headers: { apikey: params.apiKey, Accept: 'application/json' } },
  );
  if (!connect.response.ok && connect.response.status !== 409) {
    connect = await requestJson(
      `${params.baseUrl}/instance/connect/${encodeURIComponent(params.instance)}`,
      { method: 'POST', headers: { apikey: params.apiKey, Accept: 'application/json' } },
    );
  }
  state = await evolutionState(params.baseUrl, params.apiKey, params.instance);
  return { state, ...qrFrom(connect.body), sessionToken: null };
}

async function evolutionDisconnect(baseUrl: string, apiKey: string, instance: string): Promise<void> {
  await fetch(`${baseUrl}/instance/logout/${encodeURIComponent(instance)}`, {
    method: 'DELETE',
    headers: { apikey: apiKey },
  }).catch(() => undefined);
  await fetch(`${baseUrl}/instance/delete/${encodeURIComponent(instance)}`, {
    method: 'DELETE',
    headers: { apikey: apiKey },
  }).catch(() => undefined);
}

async function wahaState(baseUrl: string, apiKey: string, instance: string): Promise<string> {
  const result = await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  if (result.response.status === 404) return 'missing';
  if (!result.response.ok) return 'unknown';
  return normalizeState(result.body.status ?? result.body.state);
}

async function wahaStart(params: {
  baseUrl: string; apiKey: string; instance: string; webhookSecret: string;
}) {
  const webhookUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/whatsapp-provider-webhook?provider=waha`;
  let state = await wahaState(params.baseUrl, params.apiKey, params.instance);
  if (state === 'missing' || state === 'unknown') {
    const created = await requestJson(`${params.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'X-Api-Key': params.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: params.instance,
        config: {
          webhooks: [{
            url: webhookUrl,
            events: ['message', 'message.ack', 'session.status'],
            customHeaders: [{ name: 'x-socialpilot-secret', value: params.webhookSecret }],
            hmac: { key: params.webhookSecret },
            retries: { policy: 'linear', delaySeconds: 2, attempts: 5 },
          }],
        },
      }),
    });
    if (!created.response.ok && created.response.status !== 409) {
      throw new Error(`WAHA create session HTTP ${created.response.status}`);
    }
  }

  const started = await requestJson(
    `${params.baseUrl}/api/sessions/${encodeURIComponent(params.instance)}/start`,
    {
      method: 'POST',
      headers: { 'X-Api-Key': params.apiKey, Accept: 'application/json' },
    },
  );
  if (!started.response.ok && ![409, 422].includes(started.response.status)) {
    throw new Error(`WAHA start session HTTP ${started.response.status}`);
  }

  state = await wahaState(params.baseUrl, params.apiKey, params.instance);
  const qr = await requestJson(
    `${params.baseUrl}/api/${encodeURIComponent(params.instance)}/auth/qr`,
    {
      headers: { 'X-Api-Key': params.apiKey, Accept: 'application/json' },
    },
  );
  const qrData = typeof qr.body.data === 'string' ? qr.body.data : null;
  const qrCode = typeof qr.body.value === 'string' ? qr.body.value : null;
  return {
    state,
    qrBase64: qrData,
    qrCode,
    pairingCode: null,
    sessionToken: null,
  };
}

async function wahaDisconnect(baseUrl: string, apiKey: string, instance: string): Promise<void> {
  await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}/logout`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey },
  }).catch(() => undefined);
  await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(instance)}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': apiKey },
  }).catch(() => undefined);
}

async function wppGenerateToken(baseUrl: string, secretKey: string, instance: string): Promise<{ token: string; fallback: string | null }> {
  const result = await requestJson(
    `${baseUrl}/api/${encodeURIComponent(instance)}/${encodeURIComponent(secretKey)}/generate-token`,
    { method: 'POST', headers: { Accept: 'application/json' } },
  );
  if (!result.response.ok) throw new Error(`WPPConnect generate-token HTTP ${result.response.status}`);
  const full = typeof result.body.full === 'string' ? result.body.full : null;
  const raw = typeof result.body.token === 'string' ? result.body.token : null;
  const token = full || raw;
  if (!token) throw new Error('WPPConnect لم يرجع Session Token');
  return { token, fallback: full && raw && full !== raw ? raw : null };
}

async function wppRequest(
  baseUrl: string,
  instance: string,
  path: string,
  token: string,
  fallbackToken: string | null,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown>; tokenUsed: string }> {
  const call = async (bearer: string) => requestJson(`${baseUrl}/api/${encodeURIComponent(instance)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  let result = await call(token);
  let used = token;
  if (result.response.status === 401 && fallbackToken) {
    result = await call(fallbackToken);
    used = fallbackToken;
  }
  return { ...result, tokenUsed: used };
}

async function wppState(baseUrl: string, instance: string, token: string): Promise<string> {
  const result = await wppRequest(baseUrl, instance, '/check-connection-session', token, null);
  if (!result.response.ok) return result.response.status === 404 ? 'missing' : 'unknown';
  const status = result.body.status ?? result.body.message ?? result.body.state ?? result.body.response;
  return normalizeState(status);
}

function wppQr(body: Record<string, unknown>) {
  const data = body.data as Record<string, unknown> | undefined;
  const base64 = [
    body.qrcode,
    body.qrCode,
    body.base64,
    data?.qrcode,
    data?.qrCode,
    data?.base64,
  ].find((value) => typeof value === 'string' && value.length > 50) as string | undefined;
  return { qrBase64: base64 ?? null, qrCode: null, pairingCode: null };
}

async function wppStart(params: {
  baseUrl: string; secretKey: string; instance: string; webhookSecret: string;
}) {
  const generated = await wppGenerateToken(params.baseUrl, params.secretKey, params.instance);
  const webhookUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/whatsapp-provider-webhook?provider=wppconnect&secret=${encodeURIComponent(params.webhookSecret)}`;

  let start = await wppRequest(
    params.baseUrl,
    params.instance,
    '/start-session',
    generated.token,
    generated.fallback,
    {
      method: 'POST',
      body: JSON.stringify({ webhook: webhookUrl, waitQrCode: true }),
    },
  );
  if (!start.response.ok && start.response.status !== 409) {
    throw new Error(`WPPConnect start-session HTTP ${start.response.status}`);
  }

  const tokenUsed = start.tokenUsed;
  let state = await wppState(params.baseUrl, params.instance, tokenUsed);
  let qr = wppQr(start.body);
  if (!qr.qrBase64 && !connectedState('wppconnect', state)) {
    const qrResult = await wppRequest(
      params.baseUrl,
      params.instance,
      '/qrcode-session',
      tokenUsed,
      null,
    );
    if (qrResult.response.ok) qr = wppQr(qrResult.body);
  }
  return { state, ...qr, sessionToken: tokenUsed };
}

async function wppDisconnect(baseUrl: string, instance: string, sessionToken: string): Promise<void> {
  await fetch(`${baseUrl}/api/${encodeURIComponent(instance)}/logout-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, Accept: 'application/json' },
  }).catch(() => undefined);
}

async function getState(provider: ProviderKey, config: ProviderConfig, secret: string, account: Record<string, unknown>) {
  const instance = String((account.metadata as Record<string, unknown> | null)?.instance_name ?? account.external_id ?? '');
  if (!instance) return 'missing';
  if (provider === 'evolution') return evolutionState(config.base_url, secret, instance);
  if (provider === 'waha') return wahaState(config.base_url, secret, instance);
  const tokens = await loadTokens(String(account.id));
  if (!tokens.accessToken) return 'missing';
  return wppState(config.base_url, instance, tokens.accessToken);
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

  if (body.action === 'list_methods') {
    const methods = await listMethods();
    return json(200, {
      methods: methods.map(({ provider_key, display_name, priority, status, last_error, available }) => ({
        providerKey: provider_key,
        displayName: display_name,
        priority,
        status,
        lastError: last_error,
        available,
      })),
    });
  }

  let account = await loadAccount(workspaceId);

  try {
    if (body.action === 'status') {
      if (!account || !account.metadata?.provider) {
        return json(200, { configured: true, connected: false, state: 'not_created', providerKey: null });
      }
      const provider = String(account.metadata.provider) as ProviderKey;
      if (!VALID_PROVIDER(provider)) {
        return json(200, { configured: false, connected: false, state: 'legacy_provider', providerKey: provider });
      }
      const { config, secret } = await providerConfig(provider);
      const state = await getState(provider, config, secret, account);
      const connected = connectedState(provider, state);
      if (connected !== (account.status === 'connected') || state !== account.metadata?.provider_state) {
        const { data: updated } = await supabase.from('social_accounts').update({
          status: connected ? 'connected' : 'error',
          needs_reconnect: !connected,
          last_sync_at: new Date().toISOString(),
          metadata: {
            ...(account.metadata ?? {}),
            provider_state: state,
            onboarding_state: connected ? 'ready' : 'scan_qr',
          },
        }).eq('id', account.id).select().single();
        if (updated) account = updated;
      }
      return json(200, {
        configured: true,
        connected,
        state,
        providerKey: provider,
        account,
      });
    }

    if (body.action === 'disconnect') {
      if (!account?.metadata?.provider) {
        return json(200, { ok: true, connected: false, state: 'disconnected' });
      }
      const provider = String(account.metadata.provider) as ProviderKey;
      if (VALID_PROVIDER(provider)) {
        const { config, secret } = await providerConfig(provider);
        const instance = String(account.metadata.instance_name ?? account.external_id ?? instanceName(workspaceId));
        const tokens = await loadTokens(account.id);
        if (provider === 'evolution') await evolutionDisconnect(config.base_url, secret, instance);
        if (provider === 'waha') await wahaDisconnect(config.base_url, secret, instance);
        if (provider === 'wppconnect' && tokens.accessToken) {
          await wppDisconnect(config.base_url, instance, tokens.accessToken);
        }
      }
      await supabase.from('social_accounts').delete().eq('id', account.id).eq('workspace_id', workspaceId);
      return json(200, { ok: true, connected: false, state: 'disconnected' });
    }

    const requested = body.providerKey ?? await firstAvailableProvider();
    if (!requested || !VALID_PROVIDER(requested)) {
      return json(409, { error: 'لا يوجد WhatsApp Provider متاح حاليًا' });
    }

    if (account?.metadata?.provider && account.metadata.provider !== requested && account.status === 'connected') {
      return json(409, {
        error: `WhatsApp متصل حاليًا عبر ${account.metadata.provider}. افصل الجلسة أولًا ثم اختر المزود البديل.`,
        currentProvider: account.metadata.provider,
      });
    }

    // A broken/non-connected old provider can be replaced safely.
    if (account?.metadata?.provider && account.metadata.provider !== requested) {
      const oldProvider = String(account.metadata.provider) as ProviderKey;
      if (VALID_PROVIDER(oldProvider)) {
        try {
          const { config: oldConfig, secret: oldSecret } = await providerConfig(oldProvider);
          const oldInstance = String(account.metadata.instance_name ?? account.external_id ?? instanceName(workspaceId));
          const oldTokens = await loadTokens(account.id);
          if (oldProvider === 'evolution') await evolutionDisconnect(oldConfig.base_url, oldSecret, oldInstance);
          if (oldProvider === 'waha') await wahaDisconnect(oldConfig.base_url, oldSecret, oldInstance);
          if (oldProvider === 'wppconnect' && oldTokens.accessToken) {
            await wppDisconnect(oldConfig.base_url, oldInstance, oldTokens.accessToken);
          }
        } catch {
          // Controlled migration continues even if the broken provider cannot be reached.
        }
      }
    }

    const { config, secret } = await providerConfig(requested);
    const instance = instanceName(workspaceId);
    const existingTokens = account?.id ? await loadTokens(account.id) : { webhookSecret: null, accessToken: null };
    const webhookSecret = existingTokens.webhookSecret || randomSecret();

    let result: {
      state: string;
      qrBase64: string | null;
      qrCode: string | null;
      pairingCode: string | null;
      sessionToken: string | null;
    };

    if (requested === 'evolution') {
      result = await evolutionStart({
        baseUrl: config.base_url,
        apiKey: secret,
        instance,
        webhookSecret,
      });
    } else if (requested === 'waha') {
      result = await wahaStart({
        baseUrl: config.base_url,
        apiKey: secret,
        instance,
        webhookSecret,
      });
    } else {
      result = await wppStart({
        baseUrl: config.base_url,
        secretKey: secret,
        instance,
        webhookSecret,
      });
    }

    account = await saveAccount({
      workspaceId,
      provider: requested,
      instance,
      webhookSecret,
      sessionToken: result.sessionToken,
      state: result.state,
    });

    return json(200, {
      ok: true,
      configured: true,
      connected: connectedState(requested, result.state),
      state: result.state,
      providerKey: requested,
      qrBase64: result.qrBase64,
      qrCode: result.qrCode,
      pairingCode: result.pairingCode,
      accountId: account.id,
    });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'تعذّر تشغيل WhatsApp' });
  }
});

function VALID_PROVIDER(value: string): value is ProviderKey {
  return value === 'evolution' || value === 'waha' || value === 'wppconnect';
}
