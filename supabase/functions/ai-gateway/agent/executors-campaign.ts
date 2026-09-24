import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';
import type { LegacyRunner } from './executors.ts';

export const CAMPAIGN_TOOLS = new Set<ToolName>(['create_campaign']);

type CalendarSlot = {
  date: string; platform: string; title: string; content?: string;
  goal?: string; hashtags?: string[]; cta?: string;
  quality?: { scores: Record<string, number> };
};

function averageScore(scores?: Record<string, number>): number | null {
  if (!scores) return null;
  const values = Object.values(scores).filter((v): v is number => typeof v === 'number');
  return values.length > 0 ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null;
}

export async function executeCampaignTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient, runLegacy: LegacyRunner, legacyContext: Record<string, unknown>,
): Promise<ToolResult> {
  const objective = String(call.input.objective ?? '');
  const durationDays = Number(call.input.durationDays ?? legacyContext.post_count ?? 7);
  const platforms = Array.isArray(call.input.platforms) ? (call.input.platforms as string[]) : [];
  if (!objective) {
    return { callId: call.id, name: call.name, ok: false, error: 'محتاج أعرف هدف الحملة (objective).' };
  }

  // Step 1: reuse the EXISTING, working create_content_plan legacy path —
  // it already produces per-slot text/hashtags/cta/quality, deterministic
  // dates/count come from legacyContext exactly like the normal CreateScreen
  // flow (see agent/types.ts's note on legacyContext).
  let plan: { theme: string; slots: CalendarSlot[] };
  try {
    const { result } = await runLegacy('create_content_plan', objective, platforms, {
      ...legacyContext,
      post_count: durationDays,
    });
    plan = result as { theme: string; slots: CalendarSlot[] };
  } catch (err) {
    return { callId: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : 'فشل بناء خطة الحملة' };
  }

  if (!plan.slots || plan.slots.length === 0) {
    return { callId: call.id, name: call.name, ok: false, error: 'الخطة رجعت من غير أي منشورات.' };
  }

  // Step 2: persist — mirrors CreateScreen.tsx's savePlan() exactly (same
  // table shapes, same 'review' status so nothing publishes/schedules
  // without the human approval step in section 14).
  const batchId = crypto.randomUUID();
  const createdContentIds: string[] = [];

  for (const slot of plan.slots) {
    const body = slot.content?.trim() || slot.title;
    const { data: inserted, error: contentError } = await supabase
      .from('content')
      .insert({
        workspace_id: context.workspaceId,
        batch_id: batchId,
        title: slot.title,
        goal: slot.goal || plan.theme,
        topic: plan.theme,
        master_text: body,
        platforms: [slot.platform],
        status: 'review',
        quality_score: averageScore(slot.quality?.scores),
      })
      .select('id')
      .single();
    if (contentError || !inserted) {
      return {
        callId: call.id, name: call.name, ok: false,
        error: `اتوقفت بعد إنشاء ${createdContentIds.length} من ${plan.slots.length} منشور — ${contentError?.message ?? 'خطأ غير معروف'}`,
        output: { batchId, createdContentIds },
      };
    }
    createdContentIds.push(inserted.id);

    const { error: variantError } = await supabase.from('content_variants').insert({
      content_id: inserted.id,
      workspace_id: context.workspaceId,
      platform: slot.platform,
      text: body,
      hashtags: slot.hashtags ?? [],
      cta: slot.cta ?? null,
      media_brief: {},
      status: 'review',
    });
    if (variantError) {
      return {
        callId: call.id, name: call.name, ok: false,
        error: `اتوقفت بعد إنشاء ${createdContentIds.length} من ${plan.slots.length} منشور — ${variantError.message}`,
        output: { batchId, createdContentIds },
      };
    }
  }

  return {
    callId: call.id,
    name: call.name,
    ok: true,
    output: { batchId, theme: plan.theme, postCount: createdContentIds.length, contentIds: createdContentIds },
  };
}
