import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-SocialPilot-Secret, x-socialpilot-secret',
};
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

async function providerConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps').select('app_id,enabled,has_secret').eq('platform_key', 'whatsapp').maybeSingle(),
    supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'whatsapp').maybeSingle(),
  ]);
  const raw = typeof secret?.app_secret === 'string' ? secret.app_secret.trim() : '';

  if (raw.startsWith('{')) {
    const bundle = JSON.parse(raw) as {
      providers?: {
        evolution?: {
          baseUrl?: string;
          credential?: string;
          enabled?: boolean;
          status?: string;
        };
      };
    };
    const config = bundle.providers?.evolution;
    if (
      !app?.has_secret
      || !config?.baseUrl
      || !config.credential
      || config.enabled !== true
      || config.status !== 'connected'
    ) {
      throw new Error('Evolution provider is not configured');
    }
    return {
      baseUrl: normalizeBaseUrl(config.baseUrl),
      apiKey: config.credential,
    };
  }

  if (!app?.enabled || !app.app_id || !raw || !/^https?:\/\//i.test(String(app.app_id))) {
    throw new Error('Evolution provider is not configured');
  }
  return { baseUrl: normalizeBaseUrl(String(app.app_id)), apiKey: raw };
}

function unwrapMessage(message: Record<string, unknown>): Record<string, unknown> {
  let current = message;
  for (let i = 0; i < 4; i += 1) {
    const wrapper = (
      current.ephemeralMessage
      ?? current.viewOnceMessage
      ?? current.viewOnceMessageV2
      ?? current.documentWithCaptionMessage
    ) as Record<string, unknown> | undefined;
    const nested = wrapper?.message as Record<string, unknown> | undefined;
    if (!nested) break;
    current = nested;
  }
  return current;
}

function detectMessage(data: Record<string, unknown>): {
  content: string;
  type: string;
  media: boolean;
  filename: string | null;
  mimeType: string | null;
} {
  const message = unwrapMessage((data.message ?? {}) as Record<string, unknown>);
  if (typeof message.conversation === 'string') {
    return { content: message.conversation, type: 'text', media: false, filename: null, mimeType: null };
  }

  const extended = message.extendedTextMessage as Record<string, unknown> | undefined;
  if (typeof extended?.text === 'string') {
    return { content: extended.text, type: 'text', media: false, filename: null, mimeType: null };
  }

  const defs = [
    ['imageMessage', 'image', 'صورة'],
    ['videoMessage', 'video', 'فيديو'],
    ['audioMessage', 'audio', 'رسالة صوتية'],
    ['documentMessage', 'document', 'ملف'],
    ['stickerMessage', 'sticker', 'ملصق'],
  ] as const;

  for (const [key, type, label] of defs) {
    const media = message[key] as Record<string, unknown> | undefined;
    if (!media) continue;
    const caption = typeof media.caption === 'string' ? media.caption.trim() : '';
    const filename = typeof media.fileName === 'string' ? media.fileName : null;
    const mimeType = typeof media.mimetype === 'string' ? media.mimetype : null;
    return {
      content: caption || `[${label}${filename ? `: ${filename}` : ''}]`,
      type,
      media: true,
      filename,
      mimeType,
    };
  }

  const contact = message.contactMessage as Record<string, unknown> | undefined;
  if (contact) {
    const display = typeof contact.displayName === 'string' ? contact.displayName : '';
    return { content: display ? `[جهة اتصال: ${display}]` : '[جهة اتصال]', type: 'contact', media: false, filename: null, mimeType: null };
  }

  const location = message.locationMessage as Record<string, unknown> | undefined;
  if (location) {
    return { content: '[موقع]', type: 'location', media: false, filename: null, mimeType: null };
  }

  const button = message.buttonsResponseMessage as Record<string, unknown> | undefined;
  if (button) {
    const value = button.selectedDisplayText ?? button.selectedButtonId;
    return { content: typeof value === 'string' ? value : '[رد زر]', type: 'interactive', media: false, filename: null, mimeType: null };
  }

  const list = message.listResponseMessage as Record<string, unknown> | undefined;
  if (list) {
    const single = list.singleSelectReply as Record<string, unknown> | undefined;
    const value = list.title ?? single?.selectedRowId;
    return { content: typeof value === 'string' ? value : '[رد قائمة]', type: 'interactive', media: false, filename: null, mimeType: null };
  }

  return { content: '[رسالة WhatsApp]', type: String(data.messageType ?? 'unknown'), media: false, filename: null, mimeType: null };
}

function preferredJid(key: Record<string, unknown>): string {
  const primary = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  const alt = typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : '';
  if (primary.endsWith('@s.whatsapp.net')) return primary;
  if (alt.endsWith('@s.whatsapp.net')) return alt;
  return primary || alt;
}

function externalParticipant(jid: string): string {
  if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '');
  return jid;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

function extensionForMime(mime: string | null, fallbackType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  };
  return map[mime ?? ''] ?? fallbackType;
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(raw);
  if (binary.length > MAX_MEDIA_BYTES) throw new Error('media_too_large');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchAndStoreMedia(params: {
  cfg: { baseUrl: string; apiKey: string };
  instance: string;
  workspaceId: string;
  accountId: string;
  messageId: string;
  providerMessage: Record<string, unknown>;
  filename: string | null;
  mimeType: string | null;
  messageType: string;
}): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(
      `${params.cfg.baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(params.instance)}`,
      {
        method: 'POST',
        headers: {
          apikey: params.cfg.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: params.providerMessage, convertToMp4: false }),
      },
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof body.base64 !== 'string') {
      return {
        media_download_error: typeof body.message === 'string' ? body.message : `Evolution media HTTP ${response.status}`,
        provider_message: params.providerMessage,
      };
    }

    const mimeType = typeof body.mimetype === 'string' ? body.mimetype : params.mimeType;
    const bodyName = typeof body.fileName === 'string' ? body.fileName : null;
    const filename = params.filename ?? bodyName ?? `${params.messageId}.${extensionForMime(mimeType, params.messageType)}`;
    const bytes = decodeBase64(body.base64);
    const path = `${params.workspaceId}/${params.accountId}/${params.messageId}/${safeName(filename)}`;
    const { error } = await supabase.storage.from('inbox-media').upload(path, bytes, {
      contentType: mimeType ?? 'application/octet-stream',
      upsert: true,
    });
    if (error) {
      return { media_download_error: error.message, provider_message: params.providerMessage };
    }

    return {
      storage_path: path,
      filename,
      mime_type: mimeType,
      file_size: bytes.byteLength,
    };
  } catch (error) {
    return {
      media_download_error: error instanceof Error ? error.message : 'media_download_failed',
      provider_message: params.providerMessage,
    };
  }
}

async function upsertMessage(params: {
  account: Record<string, unknown>;
  cfg: { baseUrl: string; apiKey: string };
  instance: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const key = (params.data.key ?? {}) as Record<string, unknown>;
  const remoteJid = preferredJid(key);
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const messageId = typeof key.id === 'string' ? key.id : '';
  if (!messageId) return;

  const fromMe = key.fromMe === true;
  const parsed = detectMessage(params.data);
  const workspaceId = String(params.account.workspace_id);
  const accountId = String(params.account.id);
  const participant = externalParticipant(remoteJid);
  const isGroup = remoteJid.endsWith('@g.us');
  const pushName = typeof params.data.pushName === 'string' ? params.data.pushName : null;

  const { data: conversation, error: conversationError } = await supabase
    .from('inbox_conversations')
    .upsert({
      workspace_id: workspaceId,
      account_id: accountId,
      platform: 'whatsapp',
      type: 'dm',
      external_id: remoteJid,
      external_participant_id: remoteJid,
      sender_name: isGroup ? (pushName ?? remoteJid) : (pushName ?? participant),
      snippet: parsed.content,
      unread: !fromMe,
      status: 'open',
      resolved_at: null,
      metadata: {
        provider: 'evolution',
        remote_jid: remoteJid,
        is_group: isGroup,
      },
    }, { onConflict: 'account_id,platform,type,external_id' })
    .select('id')
    .single();

  if (conversationError || !conversation) {
    console.error('conversation upsert failed', conversationError?.message);
    return;
  }

  let mediaMetadata: Record<string, unknown> = {};
  if (parsed.media) {
    mediaMetadata = await fetchAndStoreMedia({
      cfg: params.cfg,
      instance: params.instance,
      workspaceId,
      accountId,
      messageId,
      providerMessage: params.data,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
      messageType: parsed.type,
    });
  }

  const timestamp = typeof params.data.messageTimestamp === 'number'
    ? new Date(params.data.messageTimestamp * 1000).toISOString()
    : new Date().toISOString();

  const { data: inserted, error: messageError } = await supabase
    .from('inbox_messages')
    .upsert({
      workspace_id: workspaceId,
      conversation_id: conversation.id,
      direction: fromMe ? 'outbound' : 'inbound',
      content: parsed.content,
      is_ai: false,
      external_id: messageId,
      sender_external_id: fromMe ? null : participant,
      sender_name: fromMe ? 'أنت' : (pushName ?? participant),
      created_at: timestamp,
      metadata: {
        source: 'evolution_webhook',
        provider: 'evolution',
        message_type: parsed.type,
        remote_jid: remoteJid,
        ...mediaMetadata,
      },
    }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (messageError) {
    console.error('message upsert failed', messageError.message);
    return;
  }

  if (inserted && !fromMe) {
    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      type: 'inbox_new_message',
      title: `رسالة WhatsApp جديدة${pushName ? ` من ${pushName}` : ''}`,
      body: parsed.content.length > 140 ? `${parsed.content.slice(0, 140)}…` : parsed.content,
      payload: { conversation_id: conversation.id, platform: 'whatsapp', inbox_type: 'dm' },
    });
  }
}

function normalizeUpdates(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  if (data && typeof data === 'object') return [data as Record<string, unknown>];
  return [];
}

function deliveryStatus(raw: unknown): string | null {
  const numeric: Record<number, string> = {
    0: 'failed',
    1: 'accepted',
    2: 'sent',
    3: 'delivered',
    4: 'read',
    5: 'read',
  };
  if (typeof raw === 'number') return numeric[raw] ?? null;
  const value = String(raw ?? '').toUpperCase();
  const map: Record<string, string> = {
    ERROR: 'failed',
    PENDING: 'accepted',
    SERVER_ACK: 'sent',
    DELIVERY_ACK: 'delivered',
    READ: 'read',
    PLAYED: 'read',
  };
  return map[value] ?? null;
}

async function applyMessageUpdate(account: Record<string, unknown>, data: unknown): Promise<void> {
  const rank: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 99 };
  for (const update of normalizeUpdates(data)) {
    const key = (update.key ?? {}) as Record<string, unknown>;
    const externalId = typeof key.id === 'string' ? key.id : '';
    const next = deliveryStatus(update.status ?? update.update ?? update.messageUpdate);
    if (!externalId || !next) continue;

    const { data: row } = await supabase.from('inbox_messages')
      .select('id,metadata,conversation_id')
      .eq('workspace_id', account.workspace_id)
      .eq('external_id', externalId)
      .eq('direction', 'outbound')
      .maybeSingle();
    if (!row) continue;

    const previous = typeof row.metadata?.delivery_status === 'string' ? row.metadata.delivery_status : null;
    if (previous && previous !== 'failed' && next !== 'failed' && (rank[previous] ?? -1) > (rank[next] ?? -1)) continue;
    if (previous === 'read' && next === 'failed') continue;

    await supabase.from('inbox_messages').update({
      metadata: {
        ...(row.metadata ?? {}),
        delivery_status: next,
        delivery_status_at: new Date().toISOString(),
        provider_update: update,
      },
    }).eq('id', row.id);

    if (next === 'failed') {
      await supabase.from('notifications').insert({
        workspace_id: account.workspace_id,
        type: 'inbox_delivery_failed',
        title: 'فشل إرسال رسالة WhatsApp',
        body: 'Evolution/WhatsApp أعاد حالة فشل للرسالة.',
        payload: { conversation_id: row.conversation_id, platform: 'whatsapp', external_message_id: externalId },
      });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const payload = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return json(400, { error: 'Invalid JSON' });

  const instance = typeof payload.instance === 'string'
    ? payload.instance
    : typeof (payload.data as Record<string, unknown> | undefined)?.instance === 'string'
      ? String((payload.data as Record<string, unknown>).instance)
      : '';
  if (!instance) return json(200, { ok: true, ignored: true, reason: 'missing_instance' });

  const { data: account } = await supabase.from('social_accounts')
    .select('id,workspace_id,status,metadata')
    .eq('platform', 'whatsapp')
    .contains('metadata', { provider: 'evolution', instance_name: instance })
    .maybeSingle();
  if (!account) return json(200, { ok: true, ignored: true, reason: 'unknown_instance' });

  const { data: secretRow } = await supabase.from('social_account_tokens')
    .select('refresh_token')
    .eq('account_id', account.id)
    .maybeSingle();
  const suppliedSecret = req.headers.get('x-socialpilot-secret') ?? '';
  if (!secretRow?.refresh_token || suppliedSecret !== secretRow.refresh_token) {
    return json(401, { error: 'Invalid webhook secret' });
  }

  const event = String(payload.event ?? '').toLowerCase();
  const data = payload.data;

  try {
    if (event === 'connection.update') {
      const stateData = (data ?? {}) as Record<string, unknown>;
      const state = String(stateData.state ?? 'unknown').toLowerCase();
      const connected = ['open', 'connected'].includes(state);
      const sender = typeof payload.sender === 'string' ? payload.sender : null;
      await supabase.from('social_accounts').update({
        status: connected ? 'connected' : 'error',
        needs_reconnect: !connected,
        ...(sender ? {
          external_id: sender,
          handle: externalParticipant(sender),
          display_name: externalParticipant(sender),
        } : {}),
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...(account.metadata ?? {}),
          provider_state: state,
          onboarding_state: connected ? 'ready' : 'scan_qr',
          status_reason: stateData.statusReason ?? null,
        },
      }).eq('id', account.id);
      return json(200, { ok: true });
    }

    const cfg = await providerConfig();

    if (event === 'messages.upsert' || event === 'send.message') {
      for (const item of normalizeUpdates(data)) {
        await upsertMessage({ account, cfg, instance, data: item });
      }
      return json(200, { ok: true });
    }

    if (event === 'messages.update' || event === 'send.message.update') {
      await applyMessageUpdate(account, data);
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: true, event });
  } catch (error) {
    console.error('whatsapp-evolution-webhook failed', error);
    return json(500, { error: error instanceof Error ? error.message : 'Webhook processing failed' });
  }
});
