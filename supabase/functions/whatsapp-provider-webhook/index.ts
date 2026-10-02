import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-SocialPilot-Secret, x-socialpilot-secret, X-Webhook-Hmac, X-Webhook-Hmac-Algorithm',
};
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

type ProviderKey = 'evolution' | 'waha' | 'wppconnect';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
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
  return ['connected', 'islogged', 'logged', 'open', 'inchat'].includes(state);
}

function deliveryStatus(raw: unknown): string | null {
  const numeric: Record<number, string> = {
    [-1]: 'failed',
    0: 'accepted',
    1: 'sent',
    2: 'delivered',
    3: 'read',
    4: 'read',
    5: 'read',
  };
  if (typeof raw === 'number') return numeric[raw] ?? null;
  const value = String(raw ?? '').toUpperCase();
  const map: Record<string, string> = {
    ERROR: 'failed',
    PENDING: 'accepted',
    SERVER: 'sent',
    SERVER_ACK: 'sent',
    DEVICE: 'delivered',
    DELIVERY_ACK: 'delivered',
    READ: 'read',
    PLAYED: 'read',
  };
  return map[value] ?? null;
}

function remoteParticipant(value: string): string {
  return value
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '');
}

async function providerConfig(provider: ProviderKey): Promise<{ baseUrl: string; secret: string }> {
  const [{ data: config }, { data: secret }] = await Promise.all([
    supabase
      .from('whatsapp_provider_configs')
      .select('base_url,enabled,status')
      .eq('provider_key', provider)
      .maybeSingle(),
    supabase
      .from('whatsapp_provider_secrets')
      .select('primary_secret')
      .eq('provider_key', provider)
      .maybeSingle(),
  ]);
  if (!config?.base_url || !secret?.primary_secret) throw new Error(`${provider} config missing`);
  return { baseUrl: normalizeBaseUrl(String(config.base_url)), secret: String(secret.primary_secret) };
}

async function accountByInstance(provider: ProviderKey, instance: string, querySecret?: string | null) {
  if (provider === 'wppconnect' && querySecret) {
    const { data: token } = await supabase
      .from('social_account_tokens')
      .select('account_id')
      .eq('refresh_token', querySecret)
      .maybeSingle();
    if (!token?.account_id) return null;
    const { data: account } = await supabase
      .from('social_accounts')
      .select('id,workspace_id,status,metadata,external_id')
      .eq('id', token.account_id)
      .eq('platform', 'whatsapp')
      .maybeSingle();
    if (account?.metadata?.provider === 'wppconnect') return account;
    return null;
  }

  const { data: rows } = await supabase
    .from('social_accounts')
    .select('id,workspace_id,status,metadata,external_id')
    .eq('platform', 'whatsapp');
  return (rows ?? []).find((account) => (
    account.metadata?.provider === provider
    && String(account.metadata?.instance_name ?? account.external_id ?? '') === instance
  )) ?? null;
}

async function webhookSecret(accountId: string): Promise<string | null> {
  const { data } = await supabase
    .from('social_account_tokens')
    .select('refresh_token')
    .eq('account_id', accountId)
    .maybeSingle();
  return typeof data?.refresh_token === 'string' ? data.refresh_token : null;
}

async function sessionToken(accountId: string): Promise<string | null> {
  const { data } = await supabase
    .from('social_account_tokens')
    .select('access_token')
    .eq('account_id', accountId)
    .maybeSingle();
  return typeof data?.access_token === 'string' ? data.access_token : null;
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(raw);
  if (binary.length > MAX_MEDIA_BYTES) throw new Error('media_too_large');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function storeMedia(params: {
  workspaceId: string;
  accountId: string;
  messageId: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}): Promise<Record<string, unknown>> {
  const path = `${params.workspaceId}/${params.accountId}/${params.messageId}/${safeName(params.filename)}`;
  const { error } = await supabase.storage.from('inbox-media').upload(path, params.bytes, {
    contentType: params.mimeType,
    upsert: true,
  });
  if (error) return { media_download_error: error.message };
  return {
    storage_path: path,
    filename: params.filename,
    mime_type: params.mimeType,
    file_size: params.bytes.byteLength,
  };
}

function evolutionMessage(data: Record<string, unknown>) {
  const key = (data.key ?? {}) as Record<string, unknown>;
  const message = (data.message ?? {}) as Record<string, unknown>;
  const primary = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  const alt = typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : '';
  const jid = primary.endsWith('@s.whatsapp.net') ? primary : alt.endsWith('@s.whatsapp.net') ? alt : primary || alt;
  const fromMe = key.fromMe === true;
  const id = typeof key.id === 'string' ? key.id : '';

  const nested = (() => {
    let current = message;
    for (let i = 0; i < 4; i += 1) {
      const wrapper = (
        current.ephemeralMessage
        ?? current.viewOnceMessage
        ?? current.viewOnceMessageV2
        ?? current.documentWithCaptionMessage
      ) as Record<string, unknown> | undefined;
      const next = wrapper?.message as Record<string, unknown> | undefined;
      if (!next) break;
      current = next;
    }
    return current;
  })();

  if (typeof nested.conversation === 'string') {
    return { id, jid, fromMe, content: nested.conversation, type: 'text', media: false, filename: null, mimeType: null };
  }
  const extended = nested.extendedTextMessage as Record<string, unknown> | undefined;
  if (typeof extended?.text === 'string') {
    return { id, jid, fromMe, content: extended.text, type: 'text', media: false, filename: null, mimeType: null };
  }

  const defs = [
    ['imageMessage', 'image', 'صورة'],
    ['videoMessage', 'video', 'فيديو'],
    ['audioMessage', 'audio', 'رسالة صوتية'],
    ['documentMessage', 'document', 'ملف'],
    ['stickerMessage', 'sticker', 'ملصق'],
  ] as const;
  for (const [field, type, label] of defs) {
    const value = nested[field] as Record<string, unknown> | undefined;
    if (!value) continue;
    const caption = typeof value.caption === 'string' ? value.caption.trim() : '';
    const filename = typeof value.fileName === 'string' ? value.fileName : null;
    return {
      id, jid, fromMe,
      content: caption || `[${label}${filename ? `: ${filename}` : ''}]`,
      type,
      media: true,
      filename,
      mimeType: typeof value.mimetype === 'string' ? value.mimetype : null,
    };
  }
  return { id, jid, fromMe, content: '[رسالة WhatsApp]', type: String(data.messageType ?? 'unknown'), media: false, filename: null, mimeType: null };
}

function wahaMessage(data: Record<string, unknown>) {
  const fromMe = data.fromMe === true;
  const jid = String(data.chatId ?? (fromMe ? data.to : data.from) ?? '');
  const id = typeof data.id === 'string' ? data.id : '';
  const rawType = String(data.type ?? 'text').toLowerCase();
  const typeMap: Record<string, string> = {
    chat: 'text',
    text: 'text',
    image: 'image',
    video: 'video',
    ptt: 'audio',
    audio: 'audio',
    document: 'document',
    sticker: 'sticker',
  };
  const type = typeMap[rawType] ?? rawType;
  const body = typeof data.body === 'string' ? data.body : '';
  const media = data.media as Record<string, unknown> | undefined;
  const filename = typeof media?.filename === 'string'
    ? media.filename
    : typeof data.filename === 'string'
      ? data.filename
      : null;
  const mimeType = typeof media?.mimetype === 'string'
    ? media.mimetype
    : typeof data.mimetype === 'string'
      ? data.mimetype
      : null;
  const labels: Record<string, string> = {
    image: 'صورة', video: 'فيديو', audio: 'رسالة صوتية', document: 'ملف', sticker: 'ملصق',
  };
  return {
    id,
    jid,
    fromMe,
    content: body || (labels[type] ? `[${labels[type]}${filename ? `: ${filename}` : ''}]` : '[رسالة WhatsApp]'),
    type,
    media: Boolean(data.hasMedia || media?.url || ['image','video','audio','document','sticker'].includes(type)),
    filename,
    mimeType,
    mediaUrl: typeof media?.url === 'string' ? media.url : null,
  };
}

function wppMessage(root: Record<string, unknown>) {
  const data = (root.data ?? root.message ?? root) as Record<string, unknown>;
  const fromMe = data.fromMe === true || data.isSentByMe === true;
  const jid = String(data.chatId ?? (fromMe ? data.to : data.from) ?? data.sender?.id ?? '');
  const rawId = data.id;
  const id = typeof rawId === 'string'
    ? rawId
    : rawId && typeof rawId === 'object'
      ? String((rawId as Record<string, unknown>)._serialized ?? (rawId as Record<string, unknown>).id ?? '')
      : '';
  const rawType = String(data.type ?? data.mimetype ?? 'text').toLowerCase();
  let type = 'text';
  if (rawType.includes('image')) type = 'image';
  else if (rawType.includes('video')) type = 'video';
  else if (rawType.includes('audio') || rawType.includes('ptt')) type = 'audio';
  else if (rawType.includes('document') || rawType.includes('pdf')) type = 'document';
  else if (rawType.includes('sticker')) type = 'sticker';
  const filename = typeof data.filename === 'string' ? data.filename : null;
  const content = typeof data.body === 'string'
    ? data.body
    : typeof data.content === 'string'
      ? data.content
      : typeof data.caption === 'string'
        ? data.caption
        : type === 'text' ? '[رسالة WhatsApp]' : `[${type}${filename ? `: ${filename}` : ''}]`;
  return {
    id, jid, fromMe, content, type,
    media: Boolean(data.isMedia || type !== 'text'),
    filename,
    mimeType: typeof data.mimetype === 'string' ? data.mimetype : null,
  };
}

async function evolutionMedia(params: {
  baseUrl: string; apiKey: string; instance: string; payload: Record<string, unknown>;
  workspaceId: string; accountId: string; messageId: string; filename: string | null; mimeType: string | null; type: string;
}) {
  const response = await fetch(
    `${params.baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(params.instance)}`,
    {
      method: 'POST',
      headers: { apikey: params.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: params.payload, convertToMp4: false }),
    },
  );
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.base64 !== 'string') return { media_download_error: `Evolution media HTTP ${response.status}` };
  const mime = typeof body.mimetype === 'string' ? body.mimetype : params.mimeType ?? 'application/octet-stream';
  const filename = params.filename ?? (typeof body.fileName === 'string' ? body.fileName : `${params.messageId}.${params.type}`);
  return storeMedia({
    workspaceId: params.workspaceId,
    accountId: params.accountId,
    messageId: params.messageId,
    bytes: decodeBase64(body.base64),
    filename,
    mimeType: mime,
  });
}

async function wahaMedia(params: {
  mediaUrl: string; apiKey: string; workspaceId: string; accountId: string; messageId: string; filename: string | null; mimeType: string | null; type: string;
}) {
  const response = await fetch(params.mediaUrl, { headers: { 'X-Api-Key': params.apiKey } });
  if (!response.ok) return { media_download_error: `WAHA media HTTP ${response.status}` };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) return { media_download_error: 'media_too_large' };
  const mime = response.headers.get('content-type') ?? params.mimeType ?? 'application/octet-stream';
  const filename = params.filename ?? `${params.messageId}.${params.type}`;
  return storeMedia({
    workspaceId: params.workspaceId,
    accountId: params.accountId,
    messageId: params.messageId,
    bytes,
    filename,
    mimeType: mime,
  });
}

async function wppMedia(params: {
  baseUrl: string; instance: string; sessionToken: string; messageId: string;
  workspaceId: string; accountId: string; filename: string | null; mimeType: string | null; type: string;
}) {
  const response = await fetch(`${params.baseUrl}/api/${encodeURIComponent(params.instance)}/download-media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.sessionToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ messageId: params.messageId }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const candidate = [body.base64, body.data, body.file, (body.response as Record<string, unknown> | undefined)?.base64]
    .find((value) => typeof value === 'string' && value.length > 50) as string | undefined;
  if (!response.ok || !candidate) return { media_download_error: `WPPConnect media HTTP ${response.status}` };
  const mime = typeof body.mimetype === 'string' ? body.mimetype : params.mimeType ?? 'application/octet-stream';
  const filename = params.filename ?? (typeof body.filename === 'string' ? body.filename : `${params.messageId}.${params.type}`);
  return storeMedia({
    workspaceId: params.workspaceId,
    accountId: params.accountId,
    messageId: params.messageId,
    bytes: decodeBase64(candidate),
    filename,
    mimeType: mime,
  });
}

async function upsertMessage(params: {
  provider: ProviderKey;
  account: Record<string, unknown>;
  instance: string;
  providerPayload: Record<string, unknown>;
  parsed: {
    id: string; jid: string; fromMe: boolean; content: string; type: string; media: boolean;
    filename: string | null; mimeType: string | null; mediaUrl?: string | null;
  };
}) {
  if (!params.parsed.id || !params.parsed.jid || params.parsed.jid === 'status@broadcast') return;
  const workspaceId = String(params.account.workspace_id);
  const accountId = String(params.account.id);
  const participant = remoteParticipant(params.parsed.jid);
  const isGroup = params.parsed.jid.endsWith('@g.us');
  const pushName = typeof params.providerPayload.pushName === 'string'
    ? params.providerPayload.pushName
    : typeof params.providerPayload.notifyName === 'string'
      ? params.providerPayload.notifyName
      : null;

  const { data: conversation, error: conversationError } = await supabase
    .from('inbox_conversations')
    .upsert({
      workspace_id: workspaceId,
      account_id: accountId,
      platform: 'whatsapp',
      type: 'dm',
      external_id: params.parsed.jid,
      external_participant_id: params.parsed.jid,
      sender_name: pushName ?? participant,
      snippet: params.parsed.content,
      unread: !params.parsed.fromMe,
      status: 'open',
      resolved_at: null,
      metadata: {
        provider: params.provider,
        remote_jid: params.parsed.jid,
        is_group: isGroup,
      },
    }, { onConflict: 'account_id,platform,type,external_id' })
    .select('id')
    .single();
  if (conversationError || !conversation) return;

  let mediaMetadata: Record<string, unknown> = {};
  if (params.parsed.media) {
    try {
      const cfg = await providerConfig(params.provider);
      if (params.provider === 'evolution') {
        mediaMetadata = await evolutionMedia({
          baseUrl: cfg.baseUrl, apiKey: cfg.secret, instance: params.instance,
          payload: params.providerPayload, workspaceId, accountId,
          messageId: params.parsed.id, filename: params.parsed.filename,
          mimeType: params.parsed.mimeType, type: params.parsed.type,
        });
      } else if (params.provider === 'waha' && params.parsed.mediaUrl) {
        mediaMetadata = await wahaMedia({
          mediaUrl: params.parsed.mediaUrl, apiKey: cfg.secret,
          workspaceId, accountId, messageId: params.parsed.id,
          filename: params.parsed.filename, mimeType: params.parsed.mimeType, type: params.parsed.type,
        });
      } else if (params.provider === 'wppconnect') {
        const token = await sessionToken(accountId);
        if (token) {
          mediaMetadata = await wppMedia({
            baseUrl: cfg.baseUrl, instance: params.instance, sessionToken: token,
            workspaceId, accountId, messageId: params.parsed.id,
            filename: params.parsed.filename, mimeType: params.parsed.mimeType, type: params.parsed.type,
          });
        }
      }
    } catch (error) {
      mediaMetadata = { media_download_error: error instanceof Error ? error.message : 'media_download_failed' };
    }
  }

  const timestampRaw = params.providerPayload.messageTimestamp ?? params.providerPayload.timestamp;
  const numericTimestamp = Number(timestampRaw);
  const createdAt = Number.isFinite(numericTimestamp) && numericTimestamp > 0
    ? new Date(numericTimestamp > 10_000_000_000 ? numericTimestamp : numericTimestamp * 1000).toISOString()
    : new Date().toISOString();

  const { data: inserted, error: messageError } = await supabase
    .from('inbox_messages')
    .upsert({
      workspace_id: workspaceId,
      conversation_id: conversation.id,
      direction: params.parsed.fromMe ? 'outbound' : 'inbound',
      content: params.parsed.content,
      is_ai: false,
      external_id: params.parsed.id,
      sender_external_id: params.parsed.fromMe ? null : participant,
      sender_name: params.parsed.fromMe ? 'أنت' : (pushName ?? participant),
      created_at: createdAt,
      metadata: {
        source: 'whatsapp_provider_webhook',
        provider: params.provider,
        message_type: params.parsed.type,
        remote_jid: params.parsed.jid,
        ...mediaMetadata,
      },
    }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  if (messageError || !inserted || params.parsed.fromMe) return;

  await supabase.from('notifications').insert({
    workspace_id: workspaceId,
    type: 'inbox_new_message',
    title: `رسالة WhatsApp جديدة${pushName ? ` من ${pushName}` : ''}`,
    body: params.parsed.content.length > 140 ? `${params.parsed.content.slice(0, 140)}…` : params.parsed.content,
    payload: { conversation_id: conversation.id, platform: 'whatsapp', inbox_type: 'dm', provider: params.provider },
  });
}

async function applyDelivery(account: Record<string, unknown>, externalId: string, status: string, raw: unknown) {
  const rank: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 99 };
  const { data: row } = await supabase
    .from('inbox_messages')
    .select('id,metadata,conversation_id')
    .eq('workspace_id', account.workspace_id)
    .eq('external_id', externalId)
    .eq('direction', 'outbound')
    .maybeSingle();
  if (!row) return;
  const previous = typeof row.metadata?.delivery_status === 'string' ? row.metadata.delivery_status : null;
  if (previous && previous !== 'failed' && status !== 'failed' && (rank[previous] ?? -1) > (rank[status] ?? -1)) return;
  if (previous === 'read' && status === 'failed') return;

  await supabase.from('inbox_messages').update({
    metadata: {
      ...(row.metadata ?? {}),
      delivery_status: status,
      delivery_status_at: new Date().toISOString(),
      provider_update: raw,
    },
  }).eq('id', row.id);

  if (status === 'failed') {
    await supabase.from('notifications').insert({
      workspace_id: account.workspace_id,
      type: 'inbox_delivery_failed',
      title: 'فشل إرسال رسالة WhatsApp',
      body: 'مزود WhatsApp أعاد حالة فشل للرسالة.',
      payload: { conversation_id: row.conversation_id, platform: 'whatsapp', external_message_id: externalId },
    });
  }
}

async function updateConnection(account: Record<string, unknown>, provider: ProviderKey, stateValue: unknown, sender?: string | null) {
  const state = normalizeState(stateValue);
  const connected = connectedState(provider, state);
  await supabase.from('social_accounts').update({
    status: connected ? 'connected' : 'error',
    needs_reconnect: !connected,
    ...(sender ? {
      external_id: sender,
      handle: remoteParticipant(sender),
      display_name: remoteParticipant(sender),
    } : {}),
    last_sync_at: new Date().toISOString(),
    metadata: {
      ...(account.metadata ?? {}),
      provider_state: state,
      onboarding_state: connected ? 'ready' : 'scan_qr',
    },
  }).eq('id', account.id);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const providerRaw = url.searchParams.get('provider') ?? '';
  if (!['evolution','waha','wppconnect'].includes(providerRaw)) {
    return json(400, { error: 'Unknown provider' });
  }
  const provider = providerRaw as ProviderKey;

  const payload = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return json(400, { error: 'Invalid JSON' });

  const wppWrapped = asObject(payload.body);
  const root = provider === 'wppconnect' && Object.keys(wppWrapped).length > 0 ? wppWrapped : payload;

  const instance = provider === 'evolution'
    ? String(payload.instance ?? asObject(payload.data).instance ?? '')
    : provider === 'waha'
      ? String(payload.session ?? '')
      : String(root.session ?? payload.session ?? root.instance ?? '');

  const querySecret = url.searchParams.get('secret');
  const account = await accountByInstance(provider, instance, querySecret);
  if (!account) return json(200, { ok: true, ignored: true, reason: 'unknown_instance' });

  const expectedSecret = await webhookSecret(account.id);
  if (!expectedSecret) return json(401, { error: 'Webhook secret missing' });

  if (provider === 'wppconnect') {
    if (!querySecret || querySecret !== expectedSecret) return json(401, { error: 'Invalid webhook secret' });
  } else {
    const supplied = req.headers.get('x-socialpilot-secret') ?? '';
    if (supplied !== expectedSecret) return json(401, { error: 'Invalid webhook secret' });
  }

  try {
    if (provider === 'evolution') {
      const event = String(payload.event ?? '').toLowerCase();
      const data = payload.data;
      if (event === 'connection.update') {
        const stateData = asObject(data);
        await updateConnection(account, provider, stateData.state, typeof payload.sender === 'string' ? payload.sender : null);
        return json(200, { ok: true });
      }
      if (event === 'messages.update' || event === 'send.message.update') {
        const updates = Array.isArray(data) ? data : [data];
        for (const raw of updates) {
          const update = asObject(raw);
          const key = asObject(update.key);
          const id = typeof key.id === 'string' ? key.id : '';
          const status = deliveryStatus(update.status ?? update.update ?? update.messageUpdate);
          if (id && status) await applyDelivery(account, id, status, update);
        }
        return json(200, { ok: true });
      }
      if (event === 'messages.upsert' || event === 'send.message') {
        const items = Array.isArray(data) ? data : [data];
        for (const raw of items) {
          const item = asObject(raw);
          const parsed = evolutionMessage(item);
          await upsertMessage({ provider, account, instance, providerPayload: item, parsed });
        }
        return json(200, { ok: true });
      }
      return json(200, { ok: true, ignored: true, event });
    }

    if (provider === 'waha') {
      const event = String(payload.event ?? '').toLowerCase();
      const data = asObject(payload.payload);
      if (event === 'session.status') {
        await updateConnection(account, provider, data.status ?? payload.status);
        return json(200, { ok: true });
      }
      if (event === 'message.ack') {
        const id = typeof data.id === 'string' ? data.id : '';
        const status = deliveryStatus(data.ackName ?? data.ack);
        if (id && status) await applyDelivery(account, id, status, data);
        return json(200, { ok: true });
      }
      if (event === 'message') {
        const parsed = wahaMessage(data);
        await upsertMessage({ provider, account, instance, providerPayload: data, parsed });
        return json(200, { ok: true });
      }
      return json(200, { ok: true, ignored: true, event });
    }

    const event = String(root.event ?? payload.event ?? '').toLowerCase();
    const data = asObject(root.data ?? root);
    if (event.includes('status') || event.includes('state') || event.includes('session')) {
      await updateConnection(account, provider, root.status ?? data.status ?? root.state ?? data.state);
      return json(200, { ok: true });
    }
    if (event.includes('ack')) {
      const rawId = data.id;
      const id = typeof rawId === 'string'
        ? rawId
        : rawId && typeof rawId === 'object'
          ? String(asObject(rawId)._serialized ?? asObject(rawId).id ?? '')
          : '';
      const status = deliveryStatus(data.ack ?? data.status);
      if (id && status) await applyDelivery(account, id, status, data);
      return json(200, { ok: true });
    }
    if (event.includes('message') || data.body || data.content) {
      const parsed = wppMessage(root);
      await upsertMessage({ provider, account, instance, providerPayload: data, parsed });
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: true, event });
  } catch (error) {
    console.error('whatsapp-provider-webhook failed', provider, error);
    return json(500, { error: error instanceof Error ? error.message : 'Webhook processing failed' });
  }
});
