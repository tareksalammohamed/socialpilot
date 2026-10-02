import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// inbox-reply
//
// Called by a logged-in workspace member to send a manual reply from the
// unified inbox. Rewritten against the current schema (social_accounts /
// social_account_tokens instead of the old connected_accounts).
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

const GRAPH = 'https://graph.facebook.com/v26.0';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

type Conversation = {
  id: string;
  workspace_id: string;
  account_id: string;
  platform: string;
  type: 'dm' | 'comment';
  external_id: string;
  external_participant_id: string | null;
};

async function getFreshAccessToken(accountId: string): Promise<string> {
  const { data: token } = await supabase
    .from('social_account_tokens')
    .select('access_token, expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!token?.access_token) throw new Error('الحساب محتاج إعادة ربط');
  if (token.expires_at && new Date(token.expires_at).getTime() < Date.now() + 60_000) {
    await supabase.from('social_accounts').update({ status: 'expired', needs_reconnect: true }).eq('id', accountId);
    throw new Error('انتهت صلاحية التوكن — أعد ربط الحساب');
  }
  return String(token.access_token);
}

async function deliverToPlatform(
  conv: Conversation,
  account: Record<string, unknown>,
  content: string,
): Promise<string | null> {
  const accessToken = await getFreshAccessToken(conv.account_id);

  if (conv.platform === 'facebook' || conv.platform === 'instagram') {
    if (conv.type === 'dm') {
      if (!conv.external_participant_id) throw new Error('مفيش معرّف مستقبل لهذه المحادثة — تعذّر إرسال رسالة مباشرة');
      const res = await fetch(`${GRAPH}/me/messages?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: conv.external_participant_id },
          messaging_type: 'RESPONSE',
          message: { text: content },
        }),
      });
      if (!res.ok) throw new Error(`Meta Send API: ${res.status} ${await res.text()}`);
      return (await res.json().catch(() => ({}))).message_id ?? null;
    }
    if (!conv.external_id) throw new Error('مفيش معرّف تعليق لهذه المحادثة — تعذّر الرد على التعليق');
    const endpoint = conv.platform === 'instagram' ? `${GRAPH}/${conv.external_id}/replies` : `${GRAPH}/${conv.external_id}/comments`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content, access_token: accessToken }),
    });
    if (!res.ok) throw new Error(`Meta Comments API: ${res.status} ${await res.text()}`);
    return (await res.json().catch(() => ({}))).id ?? null;
  }

  if (conv.platform === 'linkedin') {
    if (conv.type === 'dm') throw new Error('لينكدإن لا يدعم إرسال رسائل مباشرة عبر الـ API القياسي — رد يدويًا من لينكدإن');
    if (!conv.external_id) throw new Error('مفيش معرّف تعليق لينكدإن — تعذّر الرد');
    const res = await fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(conv.external_id)}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
      body: JSON.stringify({ message: { text: content } }),
    });
    if (!res.ok) throw new Error(`LinkedIn comments: ${res.status} ${await res.text()}`);
    return res.headers.get('x-restli-id');
  }

  if (conv.platform === 'whatsapp') {
    const phoneNumberId = account.external_id as string | undefined;
    if (!phoneNumberId || !conv.external_participant_id) throw new Error('مفيش رقم واتساب أو مستقبل لهذه المحادثة');
    const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: conv.external_participant_id,
        type: 'text',
        text: { preview_url: false, body: content },
      }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const apiError = body.error as Record<string, unknown> | undefined;
      const code = Number(apiError?.code ?? 0);
      if (code === 131047) {
        throw new Error('انتهت نافذة خدمة WhatsApp لمدة 24 ساعة. يلزم إرسال Template معتمد لإعادة فتح المحادثة.');
      }
      const detail = typeof apiError?.message === 'string' ? apiError.message : `HTTP ${res.status}`;
      throw new Error(`WhatsApp Send API: ${detail}`);
    }
    const messages = body.messages as Array<Record<string, unknown>> | undefined;
    return typeof messages?.[0]?.id === 'string' ? messages[0].id : null;
  }

  if (conv.platform === 'telegram') {
    const { data: secretRow } = await supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'telegram').maybeSingle();
    const botToken = secretRow?.app_secret;
    if (!botToken || !conv.external_participant_id) throw new Error('مفيش بوت تيليجرام أو مستقبل لهذه المحادثة');
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: conv.external_participant_id, text: content }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(`Telegram Send API: ${res.status} ${body.description ?? ''}`);
    return body.result?.message_id ? `${conv.external_participant_id}:${body.result.message_id}` : null;
  }

  throw new Error(`الرد التلقائي على منصة "${conv.platform}" غير مدعوم بعد`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return jsonRes(401, { error: 'Missing authentication token' });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return jsonRes(401, { error: 'Invalid or expired token' });
  const userId = userData.user.id;

  let body: { conversationId?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes(400, { error: 'Invalid JSON body' });
  }
  const { conversationId, content } = body;
  if (!conversationId || !content?.trim()) return jsonRes(400, { error: 'conversationId و content مطلوبين' });

  const { data: conv } = await supabase
    .from('inbox_conversations')
    .select('id, workspace_id, account_id, platform, type, external_id, external_participant_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv) return jsonRes(404, { error: 'المحادثة غير موجودة' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', conv.workspace_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) return jsonRes(403, { error: 'مش عضو في مساحة العمل دي' });

  const { data: account } = await supabase.from('social_accounts').select('*').eq('id', conv.account_id).maybeSingle();
  if (!account) return jsonRes(409, { error: 'الحساب المرتبط بهذه المحادثة لم يعد موجودًا' });

  if (conv.platform === 'whatsapp') {
    const { data: latestInbound } = await supabase
      .from('inbox_messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestInbound?.created_at) {
      return jsonRes(409, { error: 'لا توجد رسالة واردة من العميل لفتح نافذة WhatsApp. استخدم Template معتمد لبدء المحادثة.' });
    }
    const windowMs = 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(latestInbound.created_at).getTime() > windowMs) {
      return jsonRes(409, { error: 'مر أكثر من 24 ساعة على آخر رسالة من العميل. يلزم Template معتمد قبل إرسال نص حر.' });
    }
  }

  try {
    const externalMessageId = await deliverToPlatform(conv as Conversation, account, content.trim());

    const { data: message, error: insertError } = await supabase
      .from('inbox_messages')
      .insert({
        workspace_id: conv.workspace_id,
        conversation_id: conversationId,
        direction: 'outbound',
        content: content.trim(),
        is_ai: false,
        user_id: userId,
        ...(externalMessageId ? { external_id: externalMessageId } : {}),
        metadata: {
          source: 'inbox_reply',
          ...(conv.platform === 'whatsapp' ? {
            delivery_status: 'accepted',
            delivery_status_at: new Date().toISOString(),
          } : {}),
        },
      })
      .select()
      .single();
    if (insertError) throw insertError;

    await supabase.from('inbox_conversations').update({ snippet: content.trim(), unread: false }).eq('id', conversationId);

    return jsonRes(200, { ok: true, message });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل إرسال الرد';
    return jsonRes(502, { error: message });
  }
});

