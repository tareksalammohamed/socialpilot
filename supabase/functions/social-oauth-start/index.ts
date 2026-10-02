import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// Called by a logged-in workspace member from "المزيد > الحسابات > ربط".
// Verifies the caller belongs to the workspace, mints a short-lived CSRF
// state row, and returns the Meta OAuth dialog URL for the client to open.
// The actual token exchange happens in social-oauth-callback, which Meta
// redirects the browser to directly (no Authorization header available then
// — that's why the workspace/user identity travels via the `state` row).
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

const PLATFORM_LABELS: Record<string, string> = {
  meta: 'فيسبوك/إنستجرام',
  linkedin: 'لينكدإن',
  x: 'إكس',
  threads: 'ثريدز',
  tiktok: 'تيك توك',
};

// X (Twitter) OAuth 2.0 requires PKCE on the authorization request — we
// generate a code_verifier here, keep it on the state row (server-side
// only), and send its S256 challenge in the auth URL. social-oauth-callback
// reads the verifier back off the state row to complete the exchange.
function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return jsonRes(401, { error: 'Missing authentication token' });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return jsonRes(401, { error: 'Invalid or expired token' });
  const userId = userData.user.id;

  let body: { workspaceId?: string; platformKey?: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes(400, { error: 'Invalid JSON body' });
  }

  const workspaceId = body.workspaceId;
  const platformKey = body.platformKey ?? 'meta';
  if (!workspaceId) return jsonRes(400, { error: 'workspaceId is required' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) return jsonRes(403, { error: 'You do not have access to this workspace' });

  const { data: app } = await supabase
    .from('social_platform_apps')
    .select('*')
    .eq('platform_key', platformKey)
    .maybeSingle();

  const platformLabel = PLATFORM_LABELS[platformKey] ?? platformKey;

  if (!app || !app.app_id || !app.has_secret) {
    return jsonRes(409, { error: `لسه الأدمن ما ضبطش إعدادات ربط ${platformLabel}. راجع Super Admin > تكاملات التواصل الاجتماعي.` });
  }
  if (!app.enabled) {
    return jsonRes(409, { error: `ربط ${platformLabel} معطّل حاليًا من الأدمن.` });
  }

  const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const pkce = platformKey === 'x' ? await generatePkcePair() : null;

  const { error: stateError } = await supabase.from('social_oauth_states').insert({
    state,
    workspace_id: workspaceId,
    user_id: userId,
    platform_key: platformKey,
    code_verifier: pkce?.verifier ?? null,
  });
  if (stateError) return jsonRes(500, { error: 'تعذّر بدء عملية الربط' });

  const redirectUri = app.redirect_uri || `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/social-oauth-callback`;

  let authUrl: URL;
  switch (platformKey) {
    case 'x': {
      const scope = app.scopes || 'tweet.read tweet.write users.read offline.access';
      authUrl = new URL('https://twitter.com/i/oauth2/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', app.app_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('code_challenge', pkce!.challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      break;
    }
    case 'linkedin': {
      const scope = app.scopes || 'openid profile email w_member_social';
      authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', app.app_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('scope', scope);
      break;
    }
    case 'threads': {
      const scope = app.scopes || 'threads_basic,threads_content_publish';
      authUrl = new URL('https://threads.net/oauth/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', app.app_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('scope', scope);
      break;
    }
    case 'tiktok': {
      const scope = app.scopes || 'user.info.basic,video.publish,video.upload';
      authUrl = new URL('https://www.tiktok.com/v2/auth/authorize/');
      authUrl.searchParams.set('client_key', app.app_id);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      break;
    }
    case 'meta':
    default: {
      const scope = app.scopes || 'pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_metadata,read_insights,instagram_basic,instagram_manage_insights,instagram_content_publish,business_management';
      authUrl = new URL('https://www.facebook.com/v26.0/dialog/oauth');
      authUrl.searchParams.set('client_id', app.app_id);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('response_type', 'code');
      break;
    }
  }

  return jsonRes(200, { url: authUrl.toString() });
});
