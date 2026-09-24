import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { routeAndRun } from '../router.ts';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

export const MEDIA_LLM_TOOLS = new Set<ToolName>(['generate_media_brief', 'create_image_prompt']);
// NOTE: analyze_media is intentionally NOT included here yet. I checked
// router.ts's actual adapter contract — `adapter.chatComplete(apiKey,
// modelId, systemPrompt, userPrompt, jsonMode)` takes plain strings only,
// no image/multimodal parameter exists anywhere in the provider layer yet.
// Passing an image URL as a plain-text userPrompt would NOT actually let
// the model see the image — it would silently produce a fake-sounding
// analysis of a URL string. Rather than ship that, analyze_media stays in
// executors.ts's NOT_YET_IMPLEMENTED list until the adapters genuinely
// support an image input (real Phase 4b work: extend ProviderAdapter +
// each of the 6 providers' actual multimodal request shape).

async function loadVariantText(supabase: SupabaseClient, workspaceId: string, contentId: string): Promise<{ text: string; platform: string } | null> {
  const { data } = await supabase
    .from('content_variants')
    .select('text, platform')
    .eq('content_id', contentId)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function executeMediaLlmTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  if (call.name === 'generate_media_brief' || call.name === 'create_image_prompt') {
    const contentId = String(call.input.contentId ?? context.currentContentId ?? '');
    if (!contentId) {
      return { callId: call.id, name: call.name, ok: false, error: 'محتاج أعرف تحديدًا أي منشور عشان أقترح صورة له.' };
    }
    const variant = await loadVariantText(supabase, context.workspaceId, contentId);
    if (!variant) {
      return { callId: call.id, name: call.name, ok: false, error: 'مفيش نص محتوى مرتبط بالـid ده.' };
    }

    const isImagePrompt = call.name === 'create_image_prompt';
    const sys = isImagePrompt
      ? 'أنت Media Prompt Engineer. من نص منشور معين، اكتب image-generation prompt واحد بالإنجليزي، دقيق ومحدد (subject, setting, mood, style, no text on image), بدون أي تعليق إضافي.'
      : 'أنت Media Brief Agent داخل SocialPilot (سكشن 10/12). من نص منشور معين، اكتب وصف نصي قصير (2-3 جمل بالعربي) لأنسب صورة/فيديو للمنشور — بدون ما تفرض الصورة، فقط اقتراح.';

    try {
      const result = await routeAndRun(supabase, {
        requiredCapabilities: ['text_generation'],
        systemPrompt: sys,
        userPrompt: `المنصة: ${variant.platform}\nنص المنشور:\n"""${variant.text}"""`,
        jsonMode: false,
      });
      const key = isImagePrompt ? 'imagePrompt' : 'mediaBrief';
      // Persist the brief onto the variant's media_brief jsonb so it survives
      // as part of the content record, not just this one chat turn.
      if (!isImagePrompt) {
        await supabase
          .from('content_variants')
          .update({ media_brief: { suggestion: result.content.trim() } })
          .eq('content_id', contentId)
          .eq('workspace_id', context.workspaceId);
      }
      return { callId: call.id, name: call.name, ok: true, output: { contentId, [key]: result.content.trim() } };
    } catch (err) {
      return { callId: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  return { callId: call.id, name: call.name, ok: false, error: `Unhandled media tool: ${call.name}` };
}
