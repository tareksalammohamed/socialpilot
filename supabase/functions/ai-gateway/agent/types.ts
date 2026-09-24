// ---------------------------------------------------------------------------
// Universal AI Agent — shared types
//
// Replaces the closed `Intent` union (generate_brand_dna | create_content |
// create_content_plan | analyze_performance | suggest_ideas | general_advice)
// with an open pipeline:
//
//   User Request -> Context Assembly -> Intent Understanding -> Reasoning
//   -> Task Planning -> Tool Selection -> Tool Execution -> Quality Engine
//   -> Human Approval -> Scheduling/Publishing -> Verification -> Memory Update
//
// The old 6 values are kept ONLY as an internal classification label
// (AgentIntentLabel) for analytics/metadata — never as a hard constraint on
// what the user can ask for or what the agent can do.
// ---------------------------------------------------------------------------

// Internal classification only — free-text requests are always accepted
// regardless of which (if any) of these labels they resemble.
export type AgentIntentLabel =
  | 'generate_brand_dna'
  | 'create_content'
  | 'create_content_plan'
  | 'analyze_performance'
  | 'suggest_ideas'
  | 'general_advice'
  | 'edit_content'
  | 'manage_media'
  | 'manage_schedule'
  | 'repurpose_content'
  | 'other';

// ---------------------------------------------------------------------------
// Context Assembly — everything the agent knows about "where the user is"
// (section 6 of the spec: current_route, current_content_id, etc.)
// ---------------------------------------------------------------------------
export type AgentContext = {
  workspaceId: string;
  userId: string;
  brandDnaId?: string;
  currentRoute?: string;
  currentContentId?: string;
  currentVariantId?: string;
  selectedPlatform?: string;
  selectedCampaignId?: string;
  selectedMediaId?: string;
  currentWorkspaceName?: string;
  recentActions?: RecentAction[];
  conversationId?: string;
};

export type RecentAction = {
  type: string;
  targetId?: string;
  summary: string;
  at: string; // ISO timestamp
};

// ---------------------------------------------------------------------------
// Request coming in from the client — the open chat/command interface.
// `intentLabel` is optional metadata a client MAY pass (e.g. a suggested
// action button was clicked); it is never required and never restricts
// what the agent will do with `message`.
// ---------------------------------------------------------------------------
export type AgentRequest = {
  message: string;
  intentLabel?: AgentIntentLabel;
  context: AgentContext;
  platforms?: string[];
  // Passthrough for legacy-bridged tools only (create_content_plan's
  // deterministic date/count skeleton, performance stats, etc.) — computed
  // client-side by the existing, unchanged `parseIntent()` and forwarded
  // as-is. New (non-bridged) tools never read this; it exists purely so the
  // Universal Agent path doesn't regress behavior that was intentionally
  // NOT model-driven.
  legacyContext?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Task Planning — for multi-step requests the agent must show a plan before
// executing (section 5). A single-step request produces a plan with one step
// and may skip straight to execution.
// ---------------------------------------------------------------------------
export type PlanStep = {
  id: string;
  label: string; // human-readable, in the user's language
  toolName?: ToolName; // which tool this step will invoke, if known yet
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
};

export type AgentPlan = {
  id: string;
  summary: string;
  steps: PlanStep[];
  requiresApprovalBeforeRun: boolean; // true whenever any step is destructive
};

// ---------------------------------------------------------------------------
// Tool Registry — section 4. Every tool the agent can call, grouped by
// domain. `sideEffect` marks tools that publish, delete or otherwise take
// an external/irreversible action — these MUST go through Human Approval
// (section 14) before running, never auto-execute from a bare "generate".
// ---------------------------------------------------------------------------
export type ToolDomain = 'content' | 'media' | 'publishing' | 'analytics' | 'brand' | 'social_accounts';

export type ToolName =
  // Content
  | 'create_content' | 'rewrite_content' | 'improve_hook' | 'generate_cta'
  | 'generate_hashtags' | 'create_content_plan' | 'create_campaign'
  | 'repurpose_content' | 'translate_content' | 'adapt_for_platform'
  | 'suggest_ideas'
  // Media
  | 'upload_media' | 'attach_media' | 'replace_media' | 'remove_media'
  | 'generate_media_brief' | 'analyze_media' | 'create_image_prompt'
  // Publishing
  | 'create_schedule' | 'reschedule' | 'cancel_schedule' | 'publish' | 'retry_failed_publish'
  // Analytics
  | 'analyze_performance' | 'compare_platforms' | 'analyze_content'
  | 'detect_trends' | 'recommend_next_content' | 'general_advice'
  // Brand
  | 'read_brand_dna' | 'update_brand_memory' | 'read_brand_memory' | 'enforce_brand_rules'
  // Social accounts
  | 'list_connected_accounts' | 'check_account_status';

export type ToolDefinition = {
  name: ToolName;
  domain: ToolDomain;
  description: string; // used by the LLM for tool selection — Arabic+English
  sideEffect: boolean; // requires human approval before it runs
  // JSON-schema-ish param description, passed to the model as part of the
  // tool-calling contract (kept loose here; validated per-tool at call time)
  paramsSchema: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
};

export type ToolResult = {
  callId: string;
  name: ToolName;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  requiresApproval?: boolean;
};

// ---------------------------------------------------------------------------
// Final agent response shape returned to the client for one turn.
// ---------------------------------------------------------------------------
export type AgentTurnResult = {
  reply: string; // natural-language reply to show in chat
  plan?: AgentPlan;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  pendingApproval?: {
    reason: string;
    toolCalls: ToolCall[];
  };
  clarifyingQuestion?: string; // set when the agent needs more info (section 27)
  intentLabel: AgentIntentLabel;
};
