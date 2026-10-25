import { addMeasurement,parseExecutionMetrics,summarizeTaskPerformance } from '../functions/_shared/execution-metrics.ts';
Deno.test('performance summary separates measured task latency, initial queue and leaf execution time',()=>{
 const metrics=addMeasurement(undefined,'generation',1200,false,2);
 const sample=(n:number)=>({status:'completed',created_at:'2026-10-25T00:00:00Z',started_at:'2026-10-25T00:00:01Z',completed_at:new Date(Date.parse('2026-10-25T00:00:00Z')+n*1000).toISOString(),progress:{metrics}});
 const result=summarizeTaskPerformance([sample(10),sample(20),sample(30),{...sample(40),progress:{}},{...sample(50),status:'running'}]);
 if(result.sampled_completed!==4||result.measured_tasks!==3||result.total_p50_ms!==20000||result.total_p95_ms!==30000||result.initial_queue_average_ms!==1000||result.phases.generation?.duration_ms!==3600)throw Error('wrong cohort or duration');
});
Deno.test('missing/invalid historical metrics remain unavailable rather than zero latency',()=>{
 const empty=summarizeTaskPerformance([{status:'completed',created_at:'bad',progress:{metrics:{version:2,phases:{}}}}]);
 if(empty.measured_tasks||empty.total_p50_ms!==null||empty.total_p95_ms!==null)throw Error('missing measurements shown as zero');
 const dirty={version:1,phases:{quality:{duration_ms:Infinity,completed:1,failed:0,reported_model_attempts:1},generation:{duration_ms:10,completed:1,failed:0,reported_model_attempts:1,secret:'do not copy'}}};
 const clean=parseExecutionMetrics(dirty);
 if(clean.phases.quality||JSON.stringify(clean).includes('secret'))throw Error('malformed metric or extra metadata escaped');
});
