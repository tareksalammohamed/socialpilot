import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { log, publishPost } from '../_shared/orchestrator.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_URL')?.replace(/\/$/, '') || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

type PublishBody = {
  post_id: string;
  workspace_id: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify the caller's identity directly against the auth server. This avoids the
    // unreliable setSession()-with-empty-refresh-token pattern (which is async, was
    // never awaited, and left every downstream query running under the service-role
    // key with no caller identity attached).
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return errorResponse('Unauthorized', 401);
    const { data: authData, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
    if (authError || !authData.user) return errorResponse('Unauthorized', 401);
    const callerId = authData.user.id;

    const { post_id, workspace_id }: PublishBody = await req.json();
    if (!post_id || !workspace_id) return errorResponse('post_id and workspace_id are required', 400);

    // The service-role client bypasses RLS entirely, so membership must be checked
    // explicitly here. Without this, any authenticated user could pass any
    // workspace_id they belong to together with someone else's post_id and have
    // that post's private content published to their own connected accounts.
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('user_id', callerId)
      .maybeSingle();
    if (!membership) return errorResponse('Forbidden', 403);

    const { data: post, error: postError } = await supabase.from('posts').select('*').eq('id', post_id).single();
    if (postError || !post) return errorResponse('Post not found', 404);

    // Confirm the post actually belongs to the workspace the caller is a member of.
    if (post.workspace_id !== workspace_id) return errorResponse('Post not found', 404);

    await supabase.from('posts').update({ status: 'publishing', updated_at: new Date().toISOString() }).eq('id', post_id);
    await log(supabase, { workspace_id, post_id, event: 'queued', message: 'Manual publish requested' });

    const finalStatus = await publishPost(supabase, post, callerId);

    return jsonResponse({ status: finalStatus, post_id });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Internal server error', 500);
  }
});
