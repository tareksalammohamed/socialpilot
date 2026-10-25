export const METRICS_CACHE_KEY = '__execution_metrics_v1';
export const PHASE_LABELS = { planning:'فهم الطلب', context:'تجهيز السياق', generation:'الكتابة', quality:'المراجعة', improvement:'التحسين' } as const;
export type MetricPhase = keyof typeof PHASE_LABELS;
export type PhaseMetric = { duration_ms:number; completed:number; failed:number; reported_model_attempts:number };
export type ExecutionMetrics = { version:1; phases:Partial<Record<MetricPhase,PhaseMetric>> };
const fields = ['duration_ms','completed','failed','reported_model_attempts'] as const;
export function parseExecutionMetrics(value:unknown):ExecutionMetrics {
  const result:ExecutionMetrics={version:1,phases:{}};
  if(!value||typeof value!=='object'||(value as ExecutionMetrics).version!==1)return result;
  const phases=(value as ExecutionMetrics).phases;
  if(!phases||typeof phases!=='object')return result;
  for(const phase of Object.keys(PHASE_LABELS) as MetricPhase[]){
    const metric=phases[phase];
    if(metric&&fields.every(key=>typeof metric[key]==='number'&&Number.isFinite(metric[key])&&metric[key]>=0))result.phases[phase]={duration_ms:metric.duration_ms,completed:metric.completed,failed:metric.failed,reported_model_attempts:metric.reported_model_attempts};
  }
  return result;
}
export function measuredPhase(key:string,phase?:string):MetricPhase|undefined {
  if(key==='planner')return 'planning';
  if(key.startsWith('context:'))return 'context';
  if(key.startsWith('llm:')&&phase&&Object.prototype.hasOwnProperty.call(PHASE_LABELS,phase))return phase as MetricPhase;
}
export function addMeasurement(value:unknown,phase:MetricPhase,duration:number,failed:boolean,attempts:number):ExecutionMetrics {
  const metrics=parseExecutionMetrics(value);
  const before=metrics.phases[phase]??{duration_ms:0,completed:0,failed:0,reported_model_attempts:0};
  metrics.phases[phase]={duration_ms:before.duration_ms+Math.max(0,Math.round(duration)),completed:before.completed+Number(!failed),failed:before.failed+Number(failed),reported_model_attempts:before.reported_model_attempts+attempts};
  return metrics;
}
type TaskSample={status:string;created_at:string;started_at?:string|null;completed_at?:string|null;progress?:{metrics?:unknown}|null};
export function summarizeTaskPerformance(rows:TaskSample[]){
  const phases:Partial<Record<MetricPhase,PhaseMetric>>={};const durations:number[]=[],queues:number[]=[];let measuredTasks=0;
  const completed=rows.filter(row=>row.status==='completed');
  for(const row of completed){
    const metrics=parseExecutionMetrics(row.progress?.metrics);
    if(!Object.keys(metrics.phases).length)continue;
    measuredTasks++;
    const created=Date.parse(row.created_at),started=Date.parse(row.started_at??''),ended=Date.parse(row.completed_at??'');
    if(Number.isFinite(created)&&Number.isFinite(ended)&&ended>=created)durations.push(ended-created);
    if(Number.isFinite(created)&&Number.isFinite(started)&&started>=created)queues.push(started-created);
    for(const phase of Object.keys(metrics.phases) as MetricPhase[]){
      const m=metrics.phases[phase]!;const total=phases[phase]??{duration_ms:0,completed:0,failed:0,reported_model_attempts:0};
      for(const key of fields)total[key]+=m[key];phases[phase]=total;
    }
  }
  durations.sort((a,b)=>a-b);
  const percentile=(p:number)=>durations.length?durations[Math.max(0,Math.ceil(durations.length*p)-1)]:null;
  return {sampled_completed:completed.length,measured_tasks:measuredTasks,latency_samples:durations.length,total_p50_ms:percentile(.5),total_p95_ms:percentile(.95),initial_queue_average_ms:queues.length?Math.round(queues.reduce((a,b)=>a+b,0)/queues.length):null,phases};
}
export type TaskPerformance = ReturnType<typeof summarizeTaskPerformance>;
