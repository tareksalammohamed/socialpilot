import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function bodyVariableCount(text: string): number {
  const matches = Array.from(text.matchAll(/{{\s*(\d+)\s*}}/g));
  return matches.reduce((max, match) => Math.max(max, Number(match[1]) || 0), 0);
}

function hasDynamicUnsupportedComponents(components: Array<Record<string, unknown>>): boolean {
  for (const component of components) {
    const type = String(component.type ?? '').toUpperCase();
    if (type === 'HEADER') {
      const format = String(component.format ?? 'TEXT').toUpperCase();
      const text = typeof component.text === 'string' ? component.text : '';
      if (format !== 'TEXT' || /{{\s*\d+\s*}}/.test(text)) return true;
    }
    if (type === 'BUTTONS') {
      const buttons = Array.isArray(component.buttons)
        ? component.buttons as Array<Record<string, unknown>>
        : [];
      for (const button of buttons) {
        const buttonType = String(button.type ?? '').toUpperCase();
        const url = typeof button.url === 'string' ? button.url : '';
        if ((buttonType === 'URL' && /{{\s*\d+\s*}}/.test(url)) || buttonType === 'COPY_CODE') {
          return true;
        }
      }
    }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth.user) return json(401, { error: 'Unauthorized' });

  const body = await req.json().catch(() => ({})) as { conversationId?: string };
  if (!body.conversationId) return json(400, { error: 'conversationId مطلوب' });

  const { data: conversation } = await supabase
    .from('inbox_conversations')
    .select('id,workspace_id,account_id,platform')
    .eq('id', body.conversationId)
    .maybeSingle();

  if (!conversation) return json(404, { error: 'المحادثة غير موجودة' });
  if (conversation.platform !== 'whatsapp') return json(400, { error: 'القوالب متاحة لمحادثات WhatsApp فقط' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', conversation.workspace_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!membership) return json(403, { error: 'Forbidden' });

  const [{ data: account }, { data: tokenRow }] = await Promise.all([
    supabase.from('social_accounts').select('metadata').eq('id', conversation.account_id).maybeSingle(),
    supabase.from('social_account_tokens').select('access_token,expires_at').eq('account_id', conversation.account_id).maybeSingle(),
  ]);
  const metadata = (account?.metadata ?? {}) as Record<string, unknown>;
  const wabaId = typeof metadata.waba_id === 'string' ? metadata.waba_id : '';
  const accessToken = tokenRow?.access_token as string | undefined;

  if (!wabaId || !accessToken) return json(409, { error: 'حساب WhatsApp يحتاج إعادة ربط' });
  if (tokenRow?.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now() + 60_000) {
    return json(409, { error: 'انتهت صلاحية WhatsApp — أعد ربط الحساب' });
  }

  const url = new URL(`${GRAPH}/${encodeURIComponent(wabaId)}/message_templates`);
  url.searchParams.set('status', 'APPROVED');
  url.searchParams.set('fields', 'id,name,status,category,language,components');
  url.searchParams.set('limit', '100');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = payload.error as Record<string, unknown> | undefined;
    return json(response.status, {
      error: typeof apiError?.message === 'string' ? apiError.message : 'تعذّر تحميل قوالب WhatsApp',
    });
  }

  const templates = (Array.isArray(payload.data) ? payload.data : [])
    .map((raw) => raw as Record<string, unknown>)
    .filter((raw) => String(raw.status ?? '').toUpperCase() === 'APPROVED')
    .map((raw) => {
      const components = Array.isArray(raw.components)
        ? raw.components as Array<Record<string, unknown>>
        : [];
      const bodyComponent = components.find((component) => String(component.type ?? '').toUpperCase() === 'BODY');
      const bodyText = typeof bodyComponent?.text === 'string' ? bodyComponent.text : '';
      const variableCount = bodyVariableCount(bodyText);
      const unsupportedDynamic = hasDynamicUnsupportedComponents(components);
      return {
        id: String(raw.id ?? ''),
        name: String(raw.name ?? ''),
        language: String(raw.language ?? ''),
        category: String(raw.category ?? ''),
        status: String(raw.status ?? ''),
        body: bodyText,
        variableCount,
        sendable: !unsupportedDynamic,
        unsupportedReason: unsupportedDynamic
          ? 'القالب يحتوي Header أو Button ديناميكي يحتاج دعم ميديا/بارامترات متقدمة.'
          : null,
      };
    })
    .filter((template) => template.name && template.language);

  return json(200, { templates });
});
