import { redirectToApp, serviceClient } from '../_shared/oauth.ts';
import { getCredential } from '../_shared/credentials.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

type PageOption = {
  id: string;
  name: string;
  access_token: string;
  instagram: { id: string; username: string } | null;
  expires_at: string | null;
};

async function exchangeCode(appId: string, appSecret: string, redirectUri: string, code: string) {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in?: number };
}

async function exchangeForLongLivedToken(appId: string, appSecret: string, shortToken: string) {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', shortToken);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`long-lived exchange failed: ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number };
}

async function fetchPages(userToken: string, userTokenExpiresInSeconds: number | undefined): Promise<PageOption[]> {
  const url = new URL(`${GRAPH}/me/accounts`);
  url.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
  url.searchParams.set('access_token', userToken);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`fetching pages failed: ${await res.text()}`);
  const body = await res.json();

  // Meta doesn't return a per-page expiry: a Page access token minted from a
  // long-lived User token inherits that token's ~60 day validity. We record
  // that estimate so the UI can warn before expiry and meta-token-refresh
  // knows which accounts are due. Falls back to 55 days if Meta omits
  // expires_in (observed for some long-lived exchanges).
  const expiresAt = new Date(Date.now() + (userTokenExpiresInSeconds ?? 55 * 24 * 60 * 60) * 1000).toISOString();

  return ((body.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    access_token: p.access_token as string,
    instagram: p.instagram_business_account
      ? {
          id: (p.instagram_business_account as Record<string, unknown>).id as string,
          username: (p.instagram_business_account as Record<string, unknown>).username as string,
        }
      : null,
    expires_at: expiresAt,
  }));
}

Deno.serve(async (req: Request) => {
  const supabase = serviceClient();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');

  if (oauthError) return await redirectToApp(supabase, { platform: 'meta', error: oauthError });
  if (!code || !state) return await redirectToApp(supabase, { platform: 'meta', error: 'missing_code_or_state' });

  const appId = await getCredential(supabase, 'meta_app_id');
  const appSecret = await getCredential(supabase, 'meta_app_secret');
  if (!appId || !appSecret) return await redirectToApp(supabase, { platform: 'meta', error: 'server_not_configured' });

  const { data: stateRow } = await supabase.from('oauth_states').select('*').eq('state', state).eq('platform', 'meta').maybeSingle();
  if (!stateRow || new Date(stateRow.expires_at as string) < new Date()) {
    return await redirectToApp(supabase, { platform: 'meta', error: 'invalid_or_expired_state' });
  }
  await supabase.from('oauth_states').delete().eq('id', stateRow.id as string);

  const functionsUrl = Deno.env.get('SUPABASE_URL')!.replace('.supabase.co', '.supabase.co/functions/v1');
  const redirectUri = `${functionsUrl}/meta-oauth-callback`;

  try {
    const shortLived = await exchangeCode(appId, appSecret, redirectUri, code);
    const longLived = await exchangeForLongLivedToken(appId, appSecret, shortLived.access_token);
    const pages = await fetchPages(longLived.access_token, longLived.expires_in);

    if (pages.length === 0) {
      return await redirectToApp(supabase, { platform: 'meta', error: 'no_pages_found' });
    }

    const { data: selection, error } = await supabase
      .from('oauth_pending_selections')
      .insert({
        workspace_id: stateRow.workspace_id as string,
        user_id: stateRow.user_id as string,
        platform: 'meta',
        options: pages,
      })
      .select('id')
      .single();
    if (error || !selection) throw new Error('could not store selection');

    return await redirectToApp(supabase, { platform: 'meta', selection: selection.id as string });
  } catch (e) {
    return await redirectToApp(supabase, { platform: 'meta', error: e instanceof Error ? e.message : 'unknown_error' });
  }
});
