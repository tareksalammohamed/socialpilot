import type { ToolDefinition, ToolName } from './types.ts';

// ---------------------------------------------------------------------------
// Tool Registry
//
// This is metadata only — it tells the model what tools exist and whether
// calling them needs Human Approval first. Actual execution lives in
// executors.ts (Phase 2), one function per ToolName.
//
// sideEffect = true means: publishing, deleting, or any externally-visible
// or hard-to-reverse change. Per section 14/28, these never auto-run off a
// bare generate — they always land in `pendingApproval` first.
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY: Record<ToolName, ToolDefinition> = {
  // ---- Content ----
  create_content: {
    name: 'create_content', domain: 'content', sideEffect: false,
    description: 'Draft a new post (single post or as part of a plan) honoring Brand DNA and platform rules.',
    paramsSchema: { topic: 'string', platforms: 'string[]', goal: 'string?', tone: 'string?' },
  },
  rewrite_content: {
    name: 'rewrite_content', domain: 'content', sideEffect: false,
    description: 'Rewrite an existing content item (by contentId) based on feedback, keeping the same slot instead of creating a new one.',
    paramsSchema: { contentId: 'string', instructions: 'string' },
  },
  improve_hook: {
    name: 'improve_hook', domain: 'content', sideEffect: false,
    description: 'Rewrite only the opening hook of a content item.',
    paramsSchema: { contentId: 'string', direction: 'string?' },
  },
  generate_cta: {
    name: 'generate_cta', domain: 'content', sideEffect: false,
    description: 'Generate a call-to-action for a content item or platform.',
    paramsSchema: { contentId: 'string?', goal: 'string?' },
  },
  generate_hashtags: {
    name: 'generate_hashtags', domain: 'content', sideEffect: false,
    description: 'Generate relevant hashtags for a content item and platform.',
    paramsSchema: { contentId: 'string', platform: 'string' },
  },
  create_content_plan: {
    name: 'create_content_plan', domain: 'content', sideEffect: false,
    description: 'Produce a multi-post content plan (topics + pillars + cadence) without scheduling it yet.',
    paramsSchema: { goal: 'string', durationDays: 'number', platforms: 'string[]' },
  },
  create_campaign: {
    name: 'create_campaign', domain: 'content', sideEffect: false,
    description: 'Build a full campaign: objective, audience, pillars, posts, variants, media briefs, proposed schedule — as a draft awaiting approval.',
    paramsSchema: { objective: 'string', durationDays: 'number', audience: 'string?', platforms: 'string[]' },
  },
  repurpose_content: {
    name: 'repurpose_content', domain: 'content', sideEffect: false,
    description: 'Turn one source (article, existing post, PDF text, transcript) into new post(s)/variants without copying long passages verbatim.',
    paramsSchema: { sourceText: 'string', targetFormats: 'string[]' },
  },
  translate_content: {
    name: 'translate_content', domain: 'content', sideEffect: false,
    description: 'Translate/localize a content item between Arabic and English while preserving Brand Voice.',
    paramsSchema: { contentId: 'string', targetLanguage: 'string' },
  },
  adapt_for_platform: {
    name: 'adapt_for_platform', domain: 'content', sideEffect: false,
    description: 'Re-shape an existing content item for a specific platform (length, tone, structure) per the Platform Adapter rules.',
    paramsSchema: { contentId: 'string', platform: 'string' },
  },
  suggest_ideas: {
    name: 'suggest_ideas', domain: 'content', sideEffect: false,
    description: 'Suggest fresh content ideas/topics fitting the Brand DNA — used when the user wants inspiration rather than a finished draft.',
    paramsSchema: { goal: 'string?', platforms: 'string[]?' },
  },

  // ---- Media ----
  upload_media: {
    name: 'upload_media', domain: 'media', sideEffect: false,
    description: 'Register an uploaded image/video against a content item.',
    paramsSchema: { contentId: 'string', fileRef: 'string' },
  },
  attach_media: {
    name: 'attach_media', domain: 'media', sideEffect: false,
    description: 'Attach an existing media-library item to a content item.',
    paramsSchema: { contentId: 'string', mediaId: 'string' },
  },
  replace_media: {
    name: 'replace_media', domain: 'media', sideEffect: false,
    description: 'Replace the media currently attached to a content item.',
    paramsSchema: { contentId: 'string', mediaId: 'string' },
  },
  remove_media: {
    name: 'remove_media', domain: 'media', sideEffect: false,
    description: 'Detach media from a content item.',
    paramsSchema: { contentId: 'string' },
  },
  generate_media_brief: {
    name: 'generate_media_brief', domain: 'media', sideEffect: false,
    description: 'Produce a text brief describing the ideal image/video for a content item (never auto-attaches an image).',
    paramsSchema: { contentId: 'string' },
  },
  analyze_media: {
    name: 'analyze_media', domain: 'media', sideEffect: false,
    description: 'Describe/critique an existing image or video attached to a content item (requires a vision-capable model).',
    paramsSchema: { mediaId: 'string' },
  },
  create_image_prompt: {
    name: 'create_image_prompt', domain: 'media', sideEffect: false,
    description: 'Produce a concrete image-generation prompt from a media brief.',
    paramsSchema: { contentId: 'string' },
  },

  // ---- Publishing (all side-effecting) ----
  create_schedule: {
    name: 'create_schedule', domain: 'publishing', sideEffect: true,
    description: 'Schedule a content item to publish at a specific time.',
    paramsSchema: { contentId: 'string', publishAt: 'string' },
  },
  reschedule: {
    name: 'reschedule', domain: 'publishing', sideEffect: true,
    description: 'Change the scheduled time of an already-scheduled item.',
    paramsSchema: { contentId: 'string', newPublishAt: 'string' },
  },
  cancel_schedule: {
    name: 'cancel_schedule', domain: 'publishing', sideEffect: true,
    description: 'Cancel a pending scheduled publish.',
    paramsSchema: { contentId: 'string' },
  },
  publish: {
    name: 'publish', domain: 'publishing', sideEffect: true,
    description: 'Publish a content item immediately to its connected account(s).',
    paramsSchema: { contentId: 'string' },
  },
  retry_failed_publish: {
    name: 'retry_failed_publish', domain: 'publishing', sideEffect: true,
    description: 'Retry a publish attempt that previously failed.',
    paramsSchema: { contentId: 'string' },
  },

  // ---- Analytics (read-only) ----
  analyze_performance: {
    name: 'analyze_performance', domain: 'analytics', sideEffect: false,
    description: 'Summarize performance over a date range, grounded only in real stored metrics.',
    paramsSchema: { rangeDays: 'number', platform: 'string?' },
  },
  compare_platforms: {
    name: 'compare_platforms', domain: 'analytics', sideEffect: false,
    description: 'Compare performance across connected platforms.',
    paramsSchema: { rangeDays: 'number' },
  },
  analyze_content: {
    name: 'analyze_content', domain: 'analytics', sideEffect: false,
    description: 'Analyze which content types/hooks/CTAs performed best.',
    paramsSchema: { rangeDays: 'number' },
  },
  detect_trends: {
    name: 'detect_trends', domain: 'analytics', sideEffect: false,
    description: 'Detect emerging patterns in recent performance data.',
    paramsSchema: { rangeDays: 'number' },
  },
  recommend_next_content: {
    name: 'recommend_next_content', domain: 'analytics', sideEffect: false,
    description: 'Recommend what to publish next, grounded in analyze_performance/analyze_content output.',
    paramsSchema: { rangeDays: 'number' },
  },
  general_advice: {
    name: 'general_advice', domain: 'analytics', sideEffect: false,
    description: 'Open-ended strategic advice that does not fit a narrower tool — the fallback for a general question about the account/strategy.',
    paramsSchema: { question: 'string?' },
  },

  // ---- Brand ----
  read_brand_dna: {
    name: 'read_brand_dna', domain: 'brand', sideEffect: false,
    description: 'Fetch the workspace Brand DNA (tone, audience, positioning, pillars, phrases, CTA style, visual identity).',
    paramsSchema: {},
  },
  update_brand_memory: {
    name: 'update_brand_memory', domain: 'brand', sideEffect: true,
    description: 'Record a learned pattern (edit pattern, rejected content type, preferred phrase) into Brand Memory.',
    paramsSchema: { patternType: 'string', detail: 'string' },
  },
  read_brand_memory: {
    name: 'read_brand_memory', domain: 'brand', sideEffect: false,
    description: 'Read learned patterns from Brand Memory to inform generation.',
    paramsSchema: {},
  },
  enforce_brand_rules: {
    name: 'enforce_brand_rules', domain: 'brand', sideEffect: false,
    description: 'Check a draft content item against Brand DNA rules (forbidden phrases, tone) and report violations.',
    paramsSchema: { contentId: 'string' },
  },

  // ---- Social accounts (read-only) ----
  list_connected_accounts: {
    name: 'list_connected_accounts', domain: 'social_accounts', sideEffect: false,
    description: 'List the workspace social accounts currently connected.',
    paramsSchema: {},
  },
  check_account_status: {
    name: 'check_account_status', domain: 'social_accounts', sideEffect: false,
    description: 'Check whether a connected account token is valid/expired.',
    paramsSchema: { accountId: 'string' },
  },
};

export function listToolsForPrompt(): string {
  return Object.values(TOOL_REGISTRY)
    .map((t) => `- ${t.name} (${t.domain}${t.sideEffect ? ', side-effect' : ''}): ${t.description}`)
    .join('\n');
}
