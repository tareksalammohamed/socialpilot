import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { routeAndRun } from '../router.ts';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const ANALYTICS_TOOLS = new Set<ToolName>([
  'compare_platforms', 'analyze_content', 'detect_trends', 'recommend_next_content',
]);

import { aggregateInsights, type Insight } from '../../_shared/analytics-math.ts';

async function fetchInsights(supabase: SupabaseClient, workspaceId: string, sinceIso: string, untilIso?: string): Promise<Insight[]> {
  const rows: Insight[]=[];
  for(let offset=0;;offset+=1000){
    let q=supabase.from('latest_post_insights').select('*').eq('workspace_id',workspaceId).gte('published_at',sinceIso).order('id').range(offset,offset+999);
    if(untilIso)q=q.lt('published_at',untilIso);
    const {data,error}=await q;if(error)throw error;
    rows.push(...(data??[]));if((data??[]).length<1000)return rows;
  }
}
function sumByPlatform(rows: Insight[]){return aggregateInsights(rows).byPlatform;}
const measurementBasis='Latest lifetime counters for posts published in the selected period. Reach is a sum per post, not unique people. Missing metrics are unavailable. Cohorts have different ages and sample sizes; comparisons do not measure daily growth or prove causation.';

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export async function executeAnalyticsTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  const rangeDays = Number(call.input.rangeDays ?? 30);
  if(!Number.isInteger(rangeDays)||rangeDays<1||rangeDays>365)return {callId:call.id,name:call.name,ok:false,error:"invalid_range_days"};

  if (call.name === 'compare_platforms') {
    const rows = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays));
    if (rows.length === 0) {
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, measurementBasis, byPlatform: {}, note: 'مفيش بيانات أداء مسجلة في المدة دي.' } };
    }
    const byPlatform = sumByPlatform(rows);
    try {
      const result = await routeAndRun(supabase, {
        requiredCapabilities: ['text_generation'],
        systemPrompt: 'أنت Analytics Agent. عندك أرقام أداء حقيقية مجمّعة بالمنصة. اكتب مقارنة قصيرة (2-3 جمل بالعربي) بناءً على الأرقام دي بالظبط — ممنوع تخترع رقم مش موجود.',
        userPrompt: `الأرقام (آخر ${rangeDays} يوم):\n${JSON.stringify({measurementBasis,byPlatform}, null, 2)}`,
        jsonMode: false,
      });
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, measurementBasis, byPlatform, summary: result.content.trim() } };
    } catch {
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, measurementBasis, byPlatform } };
    }
  }

  if (call.name === 'detect_trends') {
    const current = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays));
    const previous = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays * 2), daysAgoIso(rangeDays));
    const curByPlatform = sumByPlatform(current);
    const prevByPlatform = sumByPlatform(previous);
    const changes: Record<string, Record<string, { current: number | null; previous: number | null; changePct: number | null }>> = {};
    for (const platform of new Set([...Object.keys(curByPlatform), ...Object.keys(prevByPlatform)])) {
      changes[platform] = {};
      const metrics = new Set([...Object.keys(curByPlatform[platform] ?? {}), ...Object.keys(prevByPlatform[platform] ?? {})]);
      for (const metric of metrics) {
        const curVal = curByPlatform[platform]?.[metric] ?? null;
        const prevVal = prevByPlatform[platform]?.[metric] ?? null;
        changes[platform][metric] = { current: curVal, previous: prevVal, changePct: prevVal !== null && prevVal > 0 && curVal !== null ? Math.round(((curVal - prevVal) / prevVal) * 100) : null };
      }
    }
    return { callId: call.id, name: call.name, ok: true, output: { rangeDays, measurementBasis, currentMeasuredPosts:aggregateInsights(current).measuredPosts, previousMeasuredPosts:aggregateInsights(previous).measuredPosts, changes } };
  }

  // analyze_content & recommend_next_content share the same base query:
  // join insights to their variant to see which platform/hashtag-presence/
  // CTA-presence combos correlate with higher engagement.
  const rows = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays));
  const variantIds = [...new Set(rows.map((r) => r.variant_id).filter((id): id is string => !!id))];
  if (variantIds.length === 0) {
    return { callId: call.id, name: call.name, ok: true, output: { rangeDays, note: 'مفيش بيانات أداء مربوطة بمنشورات محددة في المدة دي.' } };
  }
  const variants: {id:string;platform?:string;hashtags?:string[];cta?:string|null}[]=[];
  for(let offset=0;offset<variantIds.length;offset+=200){
    const {data,error}=await supabase.from('content_variants').select('id, platform, hashtags, cta').eq('workspace_id',context.workspaceId).in('id',variantIds.slice(offset,offset+200));
    if(error)throw error;variants.push(...(data??[]));
  }
  const variantById = new Map((variants ?? []).map((v: { id: string }) => [v.id, v]));

  const engagementByVariant: Record<string, number> = {};
  for(const post of aggregateInsights(rows).posts){
    if(post.variantId && post.engagement!==null)engagementByVariant[post.variantId]=(engagementByVariant[post.variantId]??0)+post.engagement;
  }
  const ranked = Object.entries(engagementByVariant).sort((a, b) => b[1] - a[1]);
  if(!ranked.length)return {callId:call.id,name:call.name,ok:true,output:{rangeDays,measurementBasis,note:'لا توجد مؤشرات تفاعل متاحة لتقييم المحتوى.'}};
  const top = ranked.slice(0, 5).map(([id, score]) => {
    const v = variantById.get(id) as { platform?: string; hashtags?: string[]; cta?: string | null } | undefined;
    return { platform: v?.platform, hasHashtags: (v?.hashtags?.length ?? 0) > 0, hasCta: !!v?.cta, score };
  });
  const bottom = ranked.slice(-5).map(([id, score]) => {
    const v = variantById.get(id) as { platform?: string; hashtags?: string[]; cta?: string | null } | undefined;
    return { platform: v?.platform, hasHashtags: (v?.hashtags?.length ?? 0) > 0, hasCta: !!v?.cta, score };
  });

  if (call.name === 'analyze_content') {
    try {
      const result = await routeAndRun(supabase, {
        requiredCapabilities: ['text_generation'],
        systemPrompt: 'أنت Content Analyst. عندك أعلى وأقل المنشورات أداءً (مع خصائصها الحقيقية: منصة، وجود هاشتاج، وجود CTA). اكتب ملاحظة قصيرة (2-3 جمل) عن النمط اللي بتلاحظه — بناءً على البيانات دي فقط.',
        userPrompt: `الأعلى أداءً:\n${JSON.stringify({measurementBasis,posts:top})}\n\nالأقل أداءً:\n${JSON.stringify(bottom)}`,
        jsonMode: false,
      });
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, top, bottom, insight: result.content.trim() } };
    } catch {
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, top, bottom } };
    }
  }

  // recommend_next_content
  try {
    const result = await routeAndRun(supabase, {
      requiredCapabilities: ['text_generation'],
      systemPrompt: 'أنت Content Strategy Agent. بناءً على أداء المنشورات الفعلي (الأعلى والأقل)، اقترح توصية عملية واحدة لنوع المحتوى اللي يستاهل تركيز أكبر الأسبوع الجاي. جملتين بالعربي بس، مبنية على البيانات المعطاة فقط.',
      userPrompt: `الأعلى أداءً:\n${JSON.stringify({measurementBasis,posts:top})}\n\nالأقل أداءً:\n${JSON.stringify(bottom)}`,
      jsonMode: false,
    });
    return { callId: call.id, name: call.name, ok: true, output: { rangeDays, recommendation: result.content.trim(), basedOn: { top, bottom } } };
  } catch (err) {
    return { callId: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
