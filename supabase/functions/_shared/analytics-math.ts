export type Insight = {
  metric: string; value: number; timestamp: string; platform: string;
  external_post_id: string | null; content_id: string | null; variant_id: string | null;
  fetched_at: string; published_at?: string | null;
};

export function metricNumber(value: unknown): number | null {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function postKey(row: Pick<Insight,'platform'|'external_post_id'|'variant_id'|'content_id'>): string {
  return `${row.platform}:${row.external_post_id ?? row.variant_id ?? row.content_id ?? 'unknown'}`;
}

/** Counters are lifetime snapshots, not increments. Retain one newest reading
 * per post/metric, including a valid zero and a counter corrected downward. */
export function latestInsights(rows: Insight[]): Insight[] {
  const latest = new Map<string, Insight>();
  for (const row of rows) {
    if (metricNumber(row.value) === null || (!row.external_post_id && !row.variant_id && !row.content_id)) continue;
    const key = `${postKey(row)}:${row.metric}`;
    const prior = latest.get(key);
    if (!prior || Date.parse(row.fetched_at) >= Date.parse(prior.fetched_at)) latest.set(key,row);
  }
  return [...latest.values()];
}

/** Aggregate and component counters overlap. Prefer the platform aggregate;
 * otherwise reactions includes likes, while clicks remain a separate KPI. */
export function interactionCount(metrics: Record<string, number>): number | null {
  if (metrics.total_interactions != null) return metrics.total_interactions;
  if (metrics.engagements != null) return metrics.engagements;
  const parts = [metrics.reactions ?? metrics.likes, metrics.comments, metrics.shares, metrics.saved];
  return parts.some(value => value != null) ? parts.reduce<number>((sum,value) => sum+(value??0),0) : null;
}

export function aggregateInsights(rows: Insight[]) {
  const groups = new Map<string,{ key: string; platform: string; contentId: string|null; variantId: string|null; publishedAt: string; metrics: Record<string,number> }>();
  const totals: Record<string,number> = {};
  const latest = latestInsights(rows);
  for (const row of latest) {
    const key=postKey(row);
    const group=groups.get(key) ?? { key,platform:row.platform,contentId:row.content_id,variantId:row.variant_id,publishedAt:row.published_at??row.timestamp,metrics:{} };
    group.metrics[row.metric]=Number(row.value);
    groups.set(key,group);
    // Account-level stock counters must never be summed across posts.
    if (!['followers','engagements','total_interactions'].includes(row.metric)) totals[row.metric]=(totals[row.metric]??0)+Number(row.value);
  }
  const posts=[...groups.values()].map(group=>({...group,engagement:interactionCount(group.metrics)}));
  const measured=posts.filter(post=>post.engagement!==null);
  if (measured.length) totals.engagements=measured.reduce((sum,post)=>sum+post.engagement!,0);
  const byPlatform: Record<string,Record<string,number>>={};
  for (const post of posts) {
    const metrics=byPlatform[post.platform]??={};
    for (const [key,value] of Object.entries(post.metrics)) if(!['followers','engagements','total_interactions'].includes(key)) metrics[key]=(metrics[key]??0)+value;
    if(post.engagement!==null) metrics.engagements=(metrics.engagements??0)+post.engagement;
  }
  const timestamps=latest.map(row=>row.fetched_at).filter(value=>Number.isFinite(Date.parse(value))).sort();
  return { posts,totals,byPlatform,readings:latest.length,measuredPosts:measured.length,lastFetched:timestamps[timestamps.length-1]??null,oldestFetched:timestamps[0]??null };
}

export function dateInZone(value: string, zone: string): string {
  const parts=new Intl.DateTimeFormat('en-CA',{ timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date(value));
  const get=(type:string)=>parts.find(part=>part.type===type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function hourInZone(value: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB',{ timeZone:zone,hour:'2-digit',hourCycle:'h23' }).format(new Date(value))+':00';
}

export function normalizeXMetrics(raw:Record<string,unknown>):Record<string,number>{
 const out:Record<string,number>={};
 for(const [field,metric] of [['impression_count','impressions'],['like_count','likes'],['reply_count','comments'],['bookmark_count','saved']]){const value=metricNumber(raw[field]);if(value!==null)out[metric]=value;}
 const retweets=metricNumber(raw.retweet_count),quotes=metricNumber(raw.quote_count);
 if(retweets!==null&&quotes!==null)out.shares=retweets+quotes;
 return out;
}

export async function allPages<T>(query: (from:number,to:number) => PromiseLike<{data:T[]|null;error:{message:string}|null}>): Promise<T[]> {
  const rows:T[]=[];
  for(let from=0;;from+=1000){
    const result=await query(from,from+999);
    if(result.error) throw new Error(result.error.message);
    rows.push(...(result.data??[]));
    if((result.data?.length??0)<1000) return rows;
  }
}
