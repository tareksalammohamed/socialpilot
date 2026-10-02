import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Bot-Api-Secret-Token',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function webhookSecret(botToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function messageText(message: Record<string, unknown>): string | null {
  if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
  if (typeof message.caption === 'string' && message.caption.trim()) return message.caption.trim();
  if (Array.isArray(message.photo) && message.photo.length > 0) return '[صورة]';
  if (message.video) return '[فيديو]';
  if (message.voice) return '[رسالة صوتية]';
  if (message.audio) return '[ملف صوتي]';
  const document = message.document as Record<string, unknown> | undefined;
  if (document) return `[ملف${typeof document.file_name === 'string' ? `: ${document.file_name}` : ''}]`;
  if (message.sticker) return '[ملصق]';
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { data: secretRow } = await supabase
    .from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'telegram')
    .maybeSingle();
  const botToken = secretRow?.app_secret as string | undefined;
  if (!botToken) return jsonResponse({ error: 'Telegram bot is not configured' }, 503);

  const expectedSecret = await webhookSecret(botToken);
  const suppliedSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!suppliedSecret || suppliedSecret !== expectedSecret) return jsonResponse({ error: 'Invalid webhook secret' }, 401);

  const update = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!update) return jsonResponse({ error: 'Invalid JSON' }, 400);

  const message = (
    update.business_message
    ?? update.message
    ?? update.edited_message
  ) as Record<string, unknown> | undefined;
  if (!message) return jsonResponse({ ok: true, ignored: true });

  const from = message.from as Record<string, unknown> | undefined;
  if (from?.is_bot === true) return jsonResponse({ ok: true, ignored: true });

  const chat = message.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id;
  const messageId = message.message_id;
  const content = messageText(message);
  if ((typeof chatId !== 'number' && typeof chatId !== 'string') || typeof messageId !== 'number' || !content) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const numericChatId = typeof chatId === 'string' ? Number(chatId) : chatId;
  const { data: accounts, error: accountError } = await supabase
    .from('social_accounts')
    .select('id, workspace_id, platform, display_name')
    .eq('platform', 'telegram')
    .eq('status', 'connected')
    .contains('metadata', { chat_id: numericChatId })
    .limit(10);
  if (accountError) return jsonResponse({ error: accountError.message }, 500);
  if (!accounts?.length) return jsonResponse({ ok: true, ignored: true, reason: 'chat_not_connected' });

  const senderId = from?.id != null ? String(from.id) : String(chatId);
  const senderName = [
    typeof from?.first_name === 'string' ? from.first_name : '',
    typeof from?.last_name === 'string' ? from.last_name : '',
  ].filter(Boolean).join(' ')
    || (typeof from?.username === 'string' ? `@${from.username}` : null)
    || (typeof chat?.title === 'string' ? chat.title : null);
  const createdAt = typeof message.date === 'number'
    ? new Date(message.date * 1000).toISOString()
    : new Date().toISOString();

  for (const account of accounts) {
    const { data: conversation, error: conversationError } = await supabase
      .from('inbox_conversations')
      .upsert({
        workspace_id: account.workspace_id,
        account_id: account.id,
        platform: 'telegram',
        type: 'dm',
        external_id: senderId,
        external_participant_id: String(chatId),
        sender_name: senderName,
        snippet: content,
        unread: true,
        status: 'open',
        resolved_at: null,
        metadata: { source: 'telegram_webhook', chat_id: chatId, chat_type: chat?.type ?? null },
      }, { onConflict: 'account_id,platform,type,external_id' })
      .select('id')
      .single();

    if (conversationError || !conversation) {
      console.error('telegram-inbox-webhook conversation upsert failed', conversationError?.message);
      continue;
    }

    const externalId = `${chatId}:${messageId}`;
    const { data: insertedMessage, error: messageError } = await supabase
      .from('inbox_messages')
      .upsert({
        workspace_id: account.workspace_id,
        conversation_id: conversation.id,
        direction: 'inbound',
        content,
        is_ai: false,
        external_id: externalId,
        sender_external_id: senderId,
        sender_name: senderName,
        created_at: createdAt,
        metadata: { source: 'telegram_webhook', update_id: update.update_id ?? null },
      }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true })
      .select('id')
      .maybeSingle();

    if (messageError) {
      console.error('telegram-inbox-webhook message insert failed', messageError.message);
      continue;
    }

    if (insertedMessage) {
      await supabase.from('notifications').insert({
        workspace_id: account.workspace_id,
        type: 'inbox_new_message',
        title: `رسالة جديدة على تيليجرام${senderName ? ` من ${senderName}` : ''}`,
        body: content.length > 140 ? `${content.slice(0, 140)}…` : content,
        payload: { conversation_id: conversation.id, platform: 'telegram', inbox_type: 'dm' },
      });
    }
  }

  return jsonResponse({ ok: true });
});
