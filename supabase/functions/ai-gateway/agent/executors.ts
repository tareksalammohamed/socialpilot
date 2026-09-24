import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { ToolCall, ToolResult, AgentContext } from './types.ts';
import { executeContentTool, CONTENT_EDIT_TOOLS } from './executors-content.ts';
import { executeBrandMemoryTool, BRAND_MEMORY_TOOLS } from './executors-brand.ts';
import { executeAccountsTool, ACCOUNTS_TOOLS } from './executors-accounts.ts';
import { executeMediaLlmTool, MEDIA_LLM_TOOLS } from './executors-media.ts';
import { executeMediaLinkTool, MEDIA_LINK_TOOLS } from './executors-media-link.ts';
import { executeCampaignTool, CAMPAIGN_TOOLS } from './executors-campaign.ts';
import { executeAnalyticsTool, ANALYTICS_TOOLS } from './executors-analytics.ts';

// ---------------------------------------------------------------------------
// Executors — Phase 1 bridges every tool that already has a working
// implementation (via the existing `executeIntent` in index.ts) so we do
// NOT rewrite logic that already works (per the project's own rule: don't
// rebuild what's already correct). Tools with no implementation yet return
// a clean "not implemented" ToolResult instead of throwing — Phase 2 fills
// these in one at a time.
//
// `LegacyRunner` is injected from index.ts at call time so this module has
// zero dependency on Deno/Supabase wiring specifics.
// ---------------------------------------------------------------------------

export type LegacyIntent =
  | 'generate_brand_dna' | 'create_content' | 'create_content_plan'
  | 'analyze_performance' | 'suggest_ideas' | 'general_advice';

export type LegacyRunner = (
  intent: LegacyIntent,
  message: string,
  platforms: string[],
  runtimeContext: Record<string, unknown>,
) => Promise<{ result: Record<string, unknown>; tokensIn: number; tokensOut: number }>;

// Tools that map 1:1 onto an existing, working legacy intent.
const LEGACY_BRIDGE: Partial<Record<ToolCall['name'], LegacyIntent>> = {
  create_content: 'create_content',
  create_content_plan: 'create_content_plan',
  analyze_performance: 'analyze_performance',
  read_brand_dna: 'generate_brand_dna', // read path reuses the same context assembly
  suggest_ideas: 'suggest_ideas',
  general_advice: 'general_advice',
};

// Tools genuinely new in Phase 1 that have no executor yet. Kept explicit
// (rather than a catch-all) so it's obvious in review exactly what's still
// outstanding for Phase 2/3/4.
// Phase 2: content-editing, brand-memory and account-read tools now have
// real implementations (see the imported modules). Everything left here is
// genuinely still pending — publishing/scheduling (needs the Approval UI +
// scheduler-tick wiring, Phase 3/5), media (needs upload storage, Phase 4),
// campaigns (needs multi-content orchestration, Phase 6), and analytics
// beyond analyze_performance (needs the Analytics Intelligence layer, Phase 6).
const NOT_YET_IMPLEMENTED = new Set<ToolCall['name']>([
  'repurpose_content',
  'upload_media', 'analyze_media',
  'create_schedule', 'reschedule', 'cancel_schedule', 'publish', 'retry_failed_publish',
  'enforce_brand_rules',
]);

export async function executeTool(
  call: ToolCall,
  context: AgentContext,
  runLegacy: LegacyRunner,
  supabase: SupabaseClient,
  legacyContext: Record<string, unknown> = {},
): Promise<ToolResult> {
  const legacyIntent = LEGACY_BRIDGE[call.name];

  if (legacyIntent) {
    try {
      const message = String(call.input.message ?? call.input.topic ?? call.input.goal ?? '');
      const platforms = Array.isArray(call.input.platforms) ? (call.input.platforms as string[]) : [];
      // legacyContext (parseIntent output: post_count/schedule/performance/
      // content_goal) takes precedence — this is the deterministic data the
      // legacy handler was built to trust over anything the model guesses.
      const { result } = await runLegacy(legacyIntent, message, platforms, legacyContext);
      return { callId: call.id, name: call.name, ok: true, output: result };
    } catch (err) {
      return { callId: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  if (CONTENT_EDIT_TOOLS.has(call.name)) {
    return executeContentTool(call, context, supabase);
  }

  if (BRAND_MEMORY_TOOLS.has(call.name)) {
    return executeBrandMemoryTool(call, context, supabase);
  }

  if (ACCOUNTS_TOOLS.has(call.name)) {
    return executeAccountsTool(call, context, supabase);
  }

  if (MEDIA_LLM_TOOLS.has(call.name)) {
    return executeMediaLlmTool(call, context, supabase);
  }

  if (MEDIA_LINK_TOOLS.has(call.name)) {
    return executeMediaLinkTool(call, context, supabase);
  }

  if (CAMPAIGN_TOOLS.has(call.name)) {
    return executeCampaignTool(call, context, supabase, runLegacy, legacyContext);
  }

  if (ANALYTICS_TOOLS.has(call.name)) {
    return executeAnalyticsTool(call, context, supabase);
  }

  if (NOT_YET_IMPLEMENTED.has(call.name)) {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      error: 'هذه الأداة لسه مش متاحة — جزء من مرحلة لاحقة في خطة التطوير الحالية.',
    };
  }

  return { callId: call.id, name: call.name, ok: false, error: `Unknown tool: ${call.name}` };
}
