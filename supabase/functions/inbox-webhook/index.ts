import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// inbox-webhook
//
// Rewritten against the current schema (social_accounts / social_account_tokens
// / social_platform_app_secrets / inbox_conversations / inbox_messages). The
// previous version of this function (still visible in version history)
// targeted a schema that no longer exists (connected_accounts,
// platform_credentials, post_platform_targets, brand_voice, activity,
// inbox_automation_rules) and could not write anything to the database.
//
// This version covers the receiving half only: Meta's webhook verification
// handshake (GET) and event delivery (POST) for Facebook/Instagram DMs and
// comments, and WhatsApp Business messages. It stores everything in
// inbox_conversations / inbox_messages, and raises a notification row for
// every new inbound message/comment so the in-app notification center and
// push (send-push) can pick it up. Auto-reply automation (AI-drafted or
// auto-sent replies) is intentionally NOT included in this pass — the tables
// it depended on (inbox_automation_rules, brand_voice) don't exist yet
// either; add that as a follow-up once the base inbox is confirmed working.
//
// Register this URL as the Meta Webhook callback URL, with
// META_WEBHOOK_VERIFY_TOKEN (below) as the verify token, and META_APP_SECRET
// so signatures can be checked.
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Signature-256',
};

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: corsHeaders });
}

function safeWebhookDate(value: unknown): string | null {
  if (typeof value === 'number') return new Date(value > 1e10 ? value : value * 1000).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

async function verifySignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expectedHex = signatureHeader.slice('sha256='.length);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (computedHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

type Account = { id: string; workspace_id: string; platform: string };

async function findAccounts(supabase: ReturnType<typeof createClient>, providerAccountId: string): Promise<Account[]> {
  // external_id holds the Meta page id / phone_number_id depending on
  // platform, matching how social-oauth-callback populates it at connect time.
  const { data, error } = await supabase
    .from('social_accounts')
    .select('id, workspace_id, platform')
    .in('platform', ['facebook', 'instagram', 'whatsapp'])
    .eq('external_id', providerAccountId)
    .eq('status', 'connected')
    .limit(50);
  if (error) throw error;
  return (data ?? []) as Account[];
}

type UpsertInput = {
  account_id: string;
  workspace_id: string;
  platform: string;
  type: 'dm' | 'comment';
  external_id: string;
  external_participant_id: string | null;
  sender_name: string | null;
  content: string;
  message_external_id: string;
  created_at: string | null;
  metadata?: Record<string, unknown>;
};

async function notifyNewMessage(
  supabase: ReturnType<typeof createClient>,
  input: { workspace_id: string; conversation_id: string; platform: string; type: 'dm' | 'comment'; sender_name: string | null; content: string },
): Promise<void> {
  const kind = input.type === 'comment' ? 'تعليق جديد' : 'رسالة جديدة';
  const who = input.sender_name ? ` من ${input.sender_name}` : '';
  const snippet = input.content.length > 140 ? `${input.content.slice(0, 140)}…` : input.content;
  const { error } = await supabase.from('notifications').insert({
    workspace_id: input.workspace_id,
    type: input.type === 'comment' ? 'inbox_new_comment' : 'inbox_new_message',
    title: `${kind}${who} على ${input.platform}`,
    body: snippet,
    payload: { conversation_id: input.conversation_id, platform: input.platform, inbox_type: input.type },
  });
  if (error) console.error('inbox-webhook: failed to write notification', error.message);
}

async function upsertConversationAndMessage(
  supabase: ReturnType<typeof createClient>,
  input: UpsertInput,
): Promise<{ conversationId: string; isNewMessage: boolean } | null> {
  const { data: conv, error: convError } = await supabase
    .from('inbox_conversations')
    .upsert(
      {
        workspace_id: input.workspace_id,
        account_id: input.account_id,
        platform: input.platform,
        type: input.type,
        external_id: input.external_id,
        sender_name: input.sender_name,
        external_participant_id: input.external_participant_id,
        snippet: input.content,
        unread: true,
        status: 'open',
        resolved_at: null,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      { onConflict: 'account_id,platform,type,external_id' },
    )
    .select('id')
    .single();
  if (convError || !conv) {
    console.error('inbox-webhook: failed to upsert conversation', convError?.message);
    return null;
  }

  const { data: existingMessage } = await supabase
    .from('inbox_messages')
    .select('id')
    .eq('conversation_id', conv.id)
    .eq('external_id', input.message_external_id)
    .maybeSingle();
  if (existingMessage) return { conversationId: conv.id as string, isNewMessage: false };

  const { data: insertedMessage, error: msgError } = await supabase
    .from('inbox_messages')
    .upsert(
      {
        workspace_id: input.workspace_id,
        conversation_id: conv.id,
        direction: 'inbound',
        content: input.content,
        is_ai: false,
        external_id: input.message_external_id,
        sender_external_id: input.external_participant_id,
        sender_name: input.sender_name,
        ...(input.created_at ? { created_at: input.created_at } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      { onConflict: 'conversation_id,external_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (msgError) {
    console.error('inbox-webhook: failed to insert message', msgError.message);
    return null;
  }

  const isNewMessage = Boolean(insertedMessage);
  if (isNewMessage) {
    await notifyNewMessage(supabase, {
      workspace_id: input.workspace_id,
      conversation_id: conv.id as string,
      platform: input.platform,
      type: input.type,
      sender_name: input.sender_name,
      content: input.content,
    });
  }
  return { conversationId: conv.id as string, isNewMessage };
}

async function handleMetaEntry(supabase: ReturnType<typeof createClient>, entry: Record<string, unknown>): Promise<void> {
  const pageId = entry.id as string | undefined;
  if (!pageId) return;

  let accounts = await findAccounts(supabase, pageId);

  if (accounts.length === 0) {
    const changes = (entry.changes as Array<Record<string, unknown>> | undefined) ?? [];
    for (const change of changes) {
      const value = (change.value as Record<string, unknown> | undefined) ?? {};
      const metadata = value.metadata as Record<string, unknown> | undefined;
      const phoneNumberId = metadata?.phone_number_id as string | undefined;
      if (phoneNumberId) {
        accounts = await findAccounts(supabase, phoneNumberId);
        if (accounts.length > 0) break;
      }
    }
  }
  if (accounts.length === 0) return;

  for (const account of accounts) {
    const messaging = (entry.messaging as Array<Record<string, unknown>> | undefined) ?? [];
    for (const m of messaging) {
      const message = m.message as Record<string, unknown> | undefined;
      const text = message?.text as string | undefined;
      const sender = m.sender as Record<string, unknown> | undefined;
      const senderId = sender?.id as string | undefined;
      if (!text || !senderId || message?.is_echo) continue;
      await upsertConversationAndMessage(supabase, {
        account_id: account.id,
        workspace_id: account.workspace_id,
        platform: account.platform,
        type: 'dm',
        external_id: senderId,
        external_participant_id: senderId,
        sender_name: null,
        content: text,
        message_external_id: (message?.id as string) ?? `${senderId}:${m.timestamp ?? Date.now()}`,
        created_at: typeof m.timestamp === 'number' ? new Date(m.timestamp * 1000).toISOString() : null,
        metadata: { source: 'meta_webhook' },
      });
    }

    if (account.platform === 'whatsapp') {
      const changes = (entry.changes as Array<Record<string, unknown>> | undefined) ?? [];
      for (const c of changes) {
        const value = (c.value as Record<string, unknown> | undefined) ?? {};
        const messages = (value.messages as Array<Record<string, unknown>> | undefined) ?? [];
        const contacts = (value.contacts as Array<Record<string, unknown>> | undefined) ?? [];
        for (const message of messages) {
          const messageId = message.id as string | undefined;
          const from = message.from as string | undefined;
          const body = message.text as Record<string, unknown> | undefined;
          const content = (body?.body as string | undefined) ?? (message.caption as string | undefined);
          if (!messageId || !from || !content) continue;
          const contact = contacts.find((candidate) => (candidate.wa_id as string) === from);
          const profile = contact?.profile as Record<string, unknown> | undefined;
          await upsertConversationAndMessage(supabase, {
            account_id: account.id,
            workspace_id: account.workspace_id,
            platform: account.platform,
            type: 'dm',
            external_id: from,
            external_participant_id: from,
            sender_name: (profile?.name as string | undefined) ?? from,
            content,
            message_external_id: messageId,
            created_at: safeWebhookDate(message.timestamp),
            metadata: { source: 'whatsapp_webhook', message_type: message.type },
          });
        }
      }
      continue;
    }

    const changes = (entry.changes as Array<Record<string, unknown>> | undefined) ?? [];
    for (const c of changes) {
      const value = (c.value as Record<string, unknown> | undefined) ?? {};
      const isComment = c.field === 'comments' || (c.field === 'feed' && value.item === 'comment' && value.verb === 'add');
      if (!isComment) continue;
      const text = (value.text as string | undefined) ?? (value.message as string | undefined);
      const commentId = (value.comment_id as string | undefined) ?? (value.id as string | undefined);
      const from = value.from as Record<string, unknown> | undefined;
      if (!text || !commentId) continue;
      const parentId = (value.parent_id as string | undefined) ?? (value.post_id as string | undefined) ?? commentId;
      await upsertConversationAndMessage(supabase, {
        account_id: account.id,
        workspace_id: account.workspace_id,
        platform: account.platform,
        type: 'comment',
        external_id: parentId,
        external_participant_id: (from?.id as string | undefined) ?? null,
        sender_name: (from?.name as string | undefined) ?? (from?.username as string | undefined) ?? null,
        content: text,
        message_external_id: commentId,
        created_at: safeWebhookDate(value.created_time),
        metadata: { source: 'meta_webhook', field: c.field },
      });
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expected = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && token && expected && token === expected) {
      return textResponse(challenge ?? '', 200);
    }
    return textResponse('Forbidden', 403);
  }

  if (req.method !== 'POST') return textResponse('Method not allowed', 405);

  const rawBody = await req.text();

  const { data: secretRow } = await supabase
    .from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'meta')
    .maybeSingle();
  const appSecret = secretRow?.app_secret ?? Deno.env.get('META_APP_SECRET');

  if (appSecret) {
    const valid = await verifySignature(rawBody, req.headers.get('X-Hub-Signature-256'), appSecret);
    if (!valid) return textResponse('Invalid signature', 401);
  } else {
    console.error('inbox-webhook: no meta app secret configured (checked social_platform_app_secrets and META_APP_SECRET), rejecting webhook');
    return textResponse('Not configured', 503);
  }

  let payload: { entry?: Array<Record<string, unknown>> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return textResponse('Invalid JSON', 400);
  }

  const entries = payload.entry ?? [];
  for (const entry of entries) {
    try {
      await handleMetaEntry(supabase, entry);
    } catch (err) {
      console.error('inbox-webhook: failed to process entry', err instanceof Error ? err.message : err);
    }
  }

  return textResponse('EVENT_RECEIVED', 200);
});

