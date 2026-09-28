import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext, ToolName } from './types.ts';

// ---------------------------------------------------------------------------
// Publishing tools (create_schedule / reschedule / cancel_schedule / publish /
// retry_failed_publish).
//
// These used to sit in NOT_YET_IMPLEMENTED, so a user could "approve" a plan
// and every side-effecting step then failed. They deliberately add NO new
// business logic: each one calls the same DB RPCs / Edge Function the UI
// already uses, so the Agent and the UI cannot diverge:
//
//   create_schedule  -> rpc approve_content_variant   (quality gate, calendar
//                                                      item, publishing job)
//   reschedule       -> rpc reschedule_calendar_item
//   cancel_schedule  -> rpc cancel_calendar_item      (migration 0035)
//   publish / retry  -> Edge Function social-publish  (idempotent job reuse)
//
// They run through the CALLER's JWT (UserScope), never the service role, so
// RLS and the RPCs' auth.uid() membership checks apply. A service-role /
// background caller has no UserScope and these tools refuse to run.
// ---------------------------------------------------------------------------

export type UserScope = {
  token: string;
  supabaseUrl: string;
  anonKey: string;
  client: SupabaseClient;
};

export const PUBLISHING_TOOLS = new Set<ToolName>([
  'create_schedule', 'reschedule', 'cancel_schedule', 'publish', 'retry_failed_publish',
]);

type VariantRef = { id: string; content_id: string; platform: string; status: string };

const RPC_ERROR_MESSAGES: Record<string, string> = {
  quality_review_required: 'مراجعة الجودة لسه مطلوبة — النسخة دي محتاجة تحسين قبل الاعتماد.',
  workspace_access_denied: 'مفيش صلاحية وصول لمساحة العمل دي.',
  calendar_item_not_found: 'مفيش عنصر جدولة للنسخة دي.',
  calendar_item_not_reschedulable: 'العنصر ده اتنشر أو بيتنشر أو اتلغى — مينفعش يتعدّل موعده.',
  calendar_item_not_cancellable: 'العنصر ده اتنشر أو بيتنشر أو اتلغى بالفعل — مينفعش يتلغى.',
  variant_not_found: 'النسخة مش موجودة.',
  scheduled_for_required: 'محتاج تحديد موعد النشر.',
};

function translateError(message: string): string {
  for (const [code, text] of Object.entries(RPC_ERROR_MESSAGES)) {
    if (message.includes(code)) return text;
  }
  return message;
}

function fail(call: ToolCall, error: string, output?: Record<string, unknown>): ToolResult {
  return { callId: call.id, name: call.name, ok: false, error, ...(output ? { output } : {}) };
}

// Which variants does the call refer to? Explicit ids win over conversation
// context; an explicit contentId without a platform means "all its variants".
async function resolveVariants(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient,
): Promise<{ variants: VariantRef[] } | { error: string }> {
  const explicitVariantId = String(call.input.variantId ?? '');
  const explicitContentId = String(call.input.contentId ?? '');
  const variantId = explicitVariantId || (!explicitContentId ? (context.currentVariantId ?? '') : '');
  const contentId = explicitContentId || (!variantId ? (context.currentContentId ?? '') : '');

  let query = supabase
    .from('content_variants')
    .select('id, content_id, platform, status')
    .eq('workspace_id', context.workspaceId);

  if (variantId) {
    query = query.eq('id', variantId);
  } else if (contentId) {
    query = query.eq('content_id', contentId);
    const platform = String(call.input.platform ?? context.selectedPlatform ?? '');
    if (platform) query = query.eq('platform', platform);
  } else {
    return { error: 'محتاج أعرف تحديدًا أي منشور (contentId أو variantId).' };
  }

  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: 'مفيش نسخة محتوى بالمواصفات دي في المساحة دي.' };
  return { variants: data as VariantRef[] };
}

async function calendarItemFor(
  supabase: SupabaseClient, workspaceId: string, variantId: string,
): Promise<{ id: string; status: string } | null> {
  const { data } = await supabase
    .from('calendar_items')
    .select('id, status')
    .eq('workspace_id', workspaceId)
    .eq('variant_id', variantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

function parseFutureDate(raw: unknown): { iso: string } | { error: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { error: 'محتاج تحديد موعد النشر (publishAt).' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `موعد النشر مش مفهوم: "${value}". استخدم صيغة ISO زي 2026-10-01T09:00:00+03:00.` };
  if (date.getTime() <= Date.now()) return { error: 'موعد النشر لازم يكون في المستقبل.' };
  return { iso: date.toISOString() };
}

type PerVariantOutcome = { variantId: string; platform: string; ok: boolean; detail?: Record<string, unknown>; error?: string };

function summarize(call: ToolCall, outcomes: PerVariantOutcome[]): ToolResult {
  const failed = outcomes.filter((o) => !o.ok);
  const output = { results: outcomes };
  if (failed.length === 0) return { callId: call.id, name: call.name, ok: true, output };
  const reason = failed.map((f) => `${f.platform}: ${f.error}`).join(' | ');
  const allFailed = failed.length === outcomes.length;
  return {
    callId: call.id, name: call.name, ok: false, output,
    error: allFailed ? reason : `نجح جزء وفشل جزء — ${reason}`,
  };
}

async function callSocialPublish(
  scope: UserScope, workspaceId: string, variantId: string, calendarItemId?: string,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch(`${scope.supabaseUrl}/functions/v1/social-publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${scope.token}`,
      apikey: scope.anonKey,
    },
    body: JSON.stringify({ workspaceId, variantId, calendarItemId }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, body };
}

export async function executePublishingTool(
  call: ToolCall, context: AgentContext, supabase: SupabaseClient, scope: UserScope | null,
): Promise<ToolResult> {
  if (!scope) {
    return fail(call, 'الإجراء ده لازم يتنفّذ بجلسة مستخدم حقيقية (مش من خدمة خلفية).');
  }

  const resolved = await resolveVariants(call, context, supabase);
  if ('error' in resolved) return fail(call, resolved.error);
  const { variants } = resolved;
  const outcomes: PerVariantOutcome[] = [];

  try {
    if (call.name === 'create_schedule') {
      const when = parseFutureDate(call.input.publishAt);
      if ('error' in when) return fail(call, when.error);

      for (const v of variants) {
        const cal = await calendarItemFor(supabase, context.workspaceId, v.id);
        if (v.status === 'rejected') {
          outcomes.push({ variantId: v.id, platform: v.platform, ok: false, error: 'النسخة دي مرفوضة — مينفعش تتجدول.' });
          continue;
        }
        if (cal && ['published', 'publishing'].includes(cal.status)) {
          outcomes.push({ variantId: v.id, platform: v.platform, ok: false, error: 'النسخة دي اتنشرت أو بتتنشر بالفعل.' });
          continue;
        }
        const { data, error } = await scope.client.rpc('approve_content_variant', {
          p_workspace_id: context.workspaceId,
          p_variant_id: v.id,
          p_scheduled_for: when.iso,
        });
        outcomes.push(error
          ? { variantId: v.id, platform: v.platform, ok: false, error: translateError(error.message) }
          : { variantId: v.id, platform: v.platform, ok: true, detail: (data ?? {}) as Record<string, unknown> });
      }
      return summarize(call, outcomes);
    }

    if (call.name === 'reschedule') {
      const when = parseFutureDate(call.input.newPublishAt ?? call.input.publishAt);
      if ('error' in when) return fail(call, when.error);

      for (const v of variants) {
        const cal = await calendarItemFor(supabase, context.workspaceId, v.id);
        if (!cal) {
          outcomes.push({ variantId: v.id, platform: v.platform, ok: false, error: 'النسخة دي مش مجدولة أصلًا — استخدم الجدولة الأول.' });
          continue;
        }
        const { data, error } = await scope.client.rpc('reschedule_calendar_item', {
          p_workspace_id: context.workspaceId,
          p_calendar_item_id: cal.id,
          p_scheduled_for: when.iso,
        });
        outcomes.push(error
          ? { variantId: v.id, platform: v.platform, ok: false, error: translateError(error.message) }
          : { variantId: v.id, platform: v.platform, ok: true, detail: (data ?? {}) as Record<string, unknown> });
      }
      return summarize(call, outcomes);
    }

    if (call.name === 'cancel_schedule') {
      for (const v of variants) {
        const cal = await calendarItemFor(supabase, context.workspaceId, v.id);
        if (!cal) {
          outcomes.push({ variantId: v.id, platform: v.platform, ok: false, error: 'النسخة دي مش مجدولة أصلًا.' });
          continue;
        }
        const { data, error } = await scope.client.rpc('cancel_calendar_item', {
          p_workspace_id: context.workspaceId,
          p_calendar_item_id: cal.id,
        });
        outcomes.push(error
          ? { variantId: v.id, platform: v.platform, ok: false, error: translateError(error.message) }
          : { variantId: v.id, platform: v.platform, ok: true, detail: (data ?? {}) as Record<string, unknown> });
      }
      return summarize(call, outcomes);
    }

    // publish / retry_failed_publish — both go through social-publish, which
    // owns idempotency (reuses the existing job, refuses when a run is in
    // flight, honours max_attempts), quality gating and media resolution.
    for (const v of variants) {
      let calendarItemId: string | undefined;
      const cal = await calendarItemFor(supabase, context.workspaceId, v.id);
      if (cal) calendarItemId = cal.id;

      if (call.name === 'retry_failed_publish') {
        const { data: lastJob } = await supabase
          .from('publishing_jobs')
          .select('status')
          .eq('workspace_id', context.workspaceId)
          .eq('variant_id', v.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastJob?.status !== 'failed') {
          outcomes.push({
            variantId: v.id, platform: v.platform, ok: false,
            error: lastJob ? 'آخر محاولة نشر للنسخة دي مش فاشلة — مفيش حاجة تتعاد.' : 'مفيش محاولة نشر سابقة للنسخة دي.',
          });
          continue;
        }
      }

      const { ok, body } = await callSocialPublish(scope, context.workspaceId, v.id, calendarItemId);
      outcomes.push(ok
        ? { variantId: v.id, platform: v.platform, ok: true, detail: { postId: body.postId ?? null, url: body.url ?? null, alreadyPublished: Boolean(body.alreadyPublished) } }
        : { variantId: v.id, platform: v.platform, ok: false, error: String(body.error ?? 'فشل النشر') });
    }
    return summarize(call, outcomes);
  } catch (err) {
    return fail(call, err instanceof Error ? err.message : 'Unknown error', outcomes.length ? { results: outcomes } : undefined);
  }
}
