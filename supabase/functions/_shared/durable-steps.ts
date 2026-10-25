import { METRICS_CACHE_KEY, parseExecutionMetrics, measuredPhase, addMeasurement, type MetricPhase } from './execution-metrics.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export const CHECKPOINT_YIELD = 'background_checkpoint';
export type StepProgress = { phase: string; label: string; detail?: string; current?: number; total?: number };
export type ModelAttempt = { provider: string; model: string; attempt: number };

/** All progress/checkpoint writes verify the lease, so cancellation prevents
 * further stages, fallbacks and saves, including when an old response arrives. */
export class DurableSteps {
  private measurement: {phase:MetricPhase;attempts:number;seen:Set<string>}|undefined;
  private progress: Record<string, unknown> = {};
  constructor(private db: SupabaseClient, private taskId: string, private workerId: string, private cache: Record<string, unknown>, private clock:()=>number = ()=>performance.now()) {}
  get taskKey():string { return this.taskId; }
  get workerKey():string { return this.workerId; }
  async assertActive(): Promise<void> {
    const { data, error } = await this.db.from('assistant_tasks').select('id')
      .eq('id', this.taskId).eq('worker_id', this.workerId).eq('status', 'running').maybeSingle();
    if (error || !data) throw new Error('lease_lost');
  }
  async report(progress: StepProgress | ModelAttempt): Promise<void> {
    if('phase' in progress && progress.phase!==this.progress.phase)this.progress.phase_started_at=new Date().toISOString();
    if('attempt' in progress && this.measurement){const signature=JSON.stringify(progress);if(!this.measurement.seen.has(signature)){this.measurement.seen.add(signature);this.measurement.attempts++;}}
    this.progress = { ...this.progress, metrics:parseExecutionMetrics(this.cache[METRICS_CACHE_KEY]), ...progress, updated_at: new Date().toISOString() };
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
    const phase=measuredPhase(key,progress?.phase);
    const measurement=phase?{phase,attempts:0,seen:new Set<string>()}:undefined;
    this.measurement=measurement;
    const started=this.clock();
    let result:T;
    try { result=await work(); }
    catch(error) {
      if(measurement) {
        this.progress={...this.progress,phase_completed_at:new Date().toISOString(),updated_at:new Date().toISOString()};
        const metrics=addMeasurement(this.cache[METRICS_CACHE_KEY],measurement.phase,this.clock()-started,true,measurement.attempts);
        const failedCache={...this.cache,[METRICS_CACHE_KEY]:metrics};
        const {data,error:saveError}=await this.db.from('assistant_tasks').update({ai_steps:failedCache,progress:{...this.progress,metrics}})
          .eq('id',this.taskId).eq('worker_id',this.workerId).eq('status','running').select('id').maybeSingle();
        if(saveError||!data)throw new Error('lease_lost');
        Object.assign(this.cache,failedCache);
      }
      throw error;
    } finally { if(this.measurement===measurement)this.measurement=undefined; }
    if(measurement)this.progress={...this.progress,phase_completed_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    const metrics=measurement?addMeasurement(this.cache[METRICS_CACHE_KEY],measurement.phase,this.clock()-started,false,measurement.attempts):parseExecutionMetrics(this.cache[METRICS_CACHE_KEY]);
    const cache = { ...this.cache, [key]: result, [METRICS_CACHE_KEY]:metrics };
    const { data, error } = await this.db.from('assistant_tasks').update({ ai_steps: cache, progress:{...this.progress,metrics} })
      .eq('id', this.taskId).eq('worker_id', this.workerId).eq('status', 'running').select('id').maybeSingle();
    if (error || !data) throw new Error('lease_lost');
    Object.assign(this.cache, cache);
    if (yieldAfterSave) throw new Error(CHECKPOINT_YIELD);
    return result;
  }
}

