import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { routeAndRun } from '../router.ts';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const ANALYTICS_TOOLS = new Set<ToolName>([
  'compare_platforms', 'analyze_content', 'detect_trends', 'recommend_next_content',
]);

type InsightRow = { metric: string; value: number; platform: string; timestamp: string; content_id: string | null; variant_id: string | null };

async function fetchInsights(supabase: SupabaseClient, workspaceId: string, sinceIso: string, untilIso?: string) {
  let q = supabase
    .from('post_insights')
    .select('metric, value, platform, timestamp, content_id, variant_id')
    .eq('workspace_id', workspaceId)
    .gte('timestamp', sinceIso);
  if (untilIso) q = q.lt('timestamp', untilIso);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as InsightRow[];
}

function sumByPlatform(rows: InsightRow[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    out[r.platform] ??= {};
    out[r.platform][r.metric] = (out[r.platform][r.metric] ?? 0) + Number(r.value);
  }
  return out;
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export async function executeAnalyticsTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  const rangeDays = Number(call.input.rangeDays ?? 30);

  if (call.name === 'compare_platforms') {
    const rows = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays));
    if (rows.length === 0) {
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, byPlatform: {}, note: 'مفيش بيانات أداء مسجلة في المدة دي.' } };
    }
    const byPlatform = sumByPlatform(rows);
    try {
      const result = await routeAndRun(supabase, {
        requiredCapabilities: ['text_generation'],
        systemPrompt: 'أنت Analytics Agent. عندك أرقام أداء حقيقية مجمّعة بالمنصة. اكتب مقارنة قصيرة (2-3 جمل بالعربي) بناءً على الأرقام دي بالظبط — ممنوع تخترع رقم مش موجود.',
        userPrompt: `الأرقام (آخر ${rangeDays} يوم):\n${JSON.stringify(byPlatform, null, 2)}`,
        jsonMode: false,
      });
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, byPlatform, summary: result.content.trim() } };
    } catch {
      return { callId: call.id, name: call.name, ok: true, output: { rangeDays, byPlatform } };
    }
  }

  if (call.name === 'detect_trends') {
    const current = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays));
    const previous = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays * 2), daysAgoIso(rangeDays));
    const curByPlatform = sumByPlatform(current);
    const prevByPlatform = sumByPlatform(previous);
    const changes: Record<string, Record<string, { current: number; previous: number; changePct: number | null }>> = {};
    for (const platform of new Set([...Object.keys(curByPlatform), ...Object.keys(prevByPlatform)])) {
      changes[platform] = {};
      const metrics = new Set([...Object.keys(curByPlatform[platform] ?? {}), ...Object.keys(prevByPlatform[platform] ?? {})]);
      for (const metric of metrics) {
        const curVal = curByPlatform[platform]?.[metric] ?? 0;
        const prevVal = prevByPlatform[platform]?.[metric] ?? 0;
        changes[platform][metric] = { current: curVal, previous: prevVal, changePct: prevVal > 0 ? Math.round(((curVal - prevVal) / prevVal) * 100) : null };
      }
    }
    return { callId: call.id, name: call.name, ok: true, output: { rangeDays, changes } };
  }

  // analyze_content & recommend_next_content share the same base query:
  // join insights to their variant to see which platform/hashtag-presence/
  // CTA-presence combos correlate with higher engagement.
  const rows = await fetchInsights(supabase, context.workspaceId, daysAgoIso(rangeDays));
  const variantIds = [...new Set(rows.map((r) => r.variant_id).filter((id): id is string => !!id))];
  if (variantIds.length === 0) {
    return { callId: call.id, name: call.name, ok: true, output: { rangeDays, note: 'مفيش بيانات أداء مربوطة بمنشورات محددة في المدة دي.' } };
  }
  const { data: variants } = await supabase
    .from('content_variants')
    .select('id, platform, hashtags, cta, text')
    .in('id', variantIds);
  const variantById = new Map((variants ?? []).map((v: { id: string }) => [v.id, v]));

  const engagementByVariant: Record<string, number> = {};
  for (const r of rows) {
    if (!r.variant_id) continue;
    engagementByVariant[r.variant_id] = (engagementByVariant[r.variant_id] ?? 0) + Number(r.value);
  }
  const ranked = Object.entries(engagementByVariant).sort((a, b) => b[1] - a[1]);
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
        userPrompt: `الأعلى أداءً:\n${JSON.stringify(top)}\n\nالأقل أداءً:\n${JSON.stringify(bottom)}`,
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
      userPrompt: `الأعلى أداءً:\n${JSON.stringify(top)}\n\nالأقل أداءً:\n${JSON.stringify(bottom)}`,
      jsonMode: false,
    });
    return { callId: call.id, name: call.name, ok: true, output: { rangeDays, recommendation: result.content.trim(), basedOn: { top, bottom } } };
  } catch (err) {
    return { callId: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
