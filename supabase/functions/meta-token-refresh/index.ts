import { corsHeaders, errorResponse, getCallerId, jsonResponse, serviceClient } from '../_shared/oauth.ts';
import { refreshMetaTokens } from '../_shared/metaRefresh.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  const supabase = serviceClient();
  const callerId = await getCallerId(supabase, req);
  if (!callerId) return errorResponse('Unauthorized', 401);

  const { account_id } = await req.json().catch(() => ({}));
  if (!account_id) return errorResponse('account_id is required', 400);

  const { data: account } = await supabase
    .from('connected_accounts')
    .select('id, workspace_id, platform')
    .eq('id', account_id)
    .maybeSingle();
  if (!account) return errorResponse('Account not found', 404);

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', account.workspace_id)
    .eq('user_id', callerId)
    .maybeSingle();
  if (!membership) return errorResponse('Forbidden', 403);

  let facebookAccountId = account.id as string;
  if (account.platform === 'instagram') {
    const { data: igRow } = await supabase.from('connected_accounts').select('metadata').eq('id', account.id).maybeSingle();
    const pageId = (igRow?.metadata as Record<string, unknown> | null)?.facebook_page_id as string | undefined;
    if (!pageId) return errorResponse('This Instagram account has no linked Facebook Page on record', 400);
    const { data: fbRow } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('workspace_id', account.workspace_id)
      .eq('platform', 'facebook')
      .eq('provider_account_id', pageId)
      .maybeSingle();
    if (!fbRow) return errorResponse('Linked Facebook Page account not found', 404);
    facebookAccountId = fbRow.id as string;
  } else if (account.platform !== 'facebook') {
    return errorResponse('Token refresh is only supported for Facebook and Instagram accounts', 400);
  }

  const result = await refreshMetaTokens(supabase, { accountId: facebookAccountId });
  if (result.refreshed === 0) {
    const reason = result.details[0]?.error ?? 'Could not refresh this account\'s token';
    return errorResponse(reason, 502);
  }

  return jsonResponse({ refreshed: true });
});
