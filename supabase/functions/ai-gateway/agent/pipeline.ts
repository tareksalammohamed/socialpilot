import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { routeAndRun, type CapabilityRequest } from '../router.ts';
import { TOOL_REGISTRY, listToolsForPrompt } from './tools.ts';
import { executeTool, type LegacyRunner } from './executors.ts';
import type {
  AgentRequest, AgentTurnResult, AgentPlan, PlanStep, ToolCall, ToolResult, ToolName, AgentIntentLabel, AgentContext,
} from './types.ts';

// ---------------------------------------------------------------------------
// Step 1 — Intent Understanding + Task Planning (one LLM call, JSON mode)
//
// The model receives: the user's free-text message, the current context
// (route/selected content/etc — section 6), and the full tool list. It
// returns a plan: 1..N steps, each naming a tool + a short human label. If
// the request is ambiguous, it returns a clarifying question instead
// (section 27) rather than guessing.
// ---------------------------------------------------------------------------

type PlannerOutput = {
  intentLabel: AgentIntentLabel;
  clarifyingQuestion?: string;
  planSummary?: string;
  steps?: { label: string; tool: ToolName; input: Record<string, unknown> }[];
};

function plannerSystemPrompt(): string {
  return `أنت طبقة "Task Planning" داخل SocialPilot — Universal AI Social Media Agent.
مهمتك: تفهم طلب المستخدم الحر (أي صياغة طبيعية، مصري/فصحى/إنجليزي) وتحوّله لخطة تنفيذ باستخدام الأدوات المتاحة فقط. أنت لا تكتب المحتوى بنفسك هنا — فقط تخطط وتختار الأدوات.

الأدوات المتاحة:
${listToolsForPrompt()}

قواعد:
- لو الطلب بسيط وخطوة واحدة، رجّع خطوة واحدة فقط.
- لو الطلب متعدد الخطوات (زي حملة كاملة)، رجّع كل الخطوات بالترتيب.
- لو الطلب غامض وناقص معلومة أساسية (مثلاً مش واضح المنصة أو المدة)، رجّع clarifyingQuestion بدل ما تخمن.
- استخدم سياق المستخدم الحالي (current_route, current_content_id...) لو الطلب بيشير لعنصر موجود بالفعل ("البوست ده"، "الصورة دي") بدل ما تنشئ عنصر جديد.
- رجّع JSON فقط بدون أي نص إضافي، بالشكل:
{"intentLabel": "...", "clarifyingQuestion": "...?" | null, "planSummary": "...", "steps": [{"label": "...", "tool": "...", "input": {...}}]}`;
}

function plannerUserPrompt(req: AgentRequest): string {
  const ctx = req.context;
  const contextLines = [
    ctx.currentRoute ? `current_route: ${ctx.currentRoute}` : null,
    ctx.currentContentId ? `current_content_id: ${ctx.currentContentId}` : null,
    ctx.currentVariantId ? `current_variant_id: ${ctx.currentVariantId}` : null,
    ctx.selectedPlatform ? `selected_platform: ${ctx.selectedPlatform}` : null,
    ctx.selectedCampaignId ? `selected_campaign: ${ctx.selectedCampaignId}` : null,
    ctx.selectedMediaId ? `selected_media: ${ctx.selectedMediaId}` : null,
    req.platforms?.length ? `requested_platforms: ${req.platforms.join(', ')}` : null,
  ].filter(Boolean);

  const recent = (ctx.recentActions ?? []).slice(0, 5)
    .map((a) => `- ${a.type}: ${a.summary} (${a.at})`).join('\n');

  return `طلب المستخدم:\n"${req.message}"\n\nسياق الجلسة الحالية:\n${contextLines.join('\n') || 'لا يوجد سياق محدد'}\n\nآخر إجراءات المستخدم:\n${recent || 'لا يوجد'}`;
}

function looksLikeJsonObject(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return /\{[\s\S]*\}/.test(trimmed);
  }
}

function parsePlannerOutput(raw: string): PlannerOutput {
  try {
    return JSON.parse(raw) as PlannerOutput;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as PlannerOutput; } catch { /* fall through */ }
    }
    // Fail safe: treat as a single general_advice step rather than crash the turn.
    return { intentLabel: 'other', planSummary: raw, steps: [] };
  }
}

async function planTurn(supabase: SupabaseClient, req: AgentRequest): Promise<PlannerOutput> {
  const capabilities: CapabilityRequest = {
    requiredCapabilities: ['structured_output'],
    preferredCapabilities: ['reasoning'],
  };
  const result = await routeAndRun(supabase, {
    ...capabilities,
    systemPrompt: plannerSystemPrompt(),
    userPrompt: plannerUserPrompt(req),
    jsonMode: true,
    validate: looksLikeJsonObject,
  });
  return parsePlannerOutput(result.content);
}

// ---------------------------------------------------------------------------
// Step 2 — Build AgentPlan from the planner output, and split steps into
// "safe to run now" (read-only, or the single-step no-approval-needed case)
// vs "must wait for approval" (any sideEffect:true tool — section 14/28).
// ---------------------------------------------------------------------------

function buildPlan(output: PlannerOutput): { plan: AgentPlan; toolCalls: ToolCall[] } {
  const rawSteps = output.steps ?? [];
  const steps: PlanStep[] = rawSteps.map((s, i) => ({
    id: `step-${i + 1}`,
    label: s.label,
    toolName: s.tool,
    status: 'pending',
  }));
  // Built in lockstep with `steps` (same index), so a call's id always maps
  // back to exactly one step — no matching by label, which breaks on
  // duplicate labels.
  const toolCalls: ToolCall[] = rawSteps.map((s, i) => ({
    id: `step-${i + 1}`,
    name: s.tool,
    input: s.input ?? {},
  }));
  const requiresApprovalBeforeRun = steps.some((s) => s.toolName && TOOL_REGISTRY[s.toolName]?.sideEffect);
  return {
    plan: {
      id: crypto.randomUUID(),
      summary: output.planSummary ?? '',
      steps,
      requiresApprovalBeforeRun,
    },
    toolCalls,
  };
}

// ---------------------------------------------------------------------------
// Phase 5 — executing calls the user has already approved (from a prior
// turn's `pendingApproval.toolCalls`). No planning/LLM call here — these
// were already vetted by the planner and by the human; this just runs them
// through the same executeTool path the safe steps use.
// ---------------------------------------------------------------------------
export async function runApprovedCalls(
  supabase: SupabaseClient,
  calls: ToolCall[],
  context: AgentContext,
  runLegacy: LegacyRunner,
  legacyContext: Record<string, unknown> = {},
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    results.push(await executeTool(call, context, runLegacy, supabase, legacyContext));
  }
  return results;
}

export async function runAgentTurn(
  supabase: SupabaseClient,
  req: AgentRequest,
  runLegacy: LegacyRunner,
): Promise<AgentTurnResult> {
  const planned = await planTurn(supabase, req);

  if (planned.clarifyingQuestion) {
    return {
      reply: planned.clarifyingQuestion,
      toolCalls: [],
      toolResults: [],
      clarifyingQuestion: planned.clarifyingQuestion,
      intentLabel: planned.intentLabel,
    };
  }

  const { plan, toolCalls } = buildPlan(planned);

  const sideEffectCalls = toolCalls.filter((c) => TOOL_REGISTRY[c.name]?.sideEffect);
  const safeCalls = toolCalls.filter((c) => !TOOL_REGISTRY[c.name]?.sideEffect);

  // Run only the non-destructive steps now (content drafting, analysis, reads).
  const toolResults: ToolResult[] = [];
  for (const call of safeCalls) {
    const res = await executeTool(call, req.context, runLegacy, supabase, req.legacyContext ?? {});
    toolResults.push(res);
    const step = plan.steps.find((s) => s.id === call.id);
    if (step) step.status = res.ok ? 'done' : 'failed';
  }

  const reply = plan.summary || 'تم تنفيذ طلبك.';

  return {
    reply,
    plan,
    toolCalls,
    toolResults,
    pendingApproval: sideEffectCalls.length > 0
      ? { reason: 'الخطوات دي بتنشر/تجدول/تعدّل حاجة بشكل نهائي — محتاجة موافقتك الأول.', toolCalls: sideEffectCalls }
      : undefined,
    intentLabel: planned.intentLabel,
  };
}
