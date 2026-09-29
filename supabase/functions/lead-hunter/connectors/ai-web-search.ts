import type { LeadSourceConnector, RawCandidate, SearchSpecification, SourceCredentials } from '../researchAgent.ts';
import type { LeadRecord } from '../pipeline.ts';

const REQUEST_TIMEOUT_MS = 25_000;

export class AiWebSearchNotConfiguredError extends Error {
  readonly code = 'NOT_CONFIGURED';
  constructor(message = 'لا يوجد Model مفعّل يدعم البحث عبر الويب (AI Gateway) حاليًا.') {
    super(message);
    this.name = 'AiWebSearchNotConfiguredError';
  }
}

export class AiWebSearchSourceError extends Error {
  readonly code: 'SOURCE_ERROR' | 'TIMEOUT' | 'PERMISSION_ERROR';
  constructor(code: AiWebSearchSourceError['code'], message: string) {
    super(message);
    this.name = 'AiWebSearchSourceError';
    this.code = code;
  }
}

type GatewaySearchResult = { title?: string; link?: string; snippet?: string };

async function callGatewaySearch(
  gatewayUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  userId: string,
  query: string,
  maxResults: number,
): Promise<GatewaySearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        intent: 'lead_hunter_web_search',
        workspaceId,
        onBehalfOfUserId: userId,
        message: query,
        context: { maxResults },
      }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiWebSearchSourceError('TIMEOUT', 'انتهت مهلة استدعاء AI Gateway للبحث.');
    }
    throw new AiWebSearchSourceError('SOURCE_ERROR', error instanceof Error ? error.message : 'تعذر الوصول إلى AI Gateway.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 503) throw new AiWebSearchNotConfiguredError();
  if (res.status === 401 || res.status === 403) throw new AiWebSearchSourceError('PERMISSION_ERROR', `AI Gateway HTTP ${res.status}.`);
  if (!res.ok) throw new AiWebSearchSourceError('SOURCE_ERROR', `AI Gateway HTTP ${res.status}.`);
  const body = await res.json() as { result?: { results?: GatewaySearchResult[]; error?: string } };
  if (body.result?.error === 'EMPTY_QUERY') return [];
  const results = body.result?.results;
  return Array.isArray(results) ? results : [];
}

export function createAiWebSearchConnector(gatewayUrl: string, serviceRoleKey: string): LeadSourceConnector {
  return {
    key: 'ai_web_search',
    async search(query: string, _spec: SearchSpecification, credentials: SourceCredentials): Promise<RawCandidate[]> {
      if (!credentials.workspaceId || !credentials.userId) throw new AiWebSearchNotConfiguredError('لا يوجد سياق Workspace/User صالح لاستدعاء AI Gateway.');
      const results = await callGatewaySearch(gatewayUrl, serviceRoleKey, credentials.workspaceId, credentials.userId, query, 8);
      return results
        .filter((r) => r.link)
        .map((r) => ({ source_url: r.link, evidence: r.snippet ?? '', _serp_title: r.title ?? '', _serp_query: query }));
    },
    async normalize(record: RawCandidate): Promise<LeadRecord> {
      return { source_url: record.source_url, notes: record.evidence };
    },
    async validate(): Promise<{ valid: boolean; errors: string[] }> {
      return { valid: false, errors: ['يتطلب استخراج AI قبل الاعتماد — لا يُستخدم هذا المسار للنتائج الخام.'] };
    },
  };
}
