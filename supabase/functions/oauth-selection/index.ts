import { corsHeaders, errorResponse, getCallerId, jsonResponse, serviceClient } from '../_shared/oauth.ts';

type MetaOption = { id: string; name: string; access_token: string; instagram: { id: string; username: string } | null; expires_at: string | null };
type LinkedInOption = { type: 'personal' | 'organization'; id: string; name: string; access_token: string; expires_at: string };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  const supabase = serviceClient();
  const callerId = await getCallerId(supabase, req);
  if (!callerId) return errorResponse('Unauthorized', 401);

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return errorResponse('id is required', 400);
    const { data, error } = await supabase.from('oauth_pending_selections').select('*').eq('id', id).eq('user_id', callerId).maybeSingle();
    if (error || !data) return errorResponse('Selection not found or expired', 404);
    if (new Date(data.expires_at as string) < new Date()) return errorResponse('Selection expired', 410);
    return jsonResponse({ platform: data.platform, options: data.options });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { id, selected } = body as { id: string; selected: Array<{ id: string; connect_instagram?: boolean }> };
    if (!id || !Array.isArray(selected) || selected.length === 0) return errorResponse('id and selected are required', 400);

    const { data: pending, error: fetchError } = await supabase
      .from('oauth_pending_selections')
      .select('*')
      .eq('id', id)
      .eq('user_id', callerId)
      .maybeSingle();
    if (fetchError || !pending) return errorResponse('Selection not found or expired', 404);
    if (new Date(pending.expires_at as string) < new Date()) return errorResponse('Selection expired', 410);

    const rows: Record<string, unknown>[] = [];

    if (pending.platform === 'meta') {
      const options = pending.options as MetaOption[];
      for (const choice of selected) {
        const page = options.find((o) => o.id === choice.id);
        if (!page) continue;
        rows.push({
          workspace_id: pending.workspace_id,
          platform: 'facebook',
          handle: page.name,
          provider_account_id: page.id,
          access_token_encrypted: page.access_token,
          token_expires_at: page.expires_at ?? null,
          status: 'connected',
          sync_status: 'synced',
          health_status: 'healthy',
          last_synced_at: new Date().toISOString(),
          metadata: { connected_by: callerId },
        });
        if (choice.connect_instagram && page.instagram) {
          rows.push({
            workspace_id: pending.workspace_id,
            platform: 'instagram',
            handle: `@${page.instagram.username}`,
            provider_account_id: page.instagram.id,
            access_token_encrypted: page.access_token,
            token_expires_at: page.expires_at ?? null,
            status: 'connected',
            sync_status: 'synced',
            health_status: 'healthy',
            last_synced_at: new Date().toISOString(),
            metadata: { connected_by: callerId, facebook_page_id: page.id },
          });
        }
      }
    } else if (pending.platform === 'linkedin') {
      const options = pending.options as LinkedInOption[];
      for (const choice of selected) {
        const opt = options.find((o) => o.id === choice.id);
        if (!opt) continue;
        rows.push({
          workspace_id: pending.workspace_id,
          platform: opt.type === 'personal' ? 'linkedin' : 'linkedin_page',
          handle: opt.name,
          provider_account_id: opt.id,
          access_token_encrypted: opt.access_token,
          token_expires_at: opt.expires_at || null,
          status: 'connected',
          sync_status: 'synced',
          health_status: 'healthy',
          last_synced_at: new Date().toISOString(),
          metadata: { connected_by: callerId },
        });
      }
    } else {
      return errorResponse('Unknown platform', 400);
    }

    if (rows.length === 0) return errorResponse('Nothing matched the selection', 400);

    const { error: insertError } = await supabase.from('connected_accounts').upsert(rows, {
      onConflict: 'workspace_id,platform,provider_account_id',
      ignoreDuplicates: false,
    });
    if (insertError) return errorResponse(`Could not save accounts: ${insertError.message}`, 500);

    await supabase.from('oauth_pending_selections').delete().eq('id', id);

    return jsonResponse({ connected: rows.length });
  }

  return errorResponse('Method not allowed', 405);
});
