import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { routeAndRun } from '../router.ts';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

// ---------------------------------------------------------------------------
// Content-editing tools — all operate on an EXISTING content_variants row.
// None of these are side-effecting per the registry (they edit a draft, not
// publish it), so they run immediately without the approval gate. All of
// them require input.contentId (falls back to context.currentContentId —
// this is what lets "غيّر الصورة وخلي الـHook أقوى" work while the user is
// looking at a specific post, per section 6).
// ---------------------------------------------------------------------------

export const CONTENT_EDIT_TOOLS = new Set<ToolName>([
  'rewrite_content', 'improve_hook', 'generate_cta', 'generate_hashtags',
  'translate_content', 'adapt_for_platform',
]);

type VariantRow = {
  id: string; content_id: string; platform: string; text: string;
  hashtags: string[]; cta: string | null; status: string;
};

async function loadVariant(
  supabase: SupabaseClient, workspaceId: string, contentId: string, platform?: string,
): Promise<VariantRow | null> {
  let query = supabase
    .from('content_variants')
    .select('id, content_id, platform, text, hashtags, cta, status')
    .eq('content_id', contentId)
    .eq('workspace_id', workspaceId);
  if (platform) query = query.eq('platform', platform);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !data) return null;
  return data as VariantRow;
}

function toolSystemPrompt(kind: ToolName): string {
  const base = 'أنت Content Editor Agent داخل SocialPilot. مهمتك تعديل عنصر محتوى موجود بالفعل — لا تنشئ محتوى جديد من الصفر، عدّل الموجود فقط. حافظ على نفس الموضوع والسياق، وطبّق فقط التعديل المطلوب.';
  switch (kind) {
    case 'improve_hook':
      return `${base}\nالمطلوب: أعد كتابة أول سطر/جملتين (الـHook) بس، خليه أقوى وأجذب، والباقي زي ما هو تقريبًا.`;
    case 'generate_cta':
      return `${base}\nالمطلوب: اقترح Call-To-Action مناسب لنهاية البوست ده.`;
    case 'generate_hashtags':
      return `${base}\nالمطلوب: اقترح هاشتاجات مناسبة للمنصة والموضوع (5-8 هاشتاج بحد أقصى).`;
    case 'translate_content':
      return `${base}\nالمطلوب: ترجم/حوّل النص للغة المطلوبة، وحافظ على نبرة البراند.`;
    case 'adapt_for_platform':
      return `${base}\nالمطلوب: أعد صياغة النص ليناسب قواعد المنصة الجديدة (الطول، النبرة، البنية).`;
    default: // rewrite_content
      return `${base}\nالمطلوب: أعد كتابة النص بالكامل حسب تعليمات المستخدم، مع الحفاظ على جوهر الرسالة.`;
  }
}

export async function executeContentTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<ToolResult> {
  const contentId = String(call.input.contentId ?? context.currentContentId ?? '');
  if (!contentId) {
    return { callId: call.id, name: call.name, ok: false, error: 'محتاج أعرف تحديدًا أي منشور — مفيش contentId متاح.' };
  }
  const platform = (call.input.platform as string | undefined) ?? context.selectedPlatform;
  const variant = await loadVariant(supabase, context.workspaceId, contentId, platform);
  if (!variant) {
    return { callId: call.id, name: call.name, ok: false, error: 'مفيش نسخة محتوى موجودة بالـid/platform ده.' };
  }

  const instructions = String(call.input.instructions ?? call.input.direction ?? call.input.targetLanguage ?? call.input.platform ?? 'حسّن العنصر ده');

  try {
    const result = await routeAndRun(supabase, {
      requiredCapabilities: ['text_generation', 'structured_output'],
      systemPrompt: toolSystemPrompt(call.name),
      userPrompt: `النص الحالي:\n"""${variant.text}"""\nالهاشتاجات الحالية: ${variant.hashtags.join(', ') || 'لا يوجد'}\nCTA الحالي: ${variant.cta ?? 'لا يوجد'}\nالمنصة: ${variant.platform}\nتعليمات المستخدم: ${instructions}\n\nرجّع JSON فقط: {"text": "...", "hashtags": ["..."], "cta": "..."}`,
      jsonMode: true,
      validate: (c: string) => { try { JSON.parse(c); return true; } catch { return /\{[\s\S]*\}/.test(c); } },
    });

    let parsed: { text?: string; hashtags?: string[]; cta?: string };
    try {
      parsed = JSON.parse(result.content);
    } catch {
      const m = result.content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { text: result.content };
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.text) update.text = parsed.text;
    if (parsed.hashtags && call.name === 'generate_hashtags') update.hashtags = parsed.hashtags;
    if (parsed.cta && call.name === 'generate_cta') update.cta = parsed.cta;
    if (call.name === 'improve_hook' || call.name === 'rewrite_content' || call.name === 'translate_content' || call.name === 'adapt_for_platform') {
      if (parsed.hashtags) update.hashtags = parsed.hashtags;
      if (parsed.cta) update.cta = parsed.cta;
    }

    const { error: updateError } = await supabase
      .from('content_variants')
      .update(update)
      .eq('id', variant.id);
    if (updateError) {
      return { callId: call.id, name: call.name, ok: false, error: updateError.message };
    }

    return {
      callId: call.id,
      name: call.name,
      ok: true,
      output: { contentId, variantId: variant.id, platform: variant.platform, ...update },
    };
  } catch (err) {
    return { callId: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
