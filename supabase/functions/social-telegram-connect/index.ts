import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// تيليجرام مالوش OAuth تفاعلي زي فيسبوك/إنستجرام/لينكدإن. الربط بيتم عن طريق
// بوت واحد مشترك (Bot Token يتحط من الـ Super Admin في social-platform-admin،
// platform_key = 'telegram'). أي عضو مساحة عمل بيضيف نفس البوت كـ Admin على
// قناته، وبعدين بيبعت يوزر القناة هنا، إحنا بنتحقق من صلاحيات البوت فعليًا
// عن طريق Telegram Bot API قبل ما نسجّل الحساب كمربوط.
//
// Actions:
//   - get_bot_info  -> أي عضو مسجّل الدخول: بيرجّع يوزر البوت (بدون السر) عشان
//                      يعرف يضيفه على قناته.
//   - connect       -> يتحقق إن البوت أدمن في القناة المطلوبة، ويسجّل/يحدّث
//                      صف social_accounts.
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function normalizeUsername(input: string): string {
  const trimmed = input.trim().replace(/^https?:\/\/t\.me\//i, '');
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

type TelegramApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; description?: string; error_code?: number };

async function callTelegramApi<T>(botToken: string, method: string, params: Record<string, string>): Promise<TelegramApiResult<T>> {
  const url = `https://api.telegram.org/bot${botToken}/${method}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  return (await res.json()) as TelegramApiResult<T>;
}

async function telegramWebhookSecret(botToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureInboxWebhook(botToken: string): Promise<void> {
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!supabaseUrl) throw new Error('SUPABASE_URL is missing');
  const secretToken = await telegramWebhookSecret(botToken);
  const result = await callTelegramApi<true>(botToken, 'setWebhook', {
    url: `${supabaseUrl}/functions/v1/telegram-inbox-webhook`,
    secret_token: secretToken,
    allowed_updates: JSON.stringify(['message', 'edited_message', 'business_message']),
  });
  if (!result.ok) throw new Error(result.description ?? 'تعذّر تفعيل Telegram Inbox webhook');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return jsonRes(401, { error: 'Missing authentication token' });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return jsonRes(401, { error: 'Invalid or expired token' });
  const userId = userData.user.id;

  let body: { action?: string; workspaceId?: string; channelUsername?: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes(400, { error: 'Invalid JSON body' });
  }

  const { data: appRow } = await supabase
    .from('social_platform_apps')
    .select('app_id, enabled')
    .eq('platform_key', 'telegram')
    .maybeSingle();

  if (body.action === 'get_bot_info') {
    if (!appRow?.app_id) return jsonRes(200, { configured: false });
    return jsonRes(200, { configured: true, enabled: !!appRow.enabled, botUsername: appRow.app_id });
  }

  // ---- action: connect ----
  const workspaceId = body.workspaceId;
  const rawUsername = body.channelUsername;
  if (!workspaceId) return jsonRes(400, { error: 'workspaceId is required' });
  if (!rawUsername || rawUsername.trim().length < 2) return jsonRes(400, { error: 'يوزر القناة مطلوب' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) return jsonRes(403, { error: 'مش عضو في مساحة العمل دي' });

  if (!appRow?.enabled || !appRow.app_id) {
    return jsonRes(400, { error: 'بوت تيليجرام لسه مش مُفعّل من إدارة النظام' });
  }

  const { data: secretRow } = await supabase
    .from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'telegram')
    .maybeSingle();
  const botToken = secretRow?.app_secret;
  if (!botToken) return jsonRes(400, { error: 'بوت تيليجرام لسه مش مُعد من إدارة النظام' });

  const chatId = normalizeUsername(rawUsername);

  try {
    const meRes = await callTelegramApi<{ id: number; username?: string }>(botToken, 'getMe', {});
    if (!meRes.ok) return jsonRes(500, { error: 'تعذّر التحقق من البوت — راجع إعدادات التوكن' });
    const botId = meRes.result.id;

    const chatRes = await callTelegramApi<{ id: number; type: string; title?: string; username?: string }>(
      botToken,
      'getChat',
      { chat_id: chatId }
    );
    if (!chatRes.ok) {
      return jsonRes(400, {
        error: `تعذّر إيجاد القناة (${chatId}) — تأكد من اليوزر وإن القناة عامة، وإن البوت @${meRes.result.username ?? ''} مضاف عليها`,
      });
    }
    const chat = chatRes.result;
    if (chat.type !== 'channel' && chat.type !== 'supergroup') {
      return jsonRes(400, { error: 'الربط متاح للقنوات (channels) أو السوبرجروب بس حاليًا' });
    }

    const memberRes = await callTelegramApi<{ status: string; can_post_messages?: boolean }>(
      botToken,
      'getChatMember',
      { chat_id: chatId, user_id: String(botId) }
    );
    if (!memberRes.ok) {
      return jsonRes(400, { error: 'تعذّر التحقق من صلاحيات البوت في القناة دي' });
    }
    const status = memberRes.result.status;
    if (status !== 'administrator' && status !== 'creator') {
      return jsonRes(400, {
        error: `لازم تضيف @${meRes.result.username ?? 'البوت'} كـ Admin في القناة الأول، وبعدين تجرّب تاني`,
      });
    }
    if (status === 'administrator' && memberRes.result.can_post_messages === false) {
      return jsonRes(400, { error: 'البوت أدمن بس مش معاه صلاحية النشر — فعّل "Post Messages" له من إعدادات القناة' });
    }

    const { data: account, error: upsertError } = await supabase
      .from('social_accounts')
      .upsert(
        {
          workspace_id: workspaceId,
          platform: 'telegram',
          handle: chat.username ? `@${chat.username}` : chatId,
          display_name: chat.title ?? chat.username ?? chatId,
          status: 'connected',
          needs_reconnect: false,
          metadata: { chat_id: chat.id, chat_type: chat.type },
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id,platform' }
      )
      .select('*')
      .maybeSingle();

    if (upsertError) return jsonRes(500, { error: upsertError.message });

    await ensureInboxWebhook(botToken);
    return jsonRes(200, { ok: true, account, inboxWebhook: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return jsonRes(500, { error: message });
  }
});
