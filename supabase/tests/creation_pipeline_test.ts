import { runAgentTurn } from '../functions/ai-gateway/agent/pipeline.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { AgentRequest } from '../functions/ai-gateway/agent/types.ts';
import { creationDefaults } from '../functions/_shared/creation-policy.ts';

Deno.test('weekly draft executes the real tool bridge without asking or calling an AI planner',async()=>{
 const req:AgentRequest=creationDefaults({message:'اعمل حملة أسبوع',context:{workspaceId:'workspace',userId:'user',currentRoute:'create'}},['facebook'],new Date('2026-10-04T12:00:00Z'));
 let calls=0;
 const db={from:()=>{throw new Error('unexpected planner/database read');}} as unknown as SupabaseClient;
 const result=await runAgentTurn(db,req,async(intent,message,platforms,context)=>{
  calls++;
  if(intent!=='create_content_plan'||message!==req.message||platforms[0]!=='facebook'||context.post_count!==7)throw new Error('wrong creation tool inputs');
  return {result:{theme:'Campaign',slots:[]},tokensIn:0,tokensOut:0};
 });
 if(calls!==1||result.clarifyingQuestion||result.pendingApproval||!result.toolResults[0].ok)throw new Error('creation blocked');
 if(!result.toolResults[0].output?.creation_assumptions)throw new Error('defaults not disclosed');
});
