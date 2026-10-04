import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const CHECKPOINT_YIELD = 'background_checkpoint';
export type StepProgress = { phase: string; label: string; detail?: string; current?: number; total?: number };
export type ModelAttempt = { provider: string; model: string; attempt: number };

/** All progress/checkpoint writes verify the lease, so cancellation prevents
 * further stages, fallbacks and saves, including when an old response arrives. */
export class DurableSteps {
  private progress: Record<string, unknown> = {};
  constructor(private db: SupabaseClient, private taskId: string, private workerId: string, private cache: Record<string, unknown>) {}
  async assertActive(): Promise<void> {
    const { data, error } = await this.db.from('assistant_tasks').select('id')
      .eq('id', this.taskId).eq('worker_id', this.workerId).eq('status', 'running').maybeSingle();
    if (error || !data) throw new Error('lease_lost');
  }
  async report(progress: StepProgress | ModelAttempt): Promise<void> {
    this.progress = { ...this.progress, ...progress, updated_at: new Date().toISOString() };
    const { data, error } = await this.db.from('assistant_tasks').update({ progress: this.progress, updated_at: new Date().toISOString() })
      .eq('id', this.taskId).eq('worker_id', this.workerId).eq('status', 'running').select('id').maybeSingle();
    if (error || !data) throw new Error('lease_lost');
  }
  async run<T>(key: string, work: () => Promise<T>, yieldAfterSave = true, progress?: StepProgress): Promise<T> {
    await this.assertActive();
    if (Object.hasOwn(this.cache, key)) return this.cache[key] as T;
    this.progress = {};
    await this.report(progress ?? { phase: key.startsWith('context:') ? 'context' : key === 'planner' ? 'planning' : 'execution',
      label: key.startsWith('context:') ? 'تجهيز سياق العلامة والبيانات' : key === 'planner' ? 'فهم الطلب وتحديد خطوات التنفيذ' : 'تنفيذ خطوة الطلب' });
    const result = await work();
    const cache = { ...this.cache, [key]: result };
    const { data, error } = await this.db.from('assistant_tasks').update({ ai_steps: cache })
      .eq('id', this.taskId).eq('worker_id', this.workerId).eq('status', 'running').select('id').maybeSingle();
    if (error || !data) throw new Error('lease_lost');
    Object.assign(this.cache, cache);
    if (yieldAfterSave) throw new Error(CHECKPOINT_YIELD);
    return result;
  }
}
