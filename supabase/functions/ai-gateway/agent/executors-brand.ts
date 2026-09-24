import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const BRAND_MEMORY_TOOLS = new Set<ToolName>(['read_brand_memory', 'update_brand_memory']);

// Matches the CHECK constraint on brand_memory.type in the schema exactly —
// an invalid type would fail the DB insert, so we validate here first and
// return a clear tool error instead of a raw Postgres error.
const VALID_MEMORY_TYPES = new Set(['preference', 'performance', 'decision', 'rejection', 'approval', 'edit_pattern']);

export async function executeBrandMemoryTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
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
