import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function mediaKind(file: File): 'image' | 'video' | 'audio' | 'document' {
  if (['image/jpeg', 'image/png'].includes(file.type)) return 'image';
  if (['video/mp4', 'video/3gpp'].includes(file.type)) return 'video';
  if ([
    'audio/aac',
    'audio/amr',
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
  ].includes(file.type)) return 'audio';
  return 'document';
}

function displayContent(kind: string, filename: string, caption: string): string {
  if (caption) return caption;
  const labels: Record<string, string> = {
    image: 'صورة',
    video: 'فيديو',
    audio: 'ملف صوتي',
    document: 'ملف',
  };
  return `[${labels[kind] ?? 'مرفق'}: ${filename}]`;
}

async function evolutionConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps').select('app_id,enabled').eq('platform_key', 'whatsapp').maybeSingle(),
    supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'whatsapp').maybeSingle(),
  ]);
  if (!app?.enabled || !app.app_id || !secret?.app_secret) throw new Error('Evolution WhatsApp provider غير مُعد');
  return { baseUrl: String(app.app_id).trim().replace(/\/+$/, ''), apiKey: String(secret.app_secret) };
}

function recipient(value: string): string {
  return value.endsWith('@s.whatsapp.net') ? value.replace('@s.whatsapp.net', '') : value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

async function sendEvolutionMedia(params: {
  account: Record<string, unknown>;
  to: string;
  file: File;
  kind: 'image' | 'video' | 'audio' | 'document';
  caption: string;
}): Promise<{ externalId: string | null; storagePath: string | null }> {
  const metadata = (params.account.metadata ?? {}) as Record<string, unknown>;
  const instance = typeof metadata.instance_name === 'string' ? metadata.instance_name : '';
  if (!instance) throw new Error('جلسة Evolution غير موجودة');
  const cfg = await evolutionConfig();

  const bytes = new Uint8Array(await params.file.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  const response = await fetch(`${cfg.baseUrl}/message/sendMedia/${encodeURIComponent(instance)}`, {
    method: 'POST',
    headers: { apikey: cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: recipient(params.to),
      mediatype: params.kind,
      mimetype: params.file.type || 'application/octet-stream',
      media: base64,
      caption: params.caption || undefined,
      fileName: params.file.name || 'attachment',
      filename: params.file.name || 'attachment',
      delay: 700,
    }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const nested = body.response as Record<string, unknown> | undefined;
    const message = nested?.message ?? body.message ?? body.error;
    throw new Error(typeof message === 'string' ? message : `Evolution sendMedia HTTP ${response.status}`);
  }

  const key = body.key as Record<string, unknown> | undefined;
  const externalId = typeof key?.id === 'string' ? key.id : typeof body.id === 'string' ? body.id : null;
  const accountId = String(params.account.id ?? 'unknown');
  const messageKey = externalId || crypto.randomUUID();
  const path = `${params.account.workspace_id}/${accountId}/outbound-${messageKey}/${safeName(params.file.name || 'attachment')}`;
  const { error: storageError } = await supabase.storage.from('inbox-media').upload(path, bytes, {
    contentType: params.file.type || 'application/octet-stream',
    upsert: true,
  });

  return { externalId, storagePath: storageError ? null : path };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth.user) return json(401, { error: 'Unauthorized' });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: 'تعذّر قراءة الملف المرفق' });
  }

  const conversationId = String(form.get('conversationId') ?? '').trim();
  const caption = String(form.get('caption') ?? '').trim().slice(0, 1024);
  const file = form.get('file');
  if (!conversationId || !(file instanceof File)) {
    return json(400, { error: 'conversationId و file مطلوبين' });
  }
  if (file.size <= 0) return json(400, { error: 'الملف فارغ' });
  if (file.size > MAX_FILE_BYTES) return json(413, { error: 'الحد الأقصى للمرفق داخل SocialPilot هو 15MB' });

  const kind = mediaKind(file);
  if (kind === 'image' && file.size > IMAGE_MAX_BYTES) {
    return json(413, { error: 'صور WhatsApp يجب ألا تتجاوز 5MB' });
  }

  const { data: conversation } = await supabase
    .from('inbox_conversations')
    .select('id,workspace_id,account_id,platform,type,external_participant_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation) return json(404, { error: 'المحادثة غير موجودة' });
  if (conversation.platform !== 'whatsapp' || conversation.type !== 'dm') {
    return json(400, { error: 'إرسال المرفقات متاح لمحادثات WhatsApp المباشرة فقط' });
  }
  if (!conversation.external_participant_id) {
    return json(409, { error: 'لا يوجد مستقبل لهذه المحادثة' });
  }

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', conversation.workspace_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!membership) return json(403, { error: 'Forbidden' });

  const { data: account } = await supabase
    .from('social_accounts')
    .select('id,workspace_id,external_id,metadata')
    .eq('id', conversation.account_id)
    .maybeSingle();
  if (!account) return json(409, { error: 'حساب WhatsApp لم يعد موجودًا' });

  const provider = String((account.metadata as Record<string, unknown> | null)?.provider ?? 'meta');
  if (provider === 'evolution') {
    try {
      const sent = await sendEvolutionMedia({
        account,
        to: conversation.external_participant_id,
        file,
        kind,
        caption,
      });
      const content = displayContent(kind, file.name || 'attachment', caption);
      const { data: message, error: messageError } = await supabase
        .from('inbox_messages')
        .insert({
          workspace_id: conversation.workspace_id,
          conversation_id: conversationId,
          direction: 'outbound',
          content,
          is_ai: false,
          user_id: auth.user.id,
          ...(sent.externalId ? { external_id: sent.externalId } : {}),
          metadata: {
            source: 'inbox_media_send',
            provider: 'evolution',
            message_type: kind,
            storage_path: sent.storagePath,
            mime_type: file.type || 'application/octet-stream',
            filename: file.name || null,
            file_size: file.size,
            caption: caption || null,
            delivery_status: 'accepted',
            delivery_status_at: new Date().toISOString(),
          },
        })
        .select()
        .single();
      if (messageError || !message) return json(500, { error: messageError?.message ?? 'تم الإرسال لكن تعذّر حفظ الرسالة' });
      await supabase.from('inbox_conversations').update({
        snippet: content,
        unread: false,
        updated_at: new Date().toISOString(),
      }).eq('id', conversationId);
      return json(200, { ok: true, message });
    } catch (error) {
      return json(502, { error: error instanceof Error ? error.message : 'تعذّر إرسال المرفق عبر Evolution' });
    }
  }

  const { data: latestInbound } = await supabase
    .from('inbox_messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestInbound?.created_at || Date.now() - new Date(latestInbound.created_at).getTime() > 24 * 60 * 60 * 1000) {
    return json(409, { error: 'نافذة WhatsApp لمدة 24 ساعة مغلقة. استخدم Template معتمد بدل المرفق الحر.' });
  }

  const { data: tokenRow } = await supabase.from('social_account_tokens')
    .select('access_token,expires_at')
    .eq('account_id', conversation.account_id)
    .maybeSingle();
  const phoneNumberId = account.external_id as string | undefined;
  const accessToken = tokenRow?.access_token as string | undefined;
  if (!phoneNumberId || !accessToken) return json(409, { error: 'حساب WhatsApp يحتاج إعادة ربط' });
  if (tokenRow?.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now() + 60_000) {
    return json(409, { error: 'انتهت صلاحية WhatsApp — أعد ربط الحساب' });
  }

  const uploadForm = new FormData();
  uploadForm.append('messaging_product', 'whatsapp');
  uploadForm.append('type', file.type || 'application/octet-stream');
  uploadForm.append('file', file, file.name || 'attachment');

  const uploadResponse = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: uploadForm,
  });
  const uploadBody = await uploadResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!uploadResponse.ok || typeof uploadBody.id !== 'string') {
    const apiError = uploadBody.error as Record<string, unknown> | undefined;
    return json(uploadResponse.status, {
      error: typeof apiError?.message === 'string' ? apiError.message : 'تعذّر رفع المرفق إلى WhatsApp',
    });
  }

  const mediaObject: Record<string, unknown> = { id: uploadBody.id };
  if (caption && kind !== 'audio') mediaObject.caption = caption;
  if (kind === 'document') mediaObject.filename = file.name || 'document';

  const sendResponse = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: conversation.external_participant_id,
      type: kind,
      [kind]: mediaObject,
    }),
  });
  const sendBody = await sendResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!sendResponse.ok) {
    const apiError = sendBody.error as Record<string, unknown> | undefined;
    return json(sendResponse.status, {
      error: typeof apiError?.message === 'string' ? apiError.message : 'تعذّر إرسال المرفق على WhatsApp',
    });
  }

  const externalId = Array.isArray(sendBody.messages)
    ? (sendBody.messages[0] as Record<string, unknown> | undefined)?.id
    : null;
  const content = displayContent(kind, file.name || 'attachment', caption);

  const { data: message, error: messageError } = await supabase
    .from('inbox_messages')
    .insert({
      workspace_id: conversation.workspace_id,
      conversation_id: conversationId,
      direction: 'outbound',
      content,
      is_ai: false,
      user_id: auth.user.id,
      ...(typeof externalId === 'string' ? { external_id: externalId } : {}),
      metadata: {
        source: 'inbox_media_send',
        message_type: kind,
        media_id: uploadBody.id,
        mime_type: file.type || 'application/octet-stream',
        filename: file.name || null,
        file_size: file.size,
        caption: caption || null,
        delivery_status: 'accepted',
        delivery_status_at: new Date().toISOString(),
      },
    })
    .select()
    .single();
  if (messageError || !message) {
    return json(500, { error: messageError?.message ?? 'تم الإرسال لكن تعذّر حفظ الرسالة داخل Inbox' });
  }

  await supabase
    .from('inbox_conversations')
    .update({ snippet: content, unread: false, updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  return json(200, { ok: true, message });
});
