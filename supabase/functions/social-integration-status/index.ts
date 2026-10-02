import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json(401, { error: 'Unauthorized' });
  const { data: authData, error: authError } = await supabase.auth.getUser(bearer);
  if (authError || !authData.user) return json(401, { error: 'Unauthorized' });

  const body = await req.json().catch(() => ({})) as { workspaceId?: string };
  if (!body.workspaceId) return json(400, { error: 'workspaceId is required' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (!membership) return json(403, { error: 'Workspace access denied' });

  const [{ data: apps, error: appsError }, { data: accounts, error: accountsError }] = await Promise.all([
    supabase
      .from('social_platform_apps')
      .select('platform_key,display_name,enabled,has_secret,status,last_error')
      .order('platform_key'),
    supabase
      .from('social_accounts')
      .select('id,platform,status,needs_reconnect,last_sync_at')
      .eq('workspace_id', body.workspaceId),
  ]);

  if (appsError) return json(500, { error: appsError.message });
  if (accountsError) return json(500, { error: accountsError.message });

  return json(200, {
    apps: (apps ?? []).map((app) => ({
      platform_key: app.platform_key,
      display_name: app.display_name,
      enabled: app.enabled,
      configured: Boolean(app.has_secret),
      status: app.status,
      last_error: app.last_error,
    })),
    accounts: accounts ?? [],
  });
});
