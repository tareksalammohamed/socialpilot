// ---------------------------------------------------------------------------
// Provider Adapter Layer
//
// Every provider is reached through the same three operations:
//   testConnection(apiKey)               -> { ok, error? }
//   discoverModels(apiKey)                -> DiscoveredModel[]
//   chatComplete(apiKey, modelId, ...)    -> { content, tokensIn, tokensOut }
//
// Agents, the Orchestrator, and the Router never see a provider-specific
// shape — they only ever talk to this interface. Adding a 14th provider
// means adding one entry to PROVIDER_CATALOG (and, if its API truly is
// unlike anything below, one more small adapter function) — nothing in
// router.ts, index.ts, or the frontend changes.
// ---------------------------------------------------------------------------

export type ProviderKey =
  | 'openai' | 'openrouter' | 'huggingface' | 'gemini' | 'anthropic'
  | 'xai' | 'mistral' | 'groq' | 'deepseek' | 'cerebras' | 'together'
  | 'fireworks' | 'cohere';

export type DiscoveredModel = {
  model_id: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  vision: boolean;
  reasoning: boolean;
  tool_calling: boolean;
  structured_output: boolean;
  audio: boolean;
  image: boolean;
  embedding: boolean;
  is_free: boolean;
  input_cost_per_1k: number | null;
  output_cost_per_1k: number | null;
};

export type ChatResult = {
  content: string;
  tokensIn: number;
  tokensOut: number;
  // Populated only when webSearchOptions was requested and the provider
  // actually ran a web search for this call (currently: OpenRouter's `web`
  // plugin, which works across every model it routes to). Every other
  // adapter simply never sets this — absence means "no search was run",
  // never "search ran but found nothing" (that's an empty array).
  citations?: Array<{ url: string; title: string; content: string }>;
};

export type TestResult = { ok: boolean; error?: string };

export interface ProviderAdapter {
  testConnection(apiKey: string, baseUrlOverride?: string | null): Promise<TestResult>;
  discoverModels(apiKey: string, baseUrlOverride?: string | null): Promise<DiscoveredModel[]>;
  chatComplete(
    apiKey: string,
    modelId: string,
    systemPrompt: string,
    userPrompt: string,
    jsonMode: boolean,
    baseUrlOverride?: string | null,
    webSearchOptions?: { maxResults?: number; includeDomains?: string[]; excludeDomains?: string[] } | null
  ): Promise<ChatResult>;
}

// Classifies a failed HTTP call so the router knows whether to try the next
// model/provider or stop immediately (see index.ts FAILOVER_STATUS).
export class ProviderCallError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return res.statusText;
  }
}

// ---------------------------------------------------------------------------
// Known-model enrichment hints. Several providers (OpenAI, Anthropic, Cohere)
// return bare model IDs with no capability/cost metadata from their list
// endpoints, so this small lookup fills in what the API itself won't tell
// us. It is enrichment only, never the source of truth for *which* models
// exist — that always comes from the live discovery call.
// ---------------------------------------------------------------------------
const KNOWN_HINTS: Array<{
  match: RegExp;
  hint: Partial<DiscoveredModel>;
}> = [
  { match: /gpt-4o-mini|gpt-4\.1-mini|o4-mini|o3-mini/i, hint: { context_window: 128000, vision: true, tool_calling: true, structured_output: true, reasoning: true } },
  { match: /gpt-4o|gpt-4\.1|gpt-5/i, hint: { context_window: 128000, vision: true, tool_calling: true, structured_output: true, reasoning: true } },
  { match: /^o1|^o3|^o4/i, hint: { context_window: 128000, reasoning: true, tool_calling: true, structured_output: true } },
  { match: /gpt-3\.5/i, hint: { context_window: 16000, tool_calling: true, structured_output: true } },
  { match: /claude-.*opus|claude-.*sonnet/i, hint: { context_window: 200000, vision: true, reasoning: true, tool_calling: true, structured_output: true } },
  { match: /claude-.*haiku/i, hint: { context_window: 200000, vision: true, tool_calling: true, structured_output: true } },
  { match: /command-a|command-r-plus/i, hint: { context_window: 128000, tool_calling: true, structured_output: true, reasoning: true } },
  { match: /command-r|command-light/i, hint: { context_window: 128000, tool_calling: true, structured_output: true } },
];

function enrich(base: DiscoveredModel): DiscoveredModel {
  for (const { match, hint } of KNOWN_HINTS) {
    if (match.test(base.model_id)) return { ...base, ...hint };
  }
  return base;
}

function blankModel(id: string, displayName?: string): DiscoveredModel {
  return {
    model_id: id,
    display_name: displayName ?? id,
    context_window: null,
    max_output_tokens: null,
    vision: false,
    reasoning: false,
    tool_calling: false,
    structured_output: false,
    audio: false,
    image: false,
    embedding: false,
    is_free: false,
    input_cost_per_1k: null,
    output_cost_per_1k: null,
  };
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible adapter — covers OpenAI, OpenRouter, xAI,
// Mistral, Groq, DeepSeek, Cerebras, Together AI, and Fireworks AI (and
// Hugging Face's chat endpoint, which is also OpenAI-compatible). Every
// entry in PROVIDER_CATALOG below just supplies its own base URL.
// ---------------------------------------------------------------------------
function makeOpenAICompatibleAdapter(defaultBaseUrl: string, opts?: { isOpenRouter?: boolean }): ProviderAdapter {
  return {
    async testConnection(apiKey, baseUrlOverride) {
      const base = baseUrlOverride || defaultBaseUrl;
      try {
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
      }
    },

    async discoverModels(apiKey, baseUrlOverride) {
      const base = baseUrlOverride || defaultBaseUrl;
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
      const data = await res.json();
      const list: unknown[] = data.data ?? data.models ?? [];

      return list.map((raw) => {
        const m = raw as Record<string, unknown>;
        const id = String(m.id ?? m.name ?? '');
        let model = blankModel(id, (m.name as string) ?? id);

        if (opts?.isOpenRouter) {
          const pricing = (m.pricing as Record<string, string>) ?? {};
          const promptCost = parseFloat(pricing.prompt ?? '0');
          const completionCost = parseFloat(pricing.completion ?? '0');
          const architecture = (m.architecture as Record<string, unknown>) ?? {};
          const modality = String(architecture.modality ?? '');
          const supportedParams = (m.supported_parameters as string[]) ?? [];
          const topProvider = (m.top_provider as Record<string, unknown>) ?? {};
          model = {
            ...model,
            display_name: String(m.name ?? id),
            context_window: (m.context_length as number) ?? null,
            max_output_tokens: (topProvider.max_completion_tokens as number) ?? null,
            vision: modality.includes('image'),
            tool_calling: supportedParams.includes('tools'),
            structured_output: supportedParams.includes('response_format') || supportedParams.includes('structured_outputs'),
            reasoning: supportedParams.includes('reasoning') || /think|reasoning|r1/i.test(id),
            is_free: promptCost === 0 && completionCost === 0,
            input_cost_per_1k: promptCost * 1000,
            output_cost_per_1k: completionCost * 1000,
          };
        }

        return enrich(model);
      }).filter((m) => m.model_id);
    },

    async chatComplete(apiKey, modelId, systemPrompt, userPrompt, jsonMode, baseUrlOverride, webSearchOptions) {
      const base = baseUrlOverride || defaultBaseUrl;
      const body: Record<string, unknown> = {
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      };
      if (jsonMode) body.response_format = { type: 'json_object' };
      // Web search (OpenRouter only, §lead-hunter "use the app's own AI models
      // to search, not a separate hosted search engine"): the `web` plugin
      // runs a real search server-side and returns url_citation annotations,
      // regardless of which underlying model is selected. This is the only
      // adapter that implements it — every other provider silently ignores
      // webSearchOptions, which is correct: it means "no search capability
      // here", not "search ran and found nothing".
      if (opts?.isOpenRouter && webSearchOptions) {
        const plugin: Record<string, unknown> = { id: 'web', max_results: webSearchOptions.maxResults ?? 6 };
        if (webSearchOptions.includeDomains?.length) plugin.include_domains = webSearchOptions.includeDomains;
        if (webSearchOptions.excludeDomains?.length) plugin.exclude_domains = webSearchOptions.excludeDomains;
        body.plugins = [plugin];
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
      const data = await res.json();
      const message = data.choices?.[0]?.message ?? {};
      const content = message.content ?? '';
      const annotations = Array.isArray(message.annotations) ? message.annotations : [];
      const citations = opts?.isOpenRouter && webSearchOptions
        ? annotations
          .filter((a: Record<string, unknown>) => a?.type === 'url_citation' && a.url_citation)
          .map((a: Record<string, unknown>) => {
            const uc = a.url_citation as Record<string, unknown>;
            return { url: String(uc.url ?? ''), title: String(uc.title ?? ''), content: String(uc.content ?? '') };
          })
          .filter((c: { url: string }) => c.url)
        : undefined;

      return {
        content,
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
        ...(citations ? { citations } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic — Messages API (different auth header + payload shape)
// ---------------------------------------------------------------------------
const ANTHROPIC_VERSION = '2023-06-01';
const anthropicAdapter: ProviderAdapter = {
  async testConnection(apiKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  },

  async discoverModels(apiKey) {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    });
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const list: unknown[] = data.data ?? [];
    return list.map((raw) => {
      const m = raw as Record<string, unknown>;
      const id = String(m.id ?? '');
      return enrich(blankModel(id, (m.display_name as string) ?? id));
    }).filter((m) => m.model_id);
  },

  async chatComplete(apiKey, modelId, systemPrompt, userPrompt, jsonMode) {
    const sys = jsonMode ? `${systemPrompt}\n\nRespond ONLY with valid JSON, no other text.` : systemPrompt;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: modelId,
        system: sys,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 2000,
        temperature: 0.7,
      }),
    });
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const content = (data.content ?? []).map((b: Record<string, unknown>) => b.text ?? '').join('');
    return {
      content,
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Google Gemini — Generative Language API
// ---------------------------------------------------------------------------
const geminiAdapter: ProviderAdapter = {
  async testConnection(apiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  },

  async discoverModels(apiKey) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const list: unknown[] = data.models ?? [];
    return list
      .map((raw) => {
        const m = raw as Record<string, unknown>;
        const methods = (m.supportedGenerationMethods as string[]) ?? [];
        if (!methods.includes('generateContent')) return null;
        const name = String(m.name ?? '').replace(/^models\//, '');
        const model = blankModel(name, (m.displayName as string) ?? name);
        return enrich({
          ...model,
          context_window: (m.inputTokenLimit as number) ?? null,
          max_output_tokens: (m.outputTokenLimit as number) ?? null,
          vision: !/embedding|aqa/i.test(name),
          reasoning: /pro|thinking/i.test(name),
          tool_calling: true,
          structured_output: true,
        });
      })
      .filter((m): m is DiscoveredModel => m !== null);
  },

  async chatComplete(apiKey, modelId, systemPrompt, userPrompt, jsonMode) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const generationConfig: Record<string, unknown> = { temperature: 0.7, maxOutputTokens: 2000 };
    if (jsonMode) generationConfig.responseMimeType = 'application/json';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig,
      }),
    });
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const content = data.candidates?.[0]?.content?.parts?.map((p: Record<string, unknown>) => p.text ?? '').join('') ?? '';
    return {
      content,
      tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Cohere — v2 Chat API
// ---------------------------------------------------------------------------
const cohereAdapter: ProviderAdapter = {
  async testConnection(apiKey) {
    try {
      const res = await fetch('https://api.cohere.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  },

  async discoverModels(apiKey) {
    const res = await fetch('https://api.cohere.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const list: unknown[] = data.models ?? [];
    return list
      .map((raw) => {
        const m = raw as Record<string, unknown>;
        const endpoints = (m.endpoints as string[]) ?? [];
        if (!endpoints.includes('chat')) return null;
        const id = String(m.name ?? '');
        return enrich({
          ...blankModel(id, id),
          context_window: (m.context_length as number) ?? null,
          tool_calling: true,
          structured_output: true,
        });
      })
      .filter((m): m is DiscoveredModel => m !== null);
  },

  async chatComplete(apiKey, modelId, systemPrompt, userPrompt, jsonMode) {
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: jsonMode ? { type: 'json_object' } : undefined,
      }),
    });
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const content = (data.message?.content ?? []).map((b: Record<string, unknown>) => b.text ?? '').join('');
    return {
      content,
      tokensIn: data.usage?.tokens?.input_tokens ?? 0,
      tokensOut: data.usage?.tokens?.output_tokens ?? 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Hugging Face — chat via the OpenAI-compatible Inference Router; discovery
// via the Hub API (best-effort: HF has no single endpoint that returns
// capability/cost metadata the way OpenRouter does, so this is a heuristic
// layer on top of live data, not a hardcoded model list).
// ---------------------------------------------------------------------------
const hfRouterChat = makeOpenAICompatibleAdapter('https://router.huggingface.co/v1');
const huggingfaceAdapter: ProviderAdapter = {
  async testConnection(apiKey) {
    try {
      const res = await fetch('https://huggingface.co/api/whoami-v2', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await readErrorBody(res)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
    }
  },

  async discoverModels(apiKey) {
    const res = await fetch(
      'https://huggingface.co/api/models?pipeline_tag=text-generation&inference_provider=all&sort=trending&limit=40',
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) throw new ProviderCallError(res.status, await readErrorBody(res));
    const data = await res.json();
    const list: unknown[] = Array.isArray(data) ? data : [];
    return list.map((raw) => {
      const m = raw as Record<string, unknown>;
      const id = String(m.id ?? m.modelId ?? '');
      const tags = (m.tags as string[]) ?? [];
      return enrich({
        ...blankModel(id, id),
        vision: tags.includes('image-text-to-text'),
        tool_calling: tags.includes('tool-use') || tags.includes('function-calling'),
        is_free: true, // HF's serverless router free tier — rate-limited, not billed
      });
    }).filter((m) => m.model_id);
  },

  chatComplete: hfRouterChat.chatComplete,
};

// ---------------------------------------------------------------------------
// Provider catalog — the single place that maps a provider_key to its
// adapter + default base URL. Adding provider #14 is one entry here.
// ---------------------------------------------------------------------------
export const PROVIDER_CATALOG: Record<ProviderKey, { adapter: ProviderAdapter; defaultBaseUrl: string | null }> = {
  openai: { adapter: makeOpenAICompatibleAdapter('https://api.openai.com/v1'), defaultBaseUrl: 'https://api.openai.com/v1' },
  openrouter: { adapter: makeOpenAICompatibleAdapter('https://openrouter.ai/api/v1', { isOpenRouter: true }), defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  xai: { adapter: makeOpenAICompatibleAdapter('https://api.x.ai/v1'), defaultBaseUrl: 'https://api.x.ai/v1' },
  mistral: { adapter: makeOpenAICompatibleAdapter('https://api.mistral.ai/v1'), defaultBaseUrl: 'https://api.mistral.ai/v1' },
  groq: { adapter: makeOpenAICompatibleAdapter('https://api.groq.com/openai/v1'), defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  deepseek: { adapter: makeOpenAICompatibleAdapter('https://api.deepseek.com/v1'), defaultBaseUrl: 'https://api.deepseek.com/v1' },
  cerebras: { adapter: makeOpenAICompatibleAdapter('https://api.cerebras.ai/v1'), defaultBaseUrl: 'https://api.cerebras.ai/v1' },
  together: { adapter: makeOpenAICompatibleAdapter('https://api.together.xyz/v1'), defaultBaseUrl: 'https://api.together.xyz/v1' },
  fireworks: { adapter: makeOpenAICompatibleAdapter('https://api.fireworks.ai/inference/v1'), defaultBaseUrl: 'https://api.fireworks.ai/inference/v1' },
  huggingface: { adapter: huggingfaceAdapter, defaultBaseUrl: 'https://router.huggingface.co/v1' },
  anthropic: { adapter: anthropicAdapter, defaultBaseUrl: null },
  gemini: { adapter: geminiAdapter, defaultBaseUrl: null },
  cohere: { adapter: cohereAdapter, defaultBaseUrl: null },
};

export function getAdapter(providerKey: string): ProviderAdapter | null {
  return (PROVIDER_CATALOG as Record<string, { adapter: ProviderAdapter }>)[providerKey]?.adapter ?? null;
}

// Rough capability-depth score for quality-based ranking, computed from
// what discovery actually returned — not a hardcoded model→score table.
export function computeQualityScore(m: DiscoveredModel): number {
  return (
    (m.context_window ?? 8000) / 1000 +
    (m.reasoning ? 20 : 0) +
    (m.tool_calling ? 5 : 0) +
    (m.structured_output ? 10 : 0) +
    (m.vision ? 5 : 0)
  );
}
