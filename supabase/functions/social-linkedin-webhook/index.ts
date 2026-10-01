import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// social-linkedin-webhook
//
// Receives LinkedIn's "Organization Social Action Notifications" — LIKE,
// COMMENT, SHARE, SHARE_MENTION, ADMIN_COMMENT, COMMENT_EDIT, COMMENT_DELETE
// events on a LinkedIn Company Page the connected account administers. This
// is a SEPARATE product from social-oauth-* / social-publish: it requires
// LinkedIn's "Community Management API" with the `rw_organization_admin`
// scope AND an approved "Webhooks" use case on the LinkedIn developer app —
// neither is guaranteed to be granted just by asking. Until LinkedIn
// approves both, this endpoint will simply never receive traffic.
//
// IMPORTANT SCOPE LIMIT (read before wiring this up):
// - This only covers COMPANY PAGE comments/likes/shares. LinkedIn does not
//   expose a public webhook (or any general-availability API) for personal
//   profile direct messages — there is no way to receive LinkedIn DMs through
//   a normal developer app. Do not represent this function as "LinkedIn
//   Inbox/DMs" in the UI — it is Comments-on-company-posts only.
// - The LinkedIn account currently connected in this project
//   (urn:li:person:...) is a PERSONAL profile, not a Company Page. This
//   webhook will not fire for it. A Company Page must be connected
//   separately with rw_organization_admin before any event can arrive, and
//   an Event Subscription must be created via the eventSubscriptions API
//   (see the audit report) pointing at this function's URL.
//
// Auth model (two different mechanisms, both from LinkedIn's spec, not
// invented here):
//   GET  — validation handshake. LinkedIn calls this URL with
//          ?challengeCode=<uuid>; we must return
//          { challengeCode, challengeResponse } where challengeResponse =
//          hex(HMAC_SHA256(challengeCode, clientSecret)). No custom secret —
//          reuses the LinkedIn app's OAuth client secret already stored in
//          social_platform_app_secrets (platform_key = 'linkedin').
//   POST — event delivery. LinkedIn sends header `X-LI-Signature` =
//          hex(HMAC_SHA256("hmacsha256=" + <raw body>, clientSecret)).
//          Verified with a constant-time comparison before touching the
//          payload, mirroring the pattern already used for Meta events in
//          supabase/functions/inbox-webhook/index.ts (X-Hub-Signature-256).
//
// Idempotency: LinkedIn redelivers unacknowledged notifications every 5
// minutes for up to 8 hours, and documents notificationId as the dedupe key.
// We reuse the same inbox_conversations / inbox_messages upsert pattern as
// inbox-webhook, keyed on (account_id, platform, type, external_id) for the
// conversation and (conversation_id, external_id) for the message, so a
// redelivered notification is a no-op rather than a duplicate row.
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-LI-Signature',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: corsHeaders });
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Account = { id: string; workspace_id: string };

async function findAccountByOrgUrn(supabase: ReturnType<typeof createClient>, organizationUrn: string): Promise<Account | null> {
  const { data, error } = await supabase
    .from('social_accounts')
    .select('id, workspace_id')
    .eq('platform', 'linkedin')
    .eq('status', 'connected')
    .contains('metadata', { urn: organizationUrn })
    .maybeSingle();
  if (error) {
    console.error('social-linkedin-webhook: account lookup failed', error.message);
    return null;
  }
  return (data as Account | null) ?? null;
}

type LinkedInNotification = {
  notificationId: number;
  organizationalEntity: string;
  action: string;
  sourcePost?: string;
  generatedActivity?: string;
  lastModifiedAt?: number;
  decoratedGeneratedActivity?: {
    comment?: { entity: string; owner: string; object: string; text?: string };
  };
};

const COMMENT_ACTIONS = new Set(['COMMENT', 'ADMIN_COMMENT', 'COMMENT_EDIT']);

async function handleNotification(supabase: ReturnType<typeof createClient>, n: LinkedInNotification): Promise<void> {
  if (!COMMENT_ACTIONS.has(n.action)) return; // LIKE/SHARE/SHARE_MENTION/COMMENT_DELETE: no message text to store yet
  const comment = n.decoratedGeneratedActivity?.comment;
  const text = comment?.text;
  const commentUrn = n.generatedActivity ?? comment?.entity;
  if (!text || !commentUrn) return;

  const account = await findAccountByOrgUrn(supabase, n.organizationalEntity);
  if (!account) {
    // No connected LinkedIn Company Page matches this organization yet —
    // expected until a Page (not a personal profile) is connected. Not an error.
    return;
  }

  const parentPostUrn = n.sourcePost ?? comment?.object ?? commentUrn;

  const { data: conv, error: convError } = await supabase
    .from('inbox_conversations')
    .upsert(
      {
        workspace_id: account.workspace_id,
        account_id: account.id,
        platform: 'linkedin',
        type: 'comment',
        external_id: parentPostUrn,
        sender_name: null,
        external_participant_id: comment?.owner ?? null,
        snippet: text,
        unread: true,
        status: 'open',
        resolved_at: null,
        metadata: { source: 'linkedin_webhook', action: n.action },
      },
      { onConflict: 'account_id,platform,type,external_id' },
    )
    .select('id')
    .single();
  if (convError || !conv) {
    console.error('social-linkedin-webhook: failed to upsert conversation', convError?.message);
    return;
  }

  const { error: msgError } = await supabase
    .from('inbox_messages')
    .upsert(
      {
        workspace_id: account.workspace_id,
        conversation_id: conv.id,
        direction: 'inbound',
        content: text,
        is_ai: false,
        external_id: commentUrn,
        sender_external_id: comment?.owner ?? null,
        sender_name: null,
        ...(n.lastModifiedAt ? { created_at: new Date(n.lastModifiedAt).toISOString() } : {}),
        metadata: { source: 'linkedin_webhook', notification_id: n.notificationId, action: n.action },
      },
      { onConflict: 'conversation_id,external_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (msgError) {
    console.error('social-linkedin-webhook: failed to insert message', msgError.message);
    return;
  }

  await supabase.from('notifications').insert({
    workspace_id: account.workspace_id,
    type: 'inbox_new_comment',
    title: 'تعليق جديد على لينكدإن',
    body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
    payload: { conversation_id: conv.id, platform: 'linkedin', inbox_type: 'comment' },
  });
}

async function getLinkedInClientSecret(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data, error } = await supabase
    .from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'linkedin')
    .maybeSingle();
  if (error || !data?.app_secret) {
    console.error('social-linkedin-webhook: linkedin app secret not configured', error?.message);
    return null;
  }
  return data.app_secret as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const clientSecret = await getLinkedInClientSecret(supabase);
  if (!clientSecret) return textResponse('Not configured', 503);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const challengeCode = url.searchParams.get('challengeCode');
    if (!challengeCode) return textResponse('Missing challengeCode', 400);
    const challengeResponse = await hmacSha256Hex(challengeCode, clientSecret);
    return jsonResponse(200, { challengeCode, challengeResponse });
  }

  if (req.method !== 'POST') return textResponse('Method not allowed', 405);

  const rawBody = await req.text();
  const signatureHeader = req.headers.get('X-LI-Signature') ?? '';
  const expectedSignature = await hmacSha256Hex(`hmacsha256=${rawBody}`, clientSecret);
  if (!signatureHeader || !constantTimeEqual(signatureHeader.toLowerCase(), expectedSignature.toLowerCase())) {
    return textResponse('Invalid signature', 401);
  }

  let payload: { type?: string; notifications?: LinkedInNotification[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return textResponse('Invalid JSON', 400);
  }

  for (const n of payload.notifications ?? []) {
    try {
      await handleNotification(supabase, n);
    } catch (err) {
      console.error('social-linkedin-webhook: failed to process notification', err instanceof Error ? err.message : err);
    }
  }

  return textResponse('EVENT_RECEIVED', 200);
});
