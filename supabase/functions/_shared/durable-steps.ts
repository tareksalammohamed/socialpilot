import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const CHECKPOINT_YIELD = 'background_checkpoint';

/** Persist each AI stage, then yield. The next cron invocation reads it and
 * advances to the next stage, keeping long plans within free runtime limits. */
export class DurableSteps {
  constructor(private db: SupabaseClient, private taskId: string, private workerId: string, private cache: Record<string, unknown>) {}
  async run<T>(key: string, work: () => Promise<T>, yieldAfterSave = true): Promise<T> {
    if (Object.hasOwn(this.cache, key)) return this.cache[key] as T;
    const result = await work();
    this.cache[key] = result;
    const { data, error } = await this.db.from('assistant_tasks').update({ ai_steps: this.cache })
      .eq('id', this.taskId).eq('worker_id', this.workerId).eq('status', 'running').select('id').maybeSingle();
    if (error || !data) throw new Error('lease_lost');
    if (yieldAfterSave) throw new Error(CHECKPOINT_YIELD);
    return result;
  }
}
