import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const BRAND_MEMORY_TOOLS = new Set<ToolName>(['read_brand_memory', 'update_brand_memory', 'read_brand_dna', 'enforce_brand_rules']);

// Matches the CHECK constraint on brand_memory.type in the schema exactly —
// an invalid type would fail the DB insert, so we validate here first and
// return a clear tool error instead of a raw Postgres error.
const VALID_MEMORY_TYPES = new Set(['preference', 'performance', 'decision', 'rejection', 'approval', 'edit_pattern']);

const BRAND_DNA_COLUMNS =
  'id, status, basics, identity, tone, audience, content, visual, platforms, positioning, preferred_phrases, forbidden_phrases, cta_style, updated_at';

async function loadBrandDna(supabase: SupabaseClient, workspaceId: string) {
  return supabase.from('brand_dna').select(BRAND_DNA_COLUMNS).eq('workspace_id', workspaceId).maybeSingle();
}

function normalizePhrase(value: string): string {
  // Loose Arabic/Latin normalisation so a forbidden phrase is still caught
  // with different hamza/ya/ta-marbuta spellings, tashkeel or casing.
  return value
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function executeBrandMemoryTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  if (call.name === 'read_brand_dna') {
    const { data, error } = await loadBrandDna(supabase, context.workspaceId);
    if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };
    if (!data) {
      return { callId: call.id, name: call.name, ok: false, error: 'مفيش Brand DNA للمساحة دي لسه — كمّل إعداد هوية البراند الأول.' };
    }
    return { callId: call.id, name: call.name, ok: true, output: { brandDna: data } };
  }

  if (call.name === 'enforce_brand_rules') {
    // Deterministic check (no LLM): scans the variant text/CTA/hashtags for
    // forbidden phrases from Brand DNA and reports which preferred phrases
    // are absent. Read-only.
    const contentId = String(call.input.contentId ?? context.currentContentId ?? '');
    if (!contentId) {
      return { callId: call.id, name: call.name, ok: false, error: 'محتاج contentId عشان أفحص المحتوى على قواعد البراند.' };
    }
    const { data: brand, error: brandError } = await loadBrandDna(supabase, context.workspaceId);
    if (brandError) return { callId: call.id, name: call.name, ok: false, error: brandError.message };
    if (!brand) {
      return { callId: call.id, name: call.name, ok: false, error: 'مفيش Brand DNA للمساحة دي عشان أفحص عليه.' };
    }
    let variantQuery = supabase
      .from('content_variants')
      .select('id, platform, text, cta, hashtags')
      .eq('content_id', contentId)
      .eq('workspace_id', context.workspaceId);
    const platform = (call.input.platform as string | undefined) ?? context.selectedPlatform;
    if (platform) variantQuery = variantQuery.eq('platform', platform);
    const { data: variantRows, error: variantError } = await variantQuery;
    if (variantError) return { callId: call.id, name: call.name, ok: false, error: variantError.message };
    const variants = (variantRows ?? []) as { id: string; platform: string; text: string; cta: string | null; hashtags: string[] | null }[];
    if (variants.length === 0) {
      return { callId: call.id, name: call.name, ok: false, error: 'مفيش نسخة محتوى بالـid ده.' };
    }

    const tone = (brand.tone ?? {}) as Record<string, unknown>;
    const toStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
    const forbidden = [...new Set([...toStrings(brand.forbidden_phrases), ...toStrings(tone.forbidden_phrases)])];
    const preferred = [...new Set([...toStrings(brand.preferred_phrases), ...toStrings(tone.preferred_phrases)])];

    const report = variants.map((v) => {
      const haystack = normalizePhrase([v.text, v.cta ?? '', ...(Array.isArray(v.hashtags) ? v.hashtags : [])].join(' \n '));
      const violations = forbidden.filter((phrase) => haystack.includes(normalizePhrase(phrase)));
      const preferredUsed = preferred.filter((phrase) => haystack.includes(normalizePhrase(phrase)));
      return { variantId: v.id, platform: v.platform, passes: violations.length === 0, violations, preferredUsed };
    });
    return {
      callId: call.id, name: call.name, ok: true,
      output: {
        passes: report.every((r) => r.passes),
        forbiddenPhrasesChecked: forbidden.length,
        report,
        note: forbidden.length === 0 ? 'مفيش عبارات ممنوعة معرّفة في Brand DNA، فالفحص ماغطاش غير ده.' : undefined,
      },
    };
  }

  if (call.name === 'read_brand_memory') {
    const { data, error } = await supabase
      .from('brand_memory')
      .select('type, key, value, confidence, evidence_count')
      .eq('workspace_id', context.workspaceId)
      .order('updated_at', { ascending: false })
      .limit(30);
    if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };
    return { callId: call.id, name: call.name, ok: true, output: { memory: data ?? [] } };
  }

  // update_brand_memory
  const patternType = String(call.input.patternType ?? '');
  const detail = String(call.input.detail ?? '');
  const key = String(call.input.key ?? patternType);
  if (!VALID_MEMORY_TYPES.has(patternType)) {
    return {
      callId: call.id, name: call.name, ok: false,
      error: `patternType لازم يكون واحد من: ${[...VALID_MEMORY_TYPES].join(', ')}`,
    };
  }
  if (!detail) {
    return { callId: call.id, name: call.name, ok: false, error: 'محتاج تفاصيل (detail) عشان نسجل الذاكرة.' };
  }

  // If a memory row with the same (workspace, type, key) already exists,
  // strengthen it (bump evidence_count) instead of creating a duplicate —
  // this is what lets repeated edits become a real learned pattern.
  const { data: existing } = await supabase
    .from('brand_memory')
    .select('id, evidence_count')
    .eq('workspace_id', context.workspaceId)
    .eq('type', patternType)
    .eq('key', key)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('brand_memory')
      .update({
        value: detail,
        evidence_count: (existing.evidence_count ?? 1) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };
    return { callId: call.id, name: call.name, ok: true, output: { id: existing.id, reinforced: true } };
  }

  const { data: inserted, error } = await supabase
    .from('brand_memory')
    .insert({
      workspace_id: context.workspaceId,
      type: patternType,
      key,
      value: detail,
      source: 'agent',
    })
    .select('id')
    .single();
  if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };
  return { callId: call.id, name: call.name, ok: true, output: { id: inserted.id, reinforced: false } };
}
