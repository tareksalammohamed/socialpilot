import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const MEDIA_LINK_TOOLS = new Set<ToolName>(['attach_media', 'replace_media', 'remove_media']);

export async function executeMediaLinkTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  const contentId = String(call.input.contentId ?? context.currentContentId ?? '');
  if (!contentId) {
    return { callId: call.id, name: call.name, ok: false, error: 'محتاج أعرف تحديدًا أي منشور عشان أربط/أشيل الصورة.' };
  }

  const mediaId = call.name === 'remove_media' ? null : String(call.input.mediaId ?? context.selectedMediaId ?? '');
  if (call.name !== 'remove_media' && !mediaId) {
    return { callId: call.id, name: call.name, ok: false, error: 'محتاج mediaId لعنصر ميديا مرفوع بالفعل.' };
  }

  if (mediaId) {
    const { data: mediaRow } = await supabase
      .from('media')
      .select('id')
      .eq('id', mediaId)
      .eq('workspace_id', context.workspaceId)
      .maybeSingle();
    if (!mediaRow) {
      return { callId: call.id, name: call.name, ok: false, error: 'مفيش عنصر ميديا بالـid ده في المساحة دي.' };
    }
  }

  const { error } = await supabase
    .from('content_variants')
    .update({ media_id: mediaId, updated_at: new Date().toISOString() })
    .eq('content_id', contentId)
    .eq('workspace_id', context.workspaceId);
  if (error) return { callId: call.id, name: call.name, ok: false, error: error.message };

  return { callId: call.id, name: call.name, ok: true, output: { contentId, mediaId } };
}
