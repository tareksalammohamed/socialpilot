import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

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

async function graphJson(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = body.error as Record<string, unknown> | undefined;
    const message = typeof apiError?.message === 'string'
      ? apiError.message
      : `Meta Graph API ${response.status}`;
    throw new Error(message);
  }
  return body;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json(401, { error: 'Unauthorized' });

  const { data: authData, error: authError } = await supabase.auth.getUser(bearer);
  if (authError || !authData.user) return json(401, { error: 'Unauthorized' });

  const body = await req.json().catch(() => ({})) as {
    workspaceId?: string;
    wabaId?: string;
    phoneNumberId?: string;
    accessToken?: string;
  };
  const workspaceId = body.workspaceId?.trim();
  const wabaId = body.wabaId?.trim();
  const phoneNumberId = body.phoneNumberId?.trim();
  const accessToken = body.accessToken?.trim();

  if (!workspaceId || !wabaId || !phoneNumberId || !accessToken) {
    return json(400, { error: 'workspaceId و WABA ID و Phone Number ID و Access Token مطلوبين' });
  }

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', authData.user.id)
    .maybeSingle();

  if (!membership || !['owner', 'admin'].includes(String(membership.role))) {
    return json(403, { error: 'ربط واتساب متاح لمالك أو Admin مساحة العمل فقط' });
  }

  try {
    const phonesBody = await graphJson(
      `${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status`,
      accessToken,
    );

    const phones = Array.isArray(phonesBody.data)
      ? phonesBody.data as Array<Record<string, unknown>>
      : [];
    const phone = phones.find((item) => String(item.id ?? '') === phoneNumberId);
    if (!phone) {
      return json(400, {
        error: 'Phone Number ID لا يتبع WABA ID باستخدام هذا التوكن، راجع القيم والصلاحيات.',
      });
    }

    const subscribeBody = await graphJson(
      `${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      accessToken,
      { method: 'POST', body: '{}' },
    );
    if (subscribeBody.success !== true && subscribeBody.success !== 'true') {
      return json(502, { error: 'Meta لم تؤكد الاشتراك في Webhooks لهذا WABA' });
    }

    const displayPhone = typeof phone.display_phone_number === 'string'
      ? phone.display_phone_number
      : phoneNumberId;
    const verifiedName = typeof phone.verified_name === 'string'
      ? phone.verified_name
      : displayPhone;

    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .upsert({
        workspace_id: workspaceId,
        platform: 'whatsapp',
        external_id: phoneNumberId,
        handle: displayPhone,
        display_name: verifiedName,
        status: 'connected',
        needs_reconnect: false,
        metadata: {
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          display_phone_number: displayPhone,
          verified_name: verifiedName,
          quality_rating: phone.quality_rating ?? null,
          code_verification_status: phone.code_verification_status ?? null,
          name_status: phone.name_status ?? null,
          webhook_subscribed: true,
          connected_via: 'whatsapp-connect',
        },
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,platform' })
      .select()
      .single();

    if (accountError || !account) {
      throw new Error(accountError?.message ?? 'تعذّر حفظ حساب واتساب');
    }

    const { error: tokenError } = await supabase
      .from('social_account_tokens')
      .upsert({
        account_id: account.id,
        access_token: accessToken,
        refresh_token: null,
        token_type: 'whatsapp_system_user',
        expires_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' });

    if (tokenError) throw tokenError;

    await supabase.from('audit_logs').insert({
      workspace_id: workspaceId,
      user_id: authData.user.id,
      action: 'whatsapp_connected',
      entity: 'social_account',
      entity_id: account.id,
      detail: {
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        display_phone_number: displayPhone,
      },
    }).then(() => undefined);

    return json(200, {
      ok: true,
      account: {
        id: account.id,
        platform: account.platform,
        display_name: account.display_name,
        handle: account.handle,
        status: account.status,
        metadata: account.metadata,
      },
      webhookSubscribed: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'فشل ربط واتساب';
    return json(502, { error: message });
  }
});
