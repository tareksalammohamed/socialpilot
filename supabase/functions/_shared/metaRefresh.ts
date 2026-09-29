import { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { getCredential } from './credentials.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

const REFRESH_WINDOW_DAYS = 10;

type ConnectedAccountRow = {
  id: string;
  workspace_id: string;
  provider_account_id: string | null;
  access_token_encrypted: string | null;
  metadata: Record<string, unknown> | null;
};

async function exchangeForLongLivedToken(appId: string, appSecret: string, currentToken: string) {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', currentToken);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Meta token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in?: number };
}

export type MetaRefreshResult = {
  refreshed: number;
  failed: number;
  details: Array<{ account_id: string; ok: boolean; error?: string }>;
};

export async function refreshMetaTokens(supabase: SupabaseClient, opts: { accountId?: string } = {}): Promise<MetaRefreshResult> {
  const appId = await getCredential(supabase, 'meta_app_id');
  const appSecret = await getCredential(supabase, 'meta_app_secret');
  const result: MetaRefreshResult = { refreshed: 0, failed: 0, details: [] };
  if (!appId || !appSecret) {
    result.details.push({ account_id: opts.accountId ?? 'n/a', ok: false, error: 'Meta App ID/Secret not configured' });
    return result;
  }

  let query = supabase
    .from('connected_accounts')
    .select('id, workspace_id, provider_account_id, access_token_encrypted, metadata')
    .eq('platform', 'facebook')
    .eq('status', 'connected');

  if (opts.accountId) {
    query = query.eq('id', opts.accountId);
  } else {
    const cutoff = new Date(Date.now() + REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    query = query.not('token_expires_at', 'is', null).lte('token_expires_at', cutoff);
  }

  const { data: pages, error: fetchError } = await query;
  if (fetchError) {
    result.details.push({ account_id: opts.accountId ?? 'n/a', ok: false, error: fetchError.message });
    return result;
  }

  for (const page of (pages ?? []) as ConnectedAccountRow[]) {
    if (!page.access_token_encrypted) {
      result.failed++;
      result.details.push({ account_id: page.id, ok: false, error: 'No stored access token to refresh' });
      continue;
    }

    try {
      const refreshed = await exchangeForLongLivedToken(appId, appSecret, page.access_token_encrypted);
      const newExpiresAt = new Date(Date.now() + (refreshed.expires_in ?? 55 * 24 * 60 * 60) * 1000).toISOString();

      await supabase
        .from('connected_accounts')
        .update({
          access_token_encrypted: refreshed.access_token,
          token_expires_at: newExpiresAt,
          health_status: 'healthy',
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', page.id);

      if (page.provider_account_id) {
        await supabase
          .from('connected_accounts')
          .update({
            access_token_encrypted: refreshed.access_token,
            token_expires_at: newExpiresAt,
            health_status: 'healthy',
            sync_status: 'synced',
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('workspace_id', page.workspace_id)
          .eq('platform', 'instagram')
          .eq('status', 'connected')
          .contains('metadata', { facebook_page_id: page.provider_account_id });
      }

      result.refreshed++;
      result.details.push({ account_id: page.id, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      await supabase
        .from('connected_accounts')
        .update({
          health_status: 'error',
          sync_status: 'error',
          metadata: { ...(page.metadata ?? {}), last_refresh_error: message, last_refresh_error_at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        })
        .eq('id', page.id);

      result.failed++;
      result.details.push({ account_id: page.id, ok: false, error: message });
    }
  }

  return result;
}
