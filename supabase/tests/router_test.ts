import { routeAndRun, AllModelsFailedError } from '../functions/ai-gateway/router.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

function database(models: {provider_key:string;model_id:string;is_free:boolean;quality_score:number}[]): SupabaseClient {
  const providers=[...new Set(models.map(m=>m.provider_key))].map(provider_key=>({provider_key,enabled:true,priority:1,allow_paid:true,failover_enabled:true}));
  return {from:(table:string)=>{
    let single=false;
    const query:Record<string,unknown>={};
    for(const method of ['select','neq','eq','update'])query[method]=()=>query;
    query.maybeSingle=()=>{single=true;return query;};
    query.then=(resolve:(value:unknown)=>unknown)=>resolve({error:null,data:
      table==='ai_providers'?providers:
      table==='ai_provider_secrets'?{api_key:'test'}:
      table==='ai_routing_policy'?{policy:'best_quality',allow_paid_fallback:true}:
      single?{success_count:0,failure_count:0,consecutive_failures:0,avg_latency_ms:null}:
      models.map(m=>({...m,circuit_state:'closed',success_count:0,failure_count:0,structured_output:true,reasoning:true}))});
    return query;
  }} as unknown as SupabaseClient;
}

Deno.test('credit exhaustion skips remaining paid models but reaches another provider',async()=>{
  const saved=globalThis.fetch,attempts:string[]=[];
  globalThis.fetch=async(_url,init)=>{
    const model=JSON.parse(String(init?.body)).model;attempts.push(model);
    return model==='paid-a'?Response.json({error:{message:'requires more credits',code:402}},{status:402}):Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});
  };
  try{
    const db=database([{provider_key:'openrouter',model_id:'paid-a',is_free:false,quality_score:100},{provider_key:'openrouter',model_id:'paid-b',is_free:false,quality_score:99},{provider_key:'groq',model_id:'backup',is_free:true,quality_score:90}]);
    const result=await routeAndRun(db,{requiredCapabilities:['structured_output'],systemPrompt:'',userPrompt:'',jsonMode:true});
    if(result.providerUsed!=='groq'||result.fallbackCount!==1||attempts.join(',')!=='paid-a,backup')throw Error('402 stopped failover');
  }finally{globalThis.fetch=saved;}
});

Deno.test('credit exhaustion still permits free models from the same provider',async()=>{
  const saved=globalThis.fetch,attempts:string[]=[];
  globalThis.fetch=async(_url,init)=>{
    const model=JSON.parse(String(init?.body)).model;attempts.push(model);
    return model.startsWith('paid')?Response.json({error:{message:'requires more credits',code:402}},{status:402}):Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});
  };
  try{
    const db=database([{provider_key:'openrouter',model_id:'paid-a',is_free:false,quality_score:100},{provider_key:'openrouter',model_id:'paid-b',is_free:false,quality_score:99},{provider_key:'openrouter',model_id:'free-backup',is_free:true,quality_score:90}]);
    const result=await routeAndRun(db,{requiredCapabilities:['structured_output'],systemPrompt:'',userPrompt:'',jsonMode:true});
    if(result.modelUsed!=='free-backup'||attempts.join(',')!=='paid-a,free-backup')throw Error('free fallback skipped');
  }finally{globalThis.fetch=saved;}
});

Deno.test('all credit failures are reported as exhaustion with a readable cause',async()=>{
 const saved=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:{message:'requires more credits',code:402}},{status:402});
 try{
  let rejected=false;
  try {await routeAndRun(database([{provider_key:'openrouter',model_id:'paid',is_free:false,quality_score:100}]),{requiredCapabilities:['structured_output'],systemPrompt:'',userPrompt:'',jsonMode:true});}
  catch(error){rejected=error instanceof AllModelsFailedError && error.message.includes('رصيد المزود');}
  if(!rejected)throw Error('credit failure misclassified');
 }finally{globalThis.fetch=saved;}
});
