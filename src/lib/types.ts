export type Workspace = {
  id: string;
  name: string;
  owner_id: string;
  plan: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type WorkspaceMember = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
};

export type BrandDna = {
  id: string;
  workspace_id: string;
  status: 'draft' | 'confirmed';
  basics: Record<string, unknown>;
  identity: Record<string, unknown>;
  tone: Record<string, unknown>;
  audience: Record<string, unknown>;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  positioning?: string | null;
  preferred_phrases?: string[];
  forbidden_phrases?: string[];
  cta_style?: string | null;
  platforms: string[];
  created_at: string;
  updated_at: string;
};

export type BrandMemoryEntry = {
  id: string;
  workspace_id: string;
  type: 'preference' | 'performance' | 'decision' | 'rejection' | 'approval' | 'edit_pattern';
  key: string;
  value: string;
  confidence: number;
  evidence_count: number;
  source: string | null;
  created_at: string;
  updated_at: string;
};

export type SocialPlatform =
  | 'facebook' | 'instagram' | 'linkedin' | 'x'
  | 'threads' | 'tiktok' | 'telegram' | 'whatsapp';

export type SocialAccount = {
  id: string;
  workspace_id: string;
  platform: SocialPlatform;
  handle: string | null;
  display_name: string | null;
  status: 'connected' | 'disconnected' | 'error' | 'expired';
  needs_reconnect: boolean;
  metadata: Record<string, unknown>;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ContentStatus =
  | 'idea' | 'draft' | 'review' | 'approved'
  | 'scheduled' | 'published' | 'rejected';

export type Content = {
  id: string;
  workspace_id: string;
  title: string;
  goal: string | null;
  topic: string | null;
  audience: string | null;
  master_text: string | null;
  status: ContentStatus;
  batch_id?: string | null;
  scheduled_at?: string | null;
  quality_score?: number | null;
  quality_status?: 'pending' | 'passed' | 'needs_improvement' | 'failed';
  platforms: string[];
  ai_meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ContentVariant = {
  id: string;
  content_id: string;
  workspace_id: string;
  platform: string;
  text: string;
  hashtags: string[];
  cta: string | null;
  media_brief: Record<string, unknown>;
  status: 'draft' | 'review' | 'approved' | 'rejected';
  scheduled_at?: string | null;
  quality_score?: number | null;
  quality_status?: 'pending' | 'passed' | 'needs_improvement' | 'failed';
  created_at: string;
  updated_at: string;
};

export type QualityVerdict = 'pass' | 'review' | 'fail';

export type QualityReview = {
  id: string;
  variant_id: string;
  workspace_id: string;
  verdict: QualityVerdict;
  scores: Record<string, number>;
  reasons: string[];
  fixes_applied: number;
  created_at: string;
};

export type CalendarItem = {
  id: string;
  workspace_id: string;
  content_id: string | null;
  variant_id: string | null;
  platform: string;
  scheduled_for: string;
  status: 'planned' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
  created_at: string;
};

export type PublishingJob = {
  id: string;
  workspace_id: string;
  variant_id: string | null;
  calendar_item_id: string | null;
  idempotency_key: string;
  action: 'publish' | 'schedule' | 'retry';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  scheduled_for: string | null;
  completed_at: string | null;
  created_at: string;
};

export type AiRun = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  task: string;
  intent: string | null;
  agents: string[];
  model: string | null;
  provider: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  result: Record<string, unknown>;
  created_at: string;
};

export type Notification = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  read: boolean;
  created_at: string;
};

export type InboxConversation = {
  id: string;
  workspace_id: string;
  account_id: string;
  platform: SocialPlatform | string;
  type: 'dm' | 'comment';
  external_id: string;
  external_participant_id: string | null;
  sender_name: string | null;
  snippet: string | null;
  unread: boolean;
  needs_review: boolean;
  content_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type InboxMessage = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  is_ai: boolean;
  user_id: string | null;
  external_id: string | null;
  sender_external_id: string | null;
  sender_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

// ---- AI Gateway request/response shapes ----

export type AiIntent =
  | 'generate_brand_dna'
  | 'create_content'
  | 'create_content_plan'
  | 'analyze_performance'
  | 'suggest_ideas'
  | 'general_advice';

export type AiGatewayRequest = {
  intent: AiIntent;
  workspaceId: string;
  brandDnaId?: string;
  message: string;
  platforms?: string[];
  context?: Record<string, unknown>;
};

export type GeneratedBrandDna = {
  identity: Record<string, unknown>;
  tone: Record<string, unknown>;
  audience: Record<string, unknown>;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  positioning?: string | null;
  preferred_phrases?: string[];
  forbidden_phrases?: string[];
  cta_style?: string | null;
  platforms: string[];
  summary: string;
};

export type GeneratedVariant = {
  platform: string;
  text: string;
  hashtags: string[];
  cta: string;
  media_brief: Record<string, unknown>;
};

export type GeneratedContent = {
  title: string;
  goal: string;
  topic: string;
  audience: string;
  master_text: string;
  platforms: string[];
  variants: GeneratedVariant[];
  quality?: {
    verdict: QualityVerdict;
    scores: Record<string, number>;
    reasons: string[];
    suggested_improvements?: string[];
  };
};

export type QualityAnalysis = {
  verdict: QualityVerdict;
  scores: Record<string, number>;
  reasons: string[];
};

export type CalendarSlot = {
  date: string;
  platform: string;
  title: string;
  content?: string;
  goal?: string;
  content_type?: string;
  hashtags?: string[];
  cta?: string;
  quality?: {
    verdict: QualityVerdict;
    scores: Record<string, number>;
    reasons: string[];
    suggested_improvements?: string[];
  };
};

export type ContentPlan = {
  theme: string;
  slots: CalendarSlot[];
};

export type AiGatewayResponse = {
  runId: string;
  agents: string[];
  model: string;
  provider: string;
  fallbackCount?: number;
  latencyMs: number;
  result: GeneratedBrandDna | GeneratedContent | ContentPlan | { advice: string };
};

// ---- AI Control Center (Super Admin) ----

export type AiProviderKey =
  | 'openai' | 'openrouter' | 'huggingface' | 'gemini' | 'anthropic'
  | 'xai' | 'mistral' | 'groq' | 'deepseek' | 'cerebras' | 'together'
  | 'fireworks' | 'cohere';

export type AiProvider = {
  id: string;
  provider_key: AiProviderKey;
  display_name: string;
  enabled: boolean;
  has_api_key: boolean;
  base_url: string | null;
  priority: number;
  failover_enabled: boolean;
  allow_paid: boolean;
  status: 'not_configured' | 'connected' | 'error';
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_error: string | null;
  models_count: number;
  healthy_models_count: number;
};

export type AiModel = {
  id: string;
  provider_key: AiProviderKey;
  model_id: string;
  display_name: string | null;
  context_window: number | null;
  vision: boolean;
  reasoning: boolean;
  tool_calling: boolean;
  structured_output: boolean;
  is_free: boolean;
  input_cost_per_1k: number | null;
  output_cost_per_1k: number | null;
  quality_score: number;
  status: 'healthy' | 'degraded' | 'disabled';
  circuit_state: 'closed' | 'open' | 'half_open';
  success_count: number;
  failure_count: number;
  avg_latency_ms: number | null;
};

export type AiRoutingPolicyValue = 'smart_balanced' | 'free_first' | 'lowest_cost' | 'best_quality' | 'fastest';

export type AiRoutingPolicy = {
  policy: AiRoutingPolicyValue;
  allow_paid_fallback: boolean;
};

// ---- Social Integrations (Super Admin) ----

export type SocialPlatformAppKey = 'meta' | 'linkedin' | 'telegram' | 'x';

export type SocialPlatformApp = {
  id: string;
  platform_key: SocialPlatformAppKey;
  display_name: string;
  enabled: boolean;
  has_secret: boolean;
  app_id: string | null;
  redirect_uri: string | null;
  status: 'not_configured' | 'connected' | 'error';
  last_test_at: string | null;
  last_error: string | null;
};

export type AiUsageSummary = {
  totals: { requests: number; tokens: number; cost: number; fallbacks: number; failures: number };
  recent: Array<{
    provider: string | null;
    model: string | null;
    status: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    fallback_count: number;
    created_at: string;
  }>;
};
