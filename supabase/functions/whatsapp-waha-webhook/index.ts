import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-SocialPilot-Secret, X-Webhook-Hmac, X-Webhook-Hmac-Algorithm',
};
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

type ProviderConfig = {
  baseUrl: string;
  credential: string;
  enabled: boolean;
  priority: number;
  status: 'not_configured' | 'connected' | 'error';
};

type ProviderBundle = {
  version: 1;
  activeProvider: 'evolution' | 'waha' | 'wppconnect' | null;
  providers: Partial<Record<'evolution' | 'waha' | 'wppconnect', ProviderConfig>>;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

function participantFromJid(jid: string): string {
  return jid.replace(/@(c|s\.whatsapp)\.us$/i, '');
}

function mediaType(mime: string | null): string {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function ackStatus(payload: Record<string, unknown>): string | null {
  const numeric = Number(payload.ack);
  if (Number.isFinite(numeric)) {
    if (numeric < 0) return 'failed';
    if (numeric === 0) return 'accepted';
    if (numeric === 1) return 'sent';
    if (numeric === 2) return 'delivered';
    if (numeric >= 3) return 'read';
  }
  const name = String(payload.ackName ?? '').toUpperCase();
  if (name === 'ERROR') return 'failed';
  if (name === 'PENDING') return 'accepted';
  if (name === 'SERVER') return 'sent';
  if (name === 'DEVICE') return 'delivered';
  if (name === 'READ' || name === 'PLAYED') return 'read';
  return null;
}

function parseBundle(raw: string): ProviderBundle {
  const parsed = JSON.parse(raw) as ProviderBundle;
  if (parsed?.version !== 1 || !parsed.providers) throw new Error('Invalid WhatsApp provider registry');
  return parsed;
}

async function wahaConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const { data: secret } = await supabase.from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'whatsapp')
    .maybeSingle();
  if (!secret?.app_secret) throw new Error('WhatsApp provider registry missing');
  const bundle = parseBundle(String(secret.app_secret));
  const config = bundle.providers.waha;
  if (!config?.enabled || config.status !== 'connected' || !config.baseUrl || !config.credential) {
    throw new Error('WAHA provider is unavailable');
  }
  return {
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    apiKey: config.credential,
  };
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let value = 0;
  for (let i = 0; i < left.length; i += 1) value |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return value === 0;
}

async function verifyHmac(rawBody: string, secret: string, expected: string | null): Promise<boolean> {
  if (!expected) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const actual = Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return constantTimeEquals(actual.toLowerCase(), expected.trim().toLowerCase());
}

function normalizeMediaUrl(url: string, baseUrl: string): string {
  try {
    const media = new URL(url);
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(media.hostname)) {
      const base = new URL(baseUrl);
      media.protocol = base.protocol;
      media.host = base.host;
    }
    return media.toString();
  } catch {
    return url.startsWith('/') ? `${baseUrl}${url}` : url;
  }
}

async function storeMedia(params: {
  accountId: string;
  workspaceId: string;
  messageId: string;
  media: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const cfg = await wahaConfig();
  const urlValue = typeof params.media.url === 'string' ? params.media.url : '';
  const mime = typeof params.media.mimetype === 'string' ? params.media.mimetype : null;
  const filename = typeof params.media.filename === 'string' && params.media.filename
    ? params.media.filename
    : `${params.messageId}.${mediaType(mime)}`;

  if (!urlValue) {
    return {
      filename,
      mime_type: mime,
      media_download_error: typeof params.media.error === 'string' ? params.media.error : 'waha_media_url_missing',
    };
  }

  try {
    const response = await fetch(normalizeMediaUrl(urlValue, cfg.baseUrl), {
      headers: { 'X-Api-Key': cfg.apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { filename, mime_type: mime, media_download_error: `WAHA media HTTP ${response.status}` };

    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_MEDIA_BYTES) return { filename, mime_type: mime, media_download_error: 'media_too_large' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_BYTES) return { filename, mime_type: mime, media_download_error: 'media_too_large' };

    const contentType = response.headers.get('content-type') || mime || 'application/octet-stream';
    const path = `${params.workspaceId}/${params.accountId}/${params.messageId}/${safeName(filename)}`;
    const { error } = await supabase.storage.from('inbox-media').upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (error) return { filename, mime_type: contentType, media_download_error: error.message };

    return {
      storage_path: path,
      filename,
      mime_type: contentType,
      file_size: bytes.byteLength,
    };
  } catch (error) {
    return {
      filename,
      mime_type: mime,
      media_download_error: error instanceof Error ? error.message : 'waha_media_download_failed',
    };
  }
}

async function upsertInbound(account: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
  const messageId = typeof payload.id === 'string' ? payload.id : '';
  const from = typeof payload.from === 'string' ? payload.from : '';
  if (!messageId || !from || from === 'status@broadcast') return;

  const fromMe = payload.fromMe === true;
  if (fromMe) return;

  const workspaceId = String(account.workspace_id);
  const accountId = String(account.id);
  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  const media = payload.media as Record<string, unknown> | undefined;
  const hasMedia = payload.hasMedia === true || Boolean(media);
  const mime = typeof media?.mimetype === 'string' ? media.mimetype : null;
  const filename = typeof media?.filename === 'string' ? media.filename : null;
  const type = hasMedia ? mediaType(mime) : 'text';
  const content = body || (hasMedia
    ? `[${type === 'image' ? 'صورة' : type === 'video' ? 'فيديو' : type === 'audio' ? 'رسالة صوتية' : 'ملف'}${filename ? `: ${filename}` : ''}]`
    : '[رسالة WhatsApp]');
  const isGroup = from.endsWith('@g.us');
  const senderName = typeof payload.notifyName === 'string'
    ? payload.notifyName
    : typeof payload.pushName === 'string'
      ? payload.pushName
      : participantFromJid(from);

  const { data: conversation, error: conversationError } = await supabase.from('inbox_conversations').upsert({
    workspace_id: workspaceId,
    account_id: accountId,
    platform: 'whatsapp',
    type: 'dm',
    external_id: from,
    external_participant_id: from,
    sender_name: senderName,
    snippet: content,
    unread: true,
    status: 'open',
    resolved_at: null,
    metadata: {
      provider: 'waha',
      remote_jid: from,
      is_group: isGroup,
    },
  }, { onConflict: 'account_id,platform,type,external_id' }).select('id').single();

  if (conversationError || !conversation) {
    console.error('WAHA conversation upsert failed', conversationError?.message);
    return;
  }

  const mediaMetadata = hasMedia && media
    ? await storeMedia({ accountId, workspaceId, messageId, media })
    : {};

  const timestamp = typeof payload.timestamp === 'number'
    ? new Date(payload.timestamp * 1000).toISOString()
    : new Date().toISOString();

  const { data: inserted, error: messageError } = await supabase.from('inbox_messages').upsert({
    workspace_id: workspaceId,
    conversation_id: conversation.id,
    direction: 'inbound',
    content,
    is_ai: false,
    external_id: messageId,
    sender_external_id: participantFromJid(from),
    sender_name: senderName,
    created_at: timestamp,
    metadata: {
      source: 'waha_webhook',
      provider: 'waha',
      message_type: type,
      remote_jid: from,
      ack: payload.ack ?? null,
      ack_name: payload.ackName ?? null,
      ...mediaMetadata,
    },
  }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true }).select('id').maybeSingle();

  if (messageError) {
    console.error('WAHA message upsert failed', messageError.message);
    return;
  }

  if (inserted) {
    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      type: 'inbox_new_message',
      title: `رسالة WhatsApp جديدة من ${senderName}`,
      body: content.length > 140 ? `${content.slice(0, 140)}…` : content,
      payload: { conversation_id: conversation.id, platform: 'whatsapp', inbox_type: 'dm' },
    });
  }
}

async function applyAck(account: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
  const externalId = typeof payload.id === 'string' ? payload.id : '';
  const next = ackStatus(payload);
  if (!externalId || !next) return;

  const { data: row } = await supabase.from('inbox_messages')
    .select('id,metadata,conversation_id')
    .eq('workspace_id', account.workspace_id)
    .eq('external_id', externalId)
    .eq('direction', 'outbound')
    .maybeSingle();
  if (!row) return;

  const rank: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 };
  const previous = typeof row.metadata?.delivery_status === 'string' ? row.metadata.delivery_status : null;
  if (next !== 'failed' && previous && (rank[previous] ?? -1) > (rank[next] ?? -1)) return;
  if (previous === 'read' && next === 'failed') return;

  await supabase.from('inbox_messages').update({
    metadata: {
      ...(row.metadata ?? {}),
      delivery_status: next,
      delivery_status_at: new Date().toISOString(),
      provider_update: payload,
    },
  }).eq('id', row.id);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const raw = await req.text();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const session = typeof event.session === 'string' ? event.session : '';
  if (!session) return json(200, { ok: true, ignored: true, reason: 'missing_session' });

  const { data: account } = await supabase.from('social_accounts')
    .select('id,workspace_id,status,metadata')
    .eq('platform', 'whatsapp')
    .contains('metadata', { provider: 'waha', instance_name: session })
    .maybeSingle();
  if (!account) return json(200, { ok: true, ignored: true, reason: 'unknown_session' });

  const { data: tokenRow } = await supabase.from('social_account_tokens')
    .select('refresh_token')
    .eq('account_id', account.id)
    .maybeSingle();
  const secret = typeof tokenRow?.refresh_token === 'string' ? tokenRow.refresh_token : '';
  if (!secret) return json(401, { error: 'Webhook secret missing' });

  const customSecret = req.headers.get('x-socialpilot-secret') ?? '';
  const hmac = req.headers.get('x-webhook-hmac');
  const algorithm = (req.headers.get('x-webhook-hmac-algorithm') ?? '').toLowerCase();
  const hmacValid = algorithm === 'sha512' ? await verifyHmac(raw, secret, hmac) : false;
  if (!constantTimeEquals(customSecret, secret) || !hmacValid) {
    return json(401, { error: 'Invalid WAHA webhook signature' });
  }

  const eventName = String(event.event ?? '').toLowerCase();
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  try {
    if (eventName === 'session.status') {
      const state = String(payload.status ?? payload.state ?? 'unknown').toUpperCase();
      const connected = state === 'WORKING';
      const me = (payload.me ?? event.me ?? {}) as Record<string, unknown>;
      const meId = typeof me.id === 'string' ? me.id : null;
      const pushName = typeof me.pushName === 'string' ? me.pushName : null;
      await supabase.from('social_accounts').update({
        status: connected ? 'connected' : 'error',
        needs_reconnect: !connected,
        ...(meId ? { external_id: meId, handle: participantFromJid(meId) } : {}),
        ...(pushName ? { display_name: pushName } : {}),
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...(account.metadata ?? {}),
          provider_state: state,
          onboarding_state: connected ? 'ready' : 'scan_qr',
        },
      }).eq('id', account.id);
      return json(200, { ok: true });
    }

    if (eventName === 'message') {
      await upsertInbound(account, payload);
      return json(200, { ok: true });
    }

    if (eventName === 'message.ack') {
      await applyAck(account, payload);
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: true, event: eventName });
  } catch (error) {
    console.error('whatsapp-waha-webhook failed', error);
    return json(500, { error: error instanceof Error ? error.message : 'WAHA webhook failed' });
  }
});
