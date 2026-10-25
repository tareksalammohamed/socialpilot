import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const UNCERTAIN_PUBLICATION = 'نتيجة النشر غير مؤكدة؛ تحقق من حساب المنصة قبل إعادة الإرسال حتى لا يتكرر المنشور.';
export const HELD_PUBLICATION_OUTCOMES = ['dispatching', 'uncertain'];

export class UncertainPublicationError extends Error {
  constructor() { super(UNCERTAIN_PUBLICATION); }
}

/** One object per claimed job, never shared between requests. The durable
 * dispatch marker survives process termination before a response is saved. */
export class PublicationAttempt {
  private dispatched = false;
  constructor(private db: SupabaseClient, private jobId: string) {}

  async send(input: string | URL, init: RequestInit): Promise<Response> {
    const { data, error } = await this.db.from('publishing_jobs')
      .update({ result: { outcome: 'dispatching' } }).eq('id', this.jobId)
      .eq('status', 'running').select('id').maybeSingle();
    if (error || !data) throw new Error('تعذّر تأكيد مهمة النشر؛ لم يتم إرسال المنشور.');
    this.dispatched = true;
    // Publication POSTs cannot safely be replayed after a lost response or 5xx.
    const response = await fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(45_000) });
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      // Explicit rejection confirms this request did not produce a post.
      this.dispatched = false;
      const { error: saveError } = await this.db.from('publishing_jobs')
        .update({ result: { outcome: 'rejected', http_status: response.status } }).eq('id', this.jobId);
      if (saveError) throw new Error('تعذّر حفظ رفض المنصة لطلب النشر.');
    }
    return response;
  }

  async run<T extends { id: string; url: string | null }>(publish: () => Promise<T>): Promise<T> {
    try {
      const result = await publish();
      if (!result.id || result.id === 'undefined' || result.id === 'null') throw new Error('Missing post identifier');
      const { error } = await this.db.from('publishing_jobs')
        .update({ result: { outcome: 'confirmed', post_id: result.id, url: result.url } }).eq('id', this.jobId);
      if (error) throw error;
      return result;
    } catch (error) {
      if (this.dispatched) throw new UncertainPublicationError();
      throw error;
    }
  }
}

/** Also blocks a new key/changed schedule from bypassing an unresolved send. */
export async function findPublicationHold(db: SupabaseClient, workspaceId: string, variantId: string): Promise<string | null> {
  const { data, error } = await db.from('publishing_jobs').select('id,status,last_attempt_at')
    .eq('workspace_id', workspaceId).eq('variant_id', variantId)
    .in('result->>outcome', HELD_PUBLICATION_OUTCOMES).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.status === 'running' && Date.now() - new Date(data.last_attempt_at).getTime() < 15 * 60_000) {
    return 'توجد محاولة نشر جارية لنفس المحتوى؛ انتظر نتيجتها قبل إعادة الإرسال.';
  }
  if (data.status === 'running') {
    const { error: saveError } = await db.from('publishing_jobs')
      .update({ status: 'failed', result: { outcome: 'uncertain' }, last_error: UNCERTAIN_PUBLICATION })
      .eq('id', data.id).eq('status', 'running');
    if (saveError) throw saveError;
  }
  return UNCERTAIN_PUBLICATION;
}
