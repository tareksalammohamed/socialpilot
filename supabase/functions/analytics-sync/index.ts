import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { metricNumber, normalizeXMetrics } from '../_shared/analytics-math.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
const META_GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const LINKEDIN_API_VERSION = Deno.env.get('LINKEDIN_API_VERSION') ?? '202607';
const LINKEDIN_RESTLI_PROTOCOL_VERSION = '2.0.0';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

type Job = {
  id: string;
  workspace_id: string;
  variant_id: string | null;
  calendar_item_id: string | null;
  external_post_id: string | null;
  platform: string | null;
  published_at: string | null;
  status?: string | null;
  last_attempt_at?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
};

type Account = {
  id: string;
  external_id?: string | null;
  page_id?: string | null;
  ig_user_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

type InsightRow = {
  workspace_id: string;
  content_id: string | null;
  variant_id: string | null;
  publishing_job_id: string;
  metric: string;
  value: number;
  timestamp: string;
  platform: string;
  external_post_id: string;
  source: string;
  fetched_at: string;
};

async function fetchWithRetry(input: string | URL, init: RequestInit, maxAttempts = 2): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetch(input, { ...init, signal: AbortSignal.timeout(12_000) });
    const retryable = response.status === 429 || response.status >= 500;
    if (response.ok || !retryable || attempt === maxAttempts) return response;
    const retryAfter = Number(response.headers.get('retry-after') ?? 0);
    const waitMs = Math.min(5_000, retryAfter > 0 ? retryAfter * 1_000 : 250 * (2 ** (attempt - 1)));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return response as Response;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = [record.message, record.error_description, record.detail, record.hint, record.code]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (message) return message;
  }
  return 'sync failed';
}

async function readJsonResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error;
    const errorMessageValue = typeof error === 'string'
      ? error
      : error && typeof error === 'object'
        ? (error as Record<string, unknown>).message
        : undefined;
    const detail = typeof body.detail === 'string' ? body.detail : typeof body.title === 'string' ? body.title : undefined;
    const topLevelMessage = typeof body.message === 'string' ? body.message : undefined;
    const serviceErrorCode = typeof body.serviceErrorCode === 'number' || typeof body.serviceErrorCode === 'string'
      ? String(body.serviceErrorCode)
      : undefined;
    const message = String(errorMessageValue ?? detail ?? topLevelMessage ?? fallback);
    throw new Error(`${fallback} (${response.status}${serviceErrorCode ? `/${serviceErrorCode}` : ''}): ${message}`);
  }
  return body;
}

async function graphGet(path: string, accessToken: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchWithRetry(url.toString(), { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } });
  return readJsonResponse(response, 'Meta Graph API request failed');
}

async function markAccountExpired(accountId: string): Promise<void> {
  await supabase.from('social_accounts').update({ status: 'expired', needs_reconnect: true }).eq('id', accountId);
}

async function accessTokenFor(account: Account, label: string): Promise<string> {
  const { data: token } = await supabase
    .from('social_account_tokens')
    .select('access_token,refresh_token,expires_at')
    .eq('account_id', account.id)
    .maybeSingle();
  if (!token?.access_token) throw new Error(`${label} account token missing`);
  if (token.expires_at && new Date(token.expires_at).getTime() < Date.now() + 60_000) {
    await markAccountExpired(account.id);
    throw new Error(`${label} token expired; reconnect the account`);
  }
  return String(token.access_token);
}

async function xToken(accountId: string): Promise<string> {
  const { data: token } = await supabase.from('social_account_tokens').select('access_token,refresh_token,expires_at').eq('account_id', accountId).maybeSingle();
  if (!token?.access_token) throw new Error('X account token missing');
  const expired = token.expires_at && new Date(token.expires_at).getTime() < Date.now() + 60_000;
  if (!expired) return token.access_token;
  if (!token.refresh_token) throw new Error('X token expired and cannot be refreshed');
  const { data: app } = await supabase.from('social_platform_apps').select('app_id').eq('platform_key', 'x').maybeSingle();
  const { data: secret } = await supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'x').maybeSingle();
  if (!app?.app_id || !secret?.app_secret) throw new Error('X OAuth configuration incomplete');
  const response = await fetchWithRetry('https://api.twitter.com/2/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${app.app_id}:${secret.app_secret}`)}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: app.app_id }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(body?.error_description ?? 'X token refresh failed');
  await supabase.from('social_account_tokens').update({ access_token: body.access_token, refresh_token: body.refresh_token ?? token.refresh_token, expires_at: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString() }).eq('account_id', accountId);
  return body.access_token;
}

async function getAccount(workspaceId: string, platform: string): Promise<Account> {
  const { data: account, error } = await supabase
    .from('social_accounts')
    .select('id,external_id,page_id,ig_user_id,metadata')
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .eq('status', 'connected')
    .maybeSingle();
  if (error || !account) throw new Error(`No connected ${platform} account`);
  return account as Account;
}

async function variantContext(job: Job): Promise<{ contentId: string | null }> {
  if (!job.variant_id) return { contentId: null };
  const { data: variant } = await supabase.from('content_variants').select('content_id').eq('id', job.variant_id).eq('workspace_id',job.workspace_id).maybeSingle();
  return { contentId: variant?.content_id ?? null };
}

async function upsertRows(rows: InsightRow[]): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await supabase.from('post_insights').upsert(rows, { onConflict: 'workspace_id,external_post_id,platform,metric,timestamp', ignoreDuplicates: false });
  if (error) throw error;
  return rows.length;
}

function makeRow(job: Job, contentId: string | null, platform: string, source: string, metric: string, value: unknown, timestamp: string | null | undefined): InsightRow | null {
  const numeric = metricNumber(value);
  if (numeric === null) return null;
  if(!timestamp || !Number.isFinite(Date.parse(timestamp)))throw new Error('Published timestamp missing');
  return {
    workspace_id: job.workspace_id,
    content_id: contentId,
    variant_id: job.variant_id,
    publishing_job_id: job.id,
    metric,
    value: numeric,
    timestamp,
    platform,
    external_post_id: job.external_post_id as string,
    source,
    fetched_at: new Date().toISOString(),
  };
}

async function syncX(job: Job): Promise<number> {
  if (!job.external_post_id) return 0;
  const context = await variantContext(job);
  const account = await getAccount(job.workspace_id, 'x');
  const token = await xToken(account.id);
  const response = await fetchWithRetry(`https://api.twitter.com/2/tweets/${encodeURIComponent(job.external_post_id)}?tweet.fields=public_metrics,created_at`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok || !body.data) throw new Error(body?.detail ?? 'X insights request failed');
  const metrics = normalizeXMetrics(body.data.public_metrics ?? {});
  const timestamp = body.data.created_at ?? job.published_at ?? job.created_at ?? job.completed_at;
  const rows = Object.entries(metrics).map(([metric, value]) => makeRow(job, context.contentId, 'x', 'x_api', metric, value, timestamp)).filter((row): row is InsightRow => Boolean(row));
  if (!rows.length) throw new Error('X returned no post-level metrics for this post');
  return upsertRows(rows);
}

async function syncFacebook(job: Job, warnings: string[]): Promise<number> {
  if (!job.external_post_id) return 0;
  const context = await variantContext(job);
  const account = await getAccount(job.workspace_id, 'facebook');
  const token = await accessTokenFor(account, 'Facebook');
  const post = await graphGet(`${META_GRAPH_VERSION}/${encodeURIComponent(job.external_post_id)}`, token, {
    fields: 'created_time,shares,reactions.limit(0).summary(true),comments.limit(0).summary(true)',
  });
  const timestamp = typeof post.created_time === 'string' ? post.created_time : job.published_at ?? job.created_at ?? job.completed_at;
  const rows: InsightRow[] = [];
  const shares = (post.shares as Record<string, unknown> | undefined)?.count;
  const reactions = ((post.reactions as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined)?.total_count;
  const comments = ((post.comments as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined)?.total_count;
  for (const [metric, value] of [['shares', shares], ['reactions', reactions], ['comments', comments]] as Array<[string, unknown]>) {
    const row = makeRow(job, context.contentId, 'facebook', 'facebook_graph_api', metric, value, timestamp);
    if (row) rows.push(row);
  }

  try {
    const clickInsights = await graphGet(`${META_GRAPH_VERSION}/${encodeURIComponent(job.external_post_id)}/insights`, token, { metric: 'post_clicks' });
    for (const item of (clickInsights.data as Array<Record<string, unknown>> | undefined) ?? []) {
      const values = item.values as Array<Record<string, unknown>> | undefined;
      const row = makeRow(job, context.contentId, 'facebook', 'facebook_graph_api', 'clicks', values?.[0]?.value, timestamp);
      if (row) rows.push(row);
    }
  } catch (error) {
    warnings.push(`clicks: ${errorMessage(error)}`);
  }

  if (!rows.length) throw new Error('Facebook returned no post-level insights for this post');
  return upsertRows(rows);
}

async function syncInstagram(job: Job, warnings: string[]): Promise<number> {
  if (!job.external_post_id) return 0;
  const context = await variantContext(job);
  const account = await getAccount(job.workspace_id, 'instagram');
  const token = await accessTokenFor(account, 'Instagram');
  const externalPostId=job.external_post_id;
  const metricNames = ['comments', 'likes', 'reach', 'saved', 'shares', 'total_interactions', 'views'];
  const rows: InsightRow[] = [];
  const metricErrors: string[] = [];

  await Promise.all(metricNames.map(async metric => {
    try {
      const body = await graphGet(`${META_GRAPH_VERSION}/${encodeURIComponent(externalPostId)}/insights`, token, { metric });
      const item = (body.data as Array<Record<string, unknown>> | undefined)?.[0];
      const values = item?.values as Array<Record<string, unknown>> | undefined;
      const value = (item?.total_value as Record<string, unknown> | undefined)?.value ?? values?.[0]?.value;
      const timestamp = job.published_at ?? job.created_at;
      if(!timestamp) throw new Error('Published timestamp missing');
      const row = makeRow(job, context.contentId, 'instagram', 'instagram_graph_api', metric, value, timestamp);
      if (row) rows.push(row);
    } catch (error) {
      metricErrors.push(`${metric}: ${error instanceof Error ? error.message : 'unavailable'}`);
    }
  }));

  warnings.push(...metricErrors);
  if (!rows.length) throw new Error(`Instagram returned no available media insights${metricErrors.length ? ` (${metricErrors.slice(0, 2).join('; ')})` : ''}`);
  return upsertRows(rows);
}

async function syncLinkedIn(job: Job, warnings: string[]): Promise<number> {
  if (!job.external_post_id) return 0;
  const context = await variantContext(job);
  const account = await getAccount(job.workspace_id, 'linkedin');
  const token = await accessTokenFor(account, 'LinkedIn');
  const externalUrn = job.external_post_id.startsWith('urn:li:') ? job.external_post_id : `urn:li:share:${job.external_post_id}`;
  const entityType = externalUrn.startsWith('urn:li:ugcPost:') ? 'ugc' : 'share';
  // Map LinkedIn's queryType constants to the same plural metric vocabulary the other
  // platforms use (impressions, reach, shares, reactions, comments). Storing the raw
  // lowercased API name ("impression", "members_reached", ...) previously meant these
  // rows never matched METRIC_LABELS/ENGAGEMENT_METRICS in the dashboard and were
  // effectively invisible even though the sync itself succeeded.
  const metrics: Array<[string, string]> = [
    ['IMPRESSION', 'impressions'],
    ['MEMBERS_REACHED', 'reach'],
    ['RESHARE', 'shares'],
    ['REACTION', 'reactions'],
    ['COMMENT', 'comments'],
  ];
  const rows: InsightRow[] = [];

  await Promise.all(metrics.map(async ([queryType, metric]) => {
    try {
    const url = new URL('https://api.linkedin.com/rest/memberCreatorPostAnalytics');
    url.searchParams.set('q', 'entity');
    url.searchParams.set('entity', `(${entityType}:${externalUrn})`);
    url.searchParams.set('queryType', queryType);
    url.searchParams.set('aggregation', 'TOTAL');
    const response = await fetchWithRetry(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Restli-Protocol-Version': LINKEDIN_RESTLI_PROTOCOL_VERSION,
        'Linkedin-Version': LINKEDIN_API_VERSION,
      },
    });
    const body = await readJsonResponse(response, `LinkedIn ${queryType} analytics request failed`);
    const item = (body.elements as Array<Record<string, unknown>> | undefined)?.[0];
    const row = makeRow(job, context.contentId, 'linkedin', 'linkedin_member_creator_post_analytics', metric, item?.count, job.published_at ?? job.created_at ?? job.completed_at);
    if (row) rows.push(row);
    } catch(error) { warnings.push(`${metric}: ${errorMessage(error)}`); }
  }));

  if (!rows.length) throw new Error(warnings.join('; ') || 'LinkedIn returned no post-level analytics for this post');
  return upsertRows(rows);
}

Deno.serve(async (req: Request) => {
 if(req.method==='OPTIONS') return new Response(null,{status:200,headers:corsHeaders});
 if(req.method!=='POST') return json(405,{error:'Method not allowed'});
 const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
 const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 let body:{workspaceId?:string;cursor?:number}={};
 try{body=await req.json();}catch{return json(400,{error:'Invalid JSON'});}
 if(!body.workspaceId) return json(400,{error:'workspaceId is required'});
 if(token!==serviceKey || !serviceKey){
  const {data:user}=await supabase.auth.getUser(token);
  if(!user.user) return json(401,{error:'Invalid authentication'});
  const client=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_ANON_KEY')??'',{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false}});
  const {data,error}=await client.rpc('enqueue_assistant_task',{p_workspace_id:body.workspaceId,p_kind:'analytics',p_payload:{message:'تحديث مؤشرات المنصات'},p_request_id:crypto.randomUUID()});
  return error?json(403,{error:error.message}):json(202,{ok:true,queued:true,taskId:data});
 }
 const {data:task}=await supabase.from('assistant_tasks').select('id,user_id,locked_at').eq('id',req.headers.get('X-Assistant-Task')??'').eq('worker_id',req.headers.get('X-Assistant-Worker')??'').eq('workspace_id',body.workspaceId).eq('task_kind','analytics').eq('status','running').maybeSingle();
 if(!task || !task.locked_at || Date.now()-new Date(task.locked_at).getTime()>=10*60_000) return json(403,{error:'Invalid task lease'});
 const {data:member}=await supabase.from('workspace_members').select('role').eq('workspace_id',body.workspaceId).eq('user_id',task.user_id).maybeSingle();
 if(!member) return json(403,{error:'Workspace access denied'});
 const cursor=Math.max(0,Math.floor(Number(body.cursor)||0));
 const {data:jobs,error}=await supabase.from('latest_analytics_jobs').select('*').eq('workspace_id',body.workspaceId).order('published_at',{ascending:true}).order('id').range(cursor,cursor+1);
 if(error) return json(500,{error:error.message});
 let synced=0;
 const errors:{jobId:string;platform:string|null;error:string}[]=[];
 const unsupportedPlatforms=new Set<string>();
 for(const job of (jobs??[]) as Job[]){
  const warnings:string[]=[];
  try{
   if(job.platform==='x') synced+=await syncX(job);
   else if(job.platform==='facebook') synced+=await syncFacebook(job,warnings);
   else if(job.platform==='instagram') synced+=await syncInstagram(job,warnings);
   else if(job.platform==='linkedin') synced+=await syncLinkedIn(job,warnings);
   else if(job.platform) unsupportedPlatforms.add(job.platform);
   if(warnings.length) errors.push({jobId:job.id,platform:job.platform,error:warnings.join('; ')});
  }catch(error){errors.push({jobId:job.id,platform:job.platform,error:errorMessage(error)});}
 }
 return json(200,{ok:true,synced,attempted:jobs?.length??0,nextCursor:cursor+(jobs?.length??0),hasMore:jobs?.length===2,errors,unsupportedPlatforms:[...unsupportedPlatforms]});
});
