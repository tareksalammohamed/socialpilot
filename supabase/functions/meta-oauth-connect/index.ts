import { corsHeaders, errorResponse, getCallerId, jsonResponse, randomState, serviceClient } from '../_shared/oauth.ts';
import { getCredential } from '../_shared/credentials.ts';

// Permissions needed to: list Pages, read/publish Page posts, and publish to
// a linked Instagram Business account. `business_management` is required if
// the Page is owned by a Business Manager rather than the user directly.
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
].join(',');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  const functionsUrl = Deno.env.get('SUPABASE_URL')!.replace('.supabase.co', '.supabase.co/functions/v1');
  const supabase = serviceClient();
  const appId = await getCredential(supabase, 'meta_app_id');
  if (!appId) return errorResponse('Meta App ID is not configured. Set it in Settings > Integrations.', 500);
  // Apps set up under "Facebook Login for Business" (as opposed to classic
  // Facebook Login) require a config_id from a Login Configuration instead
  // of a plain scope list — the classic scope-based dialog fails silently
  // (generic "Sorry, something went wrong") for these apps.
  const configId = await getCredential(supabase, 'meta_config_id');

  const callerId = await getCallerId(supabase, req);
  if (!callerId) return errorResponse('Unauthorized', 401);

  const { workspace_id } = await req.json().catch(() => ({}));
  if (!workspace_id) return errorResponse('workspace_id is required', 400);

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspace_id)
    .eq('user_id', callerId)
    .maybeSingle();
  if (!membership) return errorResponse('Forbidden', 403);

  const state = randomState();
  const { error } = await supabase.from('oauth_states').insert({
    state,
    workspace_id,
    user_id: callerId,
    platform: 'meta',
  });
  if (error) return errorResponse('Could not start OAuth flow', 500);

  const redirectUri = `${functionsUrl}/meta-oauth-callback`;
  const authorizeUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  authorizeUrl.searchParams.set('client_id', appId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('response_type', 'code');
  if (configId) {
    // Facebook Login for Business: pass the Login Configuration ID instead
    // of scope (Meta recommends omitting scope entirely in this mode).
    authorizeUrl.searchParams.set('config_id', configId);
  } else {
    authorizeUrl.searchParams.set('scope', META_SCOPES);
  }

  return jsonResponse({ url: authorizeUrl.toString() });
});
