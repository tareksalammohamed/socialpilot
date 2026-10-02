import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// Meta redirects the user's browser here directly (GET, no Authorization
// header) after they approve/deny access on facebook.com. We recover the
// workspace + user from the `state` row social-oauth-start created, exchange
// the code for a long-lived token, discover the user's Facebook Pages and
// any linked Instagram Business Accounts, save them as connected
// social_accounts, then redirect the browser back into the app.
// ---------------------------------------------------------------------------

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';

async function getAppUrl(): Promise<string> {
  const { data } = await supabase.from('system_settings').select('value').eq('key', 'app_url').maybeSingle();
  const fromDb = typeof data?.value === 'string' ? data.value : null;
  const url = fromDb || Deno.env.get('APP_URL') || '';
  return url.replace(/\/$/, '');
}

async function redirectToApp(params: Record<string, string>): Promise<Response> {
  const appUrl = await getAppUrl();
  const target = new URL(appUrl || 'https://example.com');
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error_message') || url.searchParams.get('error_description') || url.searchParams.get('error');

  if (oauthError) {
    return redirectToApp({ social: 'error', message: oauthError });
  }
  if (!code || !state) {
    return redirectToApp({ social: 'error', message: 'رابط رجوع غير مكتمل من Meta' });
  }

  const { data: stateRow } = await supabase
    .from('social_oauth_states')
    .select('*')
    .eq('state', state)
    .maybeSingle();

  if (!stateRow || stateRow.consumed || new Date(stateRow.expires_at).getTime() < Date.now()) {
    return redirectToApp({ social: 'error', message: 'انتهت صلاحية جلسة الربط، حاول تاني' });
  }
  await supabase.from('social_oauth_states').update({ consumed: true }).eq('state', state);

  const { data: app } = await supabase
    .from('social_platform_apps')
    .select('*')
    .eq('platform_key', stateRow.platform_key)
    .maybeSingle();
  const { data: secretRow } = await supabase
    .from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', stateRow.platform_key)
    .maybeSingle();

  if (!app?.app_id || !secretRow?.app_secret) {
    const labels: Record<string, string> = {
      meta: 'فيسبوك/إنستجرام',
      linkedin: 'لينكدإن',
      x: 'إكس',
      threads: 'ثريدز',
      tiktok: 'تيك توك',
    };
    return redirectToApp({ social: 'error', message: `إعدادات ربط ${labels[stateRow.platform_key] ?? stateRow.platform_key} غير مكتملة` });
  }

  const redirectUri = app.redirect_uri || `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/social-oauth-callback`;

  if (stateRow.platform_key === 'linkedin') {
    return handleLinkedInCallback({ code, app, secretRow, redirectUri, stateRow });
  }
  if (stateRow.platform_key === 'x') {
    return handleXCallback({ code, app, secretRow, redirectUri, stateRow });
  }
  if (stateRow.platform_key === 'threads') {
    return handleThreadsCallback({ code, app, secretRow, redirectUri, stateRow });
  }
  if (stateRow.platform_key === 'tiktok') {
    return handleTikTokCallback({ code, app, secretRow, redirectUri, stateRow });
  }

  try {
    // 1. Exchange the code for a short-lived user access token.
    const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', app.app_id);
    tokenUrl.searchParams.set('client_secret', secretRow.app_secret);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', code);
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(tokenJson?.error?.message ?? 'فشل تبادل رمز الدخول مع Meta');
    }

    // 2. Exchange for a long-lived user token (~60 days).
    const longUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    longUrl.searchParams.set('grant_type', 'fb_exchange_token');
    longUrl.searchParams.set('client_id', app.app_id);
    longUrl.searchParams.set('client_secret', secretRow.app_secret);
    longUrl.searchParams.set('fb_exchange_token', tokenJson.access_token);
    const longRes = await fetch(longUrl.toString());
    const longJson = await longRes.json();
    const userToken = longRes.ok && longJson.access_token ? longJson.access_token : tokenJson.access_token;
    const expiresInSec = longJson.expires_in ?? tokenJson.expires_in ?? null;
    const tokenExpiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

    // 3. Discover the user's Facebook Pages + any linked Instagram Business Account.
    const pagesUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`);
    pagesUrl.searchParams.set('access_token', userToken);
    pagesUrl.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}');
    const pagesRes = await fetch(pagesUrl.toString());
    const pagesJson = await pagesRes.json();
    if (!pagesRes.ok) throw new Error(pagesJson?.error?.message ?? 'تعذّر جلب صفحات فيسبوك');

    const pages: Array<Record<string, unknown>> = pagesJson.data ?? [];
    if (pages.length === 0) {
      return redirectToApp({ social: 'error', message: 'مفيش صفحات فيسبوك مرتبطة بحسابك — لازم يكون عندك صفحة فيسبوك على الأقل' });
    }

    let connectedFacebook = 0;
    let connectedInstagram = 0;

    for (const page of pages) {
      const pageId = String(page.id);
      const pageName = String(page.name ?? 'صفحة فيسبوك');
      const pageToken = String(page.access_token ?? userToken);

      const { data: fbAccount } = await supabase
        .from('social_accounts')
        .upsert({
          workspace_id: stateRow.workspace_id,
          platform: 'facebook',
          handle: pageId,
          display_name: pageName,
          status: 'connected',
          needs_reconnect: false,
          external_id: pageId,
          page_id: pageId,
          last_sync_at: new Date().toISOString(),
          metadata: { page_id: pageId },
        }, { onConflict: 'workspace_id,platform' })
        .select()
        .single();

      if (fbAccount) {
        await supabase.from('social_account_tokens').upsert({
          account_id: fbAccount.id,
          access_token: pageToken,
          token_type: 'page',
          expires_at: null, // Page access tokens derived from a long-lived user token don't expire.
          updated_at: new Date().toISOString(),
        });
        connectedFacebook += 1;
      }

      const ig = page.instagram_business_account as Record<string, unknown> | undefined;
      if (ig?.id) {
        const igId = String(ig.id);
        const igUsername = String(ig.username ?? ig.name ?? 'حساب إنستجرام');

        const { data: igAccount } = await supabase
          .from('social_accounts')
          .upsert({
            workspace_id: stateRow.workspace_id,
            platform: 'instagram',
            handle: igUsername,
            display_name: igUsername,
            status: 'connected',
            needs_reconnect: false,
            external_id: igId,
            page_id: pageId,
            ig_user_id: igId,
            last_sync_at: new Date().toISOString(),
            metadata: { linked_page_id: pageId },
          }, { onConflict: 'workspace_id,platform' })
          .select()
          .single();

        if (igAccount) {
          await supabase.from('social_account_tokens').upsert({
            account_id: igAccount.id,
            access_token: pageToken,
            token_type: 'page',
            expires_at: tokenExpiresAt,
            updated_at: new Date().toISOString(),
          });
          connectedInstagram += 1;
        }
      }
    }

    return redirectToApp({
      social: 'connected',
      platform: 'meta',
      facebook: String(connectedFacebook),
      instagram: String(connectedInstagram),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل ربط الحساب';
    await supabase.from('social_platform_apps').update({ last_error: message, status: 'error' }).eq('platform_key', stateRow.platform_key);
    return redirectToApp({ social: 'error', message });
  }
});

// ---------------------------------------------------------------------------
// LinkedIn — standard OAuth2 3-legged flow (no long-lived exchange step,
// no refresh_token for non-MDP apps: tokens are valid ~60 days and the
// user must re-run this flow to reconnect once they expire). We store the
// member's own profile as a single 'linkedin' social_accounts row scoped
// to w_member_social (personal posting) via OpenID Connect userinfo.
// ---------------------------------------------------------------------------
async function handleLinkedInCallback(params: {
  code: string;
  app: Record<string, unknown>;
  secretRow: { app_secret: string };
  redirectUri: string;
  stateRow: Record<string, unknown>;
}): Promise<Response> {
  const { code, app, secretRow, redirectUri, stateRow } = params;

  try {
    // 1. Exchange the authorization code for an access token.
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: String(app.app_id),
        client_secret: secretRow.app_secret,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(tokenJson?.error_description ?? tokenJson?.error ?? 'فشل تبادل رمز الدخول مع لينكدإن');
    }
    const accessToken = tokenJson.access_token as string;
    const expiresInSec = typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : null;
    const tokenExpiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

    // 2. Fetch the member's identity via OpenID Connect userinfo.
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profileJson = await profileRes.json();
    if (!profileRes.ok || !profileJson.sub) {
      throw new Error(profileJson?.message ?? 'تعذّر جلب بيانات حساب لينكدإن');
    }

    const memberUrn = `urn:li:person:${profileJson.sub}`;
    const displayName = String(profileJson.name ?? 'حساب لينكدإن');

    const { data: account, error: upsertError } = await supabase
      .from('social_accounts')
      .upsert({
        workspace_id: stateRow.workspace_id,
        platform: 'linkedin',
        handle: displayName,
        display_name: displayName,
        status: 'connected',
        needs_reconnect: false,
        external_id: profileJson.sub,
        metadata: { urn: memberUrn, picture: profileJson.picture ?? null },
        last_sync_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,platform' })
      .select()
      .single();

    if (upsertError || !account) throw new Error('تعذّر حفظ حساب لينكدإن');

    await supabase.from('social_account_tokens').upsert({
      account_id: account.id,
      access_token: accessToken,
      token_type: 'member',
      expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    });

    return redirectToApp({ social: 'connected', platform: 'linkedin', linkedin: '1' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل ربط حساب لينكدإن';
    await supabase.from('social_platform_apps').update({ last_error: message, status: 'error' }).eq('platform_key', 'linkedin');
    return redirectToApp({ social: 'error', message });
  }
}

// ---------------------------------------------------------------------------
// X (Twitter) — OAuth 2.0 with mandatory PKCE. code_verifier travels on the
// state row social-oauth-start created (it never leaves the server). We
// request offline.access so we get a refresh_token, since access tokens
// expire in ~2 hours — social-publish refreshes it on demand before posting.
// ---------------------------------------------------------------------------
async function handleXCallback(params: {
  code: string;
  app: Record<string, unknown>;
  secretRow: { app_secret: string };
  redirectUri: string;
  stateRow: Record<string, unknown>;
}): Promise<Response> {
  const { code, app, secretRow, redirectUri, stateRow } = params;

  try {
    const codeVerifier = stateRow.code_verifier as string | null;
    if (!codeVerifier) throw new Error('جلسة ربط إكس غير صالحة (PKCE)');

    // 1. Exchange the authorization code for an access + refresh token.
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${app.app_id}:${secretRow.app_secret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: String(app.app_id),
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(tokenJson?.error_description ?? tokenJson?.error ?? 'فشل تبادل رمز الدخول مع إكس');
    }
    const accessToken = tokenJson.access_token as string;
    const refreshToken = (tokenJson.refresh_token as string | undefined) ?? null;
    const expiresInSec = typeof tokenJson.expires_in === 'number' ? tokenJson.expires_in : null;
    const tokenExpiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

    // 2. Fetch the member's identity.
    const profileRes = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url,username,name', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profileJson = await profileRes.json();
    if (!profileRes.ok || !profileJson.data?.id) {
      throw new Error(profileJson?.detail ?? profileJson?.title ?? 'تعذّر جلب بيانات حساب إكس');
    }
    const profile = profileJson.data as { id: string; username: string; name?: string; profile_image_url?: string };

    const { data: account, error: upsertError } = await supabase
      .from('social_accounts')
      .upsert({
        workspace_id: stateRow.workspace_id,
        platform: 'x',
        handle: `@${profile.username}`,
        display_name: profile.name ?? profile.username,
        status: 'connected',
        needs_reconnect: false,
        external_id: profile.id,
        metadata: { picture: profile.profile_image_url ?? null },
        last_sync_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,platform' })
      .select()
      .single();

    if (upsertError || !account) throw new Error('تعذّر حفظ حساب إكس');

    await supabase.from('social_account_tokens').upsert({
      account_id: account.id,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'member',
      expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    });

    return redirectToApp({ social: 'connected', platform: 'x', x: '1' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل ربط حساب إكس';
    await supabase.from('social_platform_apps').update({ last_error: message, status: 'error' }).eq('platform_key', 'x');
    return redirectToApp({ social: 'error', message });
  }
}


// ---------------------------------------------------------------------------
// Threads — canonical OAuth path. Stores the account and long-lived token in
// social_accounts/social_account_tokens, the same model used by publishing.
// ---------------------------------------------------------------------------
async function handleThreadsCallback(params: {
  code: string;
  app: Record<string, unknown>;
  secretRow: { app_secret: string };
  redirectUri: string;
  stateRow: Record<string, unknown>;
}): Promise<Response> {
  const { code, app, secretRow, redirectUri, stateRow } = params;
  try {
    const tokenBody = new URLSearchParams({
      client_id: String(app.app_id),
      client_secret: secretRow.app_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const tokenRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(tokenJson?.error?.message ?? tokenJson?.error_message ?? 'فشل تبادل رمز الدخول مع Threads');
    }

    const longUrl = new URL('https://graph.threads.net/access_token');
    longUrl.searchParams.set('grant_type', 'th_exchange_token');
    longUrl.searchParams.set('client_secret', secretRow.app_secret);
    longUrl.searchParams.set('access_token', String(tokenJson.access_token));
    const longRes = await fetch(longUrl.toString());
    const longJson = await longRes.json();
    if (!longRes.ok || !longJson.access_token) {
      throw new Error(longJson?.error?.message ?? 'فشل الحصول على Threads long-lived token');
    }

    const profileUrl = new URL('https://graph.threads.net/v1.0/me');
    profileUrl.searchParams.set('fields', 'id,username');
    profileUrl.searchParams.set('access_token', String(longJson.access_token));
    const profileRes = await fetch(profileUrl.toString());
    const profile = await profileRes.json();
    if (!profileRes.ok || !profile.id) {
      throw new Error(profile?.error?.message ?? 'تعذّر جلب بيانات حساب Threads');
    }

    const expiresAt = typeof longJson.expires_in === 'number'
      ? new Date(Date.now() + longJson.expires_in * 1000).toISOString()
      : null;
    const username = String(profile.username ?? profile.id);

    const { data: account, error: upsertError } = await supabase
      .from('social_accounts')
      .upsert({
        workspace_id: stateRow.workspace_id,
        platform: 'threads',
        handle: username.startsWith('@') ? username : `@${username}`,
        display_name: username,
        status: 'connected',
        needs_reconnect: false,
        external_id: String(profile.id),
        metadata: { threads_user_id: String(profile.id) },
        last_sync_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,platform' })
      .select()
      .single();
    if (upsertError || !account) throw new Error(upsertError?.message ?? 'تعذّر حفظ حساب Threads');

    await supabase.from('social_account_tokens').upsert({
      account_id: account.id,
      access_token: String(longJson.access_token),
      refresh_token: null,
      token_type: 'threads_long_lived',
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

    return redirectToApp({ social: 'connected', platform: 'threads', threads: '1' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل ربط حساب Threads';
    await supabase.from('social_platform_apps').update({ last_error: message, status: 'error' }).eq('platform_key', 'threads');
    return redirectToApp({ social: 'error', message });
  }
}

// ---------------------------------------------------------------------------
// TikTok — canonical web Login Kit path. This connects identity/tokens into
// the same account model. Direct posting remains gated by TikTok creator
// settings and Content Posting API requirements in the product UI.
// ---------------------------------------------------------------------------
async function handleTikTokCallback(params: {
  code: string;
  app: Record<string, unknown>;
  secretRow: { app_secret: string };
  redirectUri: string;
  stateRow: Record<string, unknown>;
}): Promise<Response> {
  const { code, app, secretRow, redirectUri, stateRow } = params;
  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: String(app.app_id),
        client_secret: secretRow.app_secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new Error(tokenJson?.error_description ?? tokenJson?.error ?? 'فشل تبادل رمز الدخول مع TikTok');
    }

    const profileUrl = new URL('https://open.tiktokapis.com/v2/user/info/');
    profileUrl.searchParams.set('fields', 'open_id,display_name,avatar_url');
    const profileRes = await fetch(profileUrl.toString(), {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const profileJson = await profileRes.json();
    const profile = profileJson?.data?.user;
    if (!profileRes.ok || profileJson?.error?.code !== 'ok' || !profile?.open_id) {
      throw new Error(profileJson?.error?.message ?? 'تعذّر جلب بيانات حساب TikTok');
    }

    const expiresAt = typeof tokenJson.expires_in === 'number'
      ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
      : null;
    const displayName = String(profile.display_name ?? 'TikTok');

    const { data: account, error: upsertError } = await supabase
      .from('social_accounts')
      .upsert({
        workspace_id: stateRow.workspace_id,
        platform: 'tiktok',
        handle: displayName,
        display_name: displayName,
        status: 'connected',
        needs_reconnect: false,
        external_id: String(profile.open_id),
        metadata: {
          open_id: String(profile.open_id),
          picture: profile.avatar_url ?? null,
          granted_scopes: tokenJson.scope ?? null,
        },
        last_sync_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,platform' })
      .select()
      .single();
    if (upsertError || !account) throw new Error(upsertError?.message ?? 'تعذّر حفظ حساب TikTok');

    await supabase.from('social_account_tokens').upsert({
      account_id: account.id,
      access_token: String(tokenJson.access_token),
      refresh_token: tokenJson.refresh_token ? String(tokenJson.refresh_token) : null,
      token_type: 'Bearer',
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

    return redirectToApp({ social: 'connected', platform: 'tiktok', tiktok: '1' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل ربط حساب TikTok';
    await supabase.from('social_platform_apps').update({ last_error: message, status: 'error' }).eq('platform_key', 'tiktok');
    return redirectToApp({ social: 'error', message });
  }
}
