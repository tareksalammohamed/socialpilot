import { generateCampaign, type CampaignLLM } from '../functions/ai-gateway/campaign.ts';
const agents={strategy_planner:()=>'',content_creator:()=>'',quality_engine:()=>''};
const dates=Array.from({length:7},(_,i)=>`2026-10-${String(i+4).padStart(2,'0')}`);
Deno.test('whole weekly generation preserves real bodies through quality improvement and recheck',async()=>{
 let stage=0;
 const llm: CampaignLLM = async (_s,prompt,_j,validate,budget,excluded)=>{
  if(budget<=2000)throw new Error('campaign budget too small');
  const q=(verdict:string)=>({verdict,scores:{overall:verdict==='pass'?85:60},reasons:[],suggested_improvements:[]});
  const post=(i:number)=>({title:`التأمين وإدارة الفريق ${i}`,content:`محتوى عربي كامل مخصص لليوم ${i} يوضح أهمية فهم احتياجات العميل وتدريب الفريق على شرح شروط التأمين بوضوح.`});
  const responses=[{theme:'التأمين وإدارة الفريق',slots:dates.map((_,i)=>post(i))},{reviews:dates.map((_,i)=>q(i===2?'review':'pass'))},{posts:[{...post(2),content:'محتوى محسّن عملي يوضح كيف يدرب المدير فريقه على طرح أسئلة العميل قبل تقديم التأمين المناسب.'}]},{reviews:[q('pass')]}];
  if ((stage===1 || stage===3) && excluded?.[0]!=='test') throw new Error('review must use an independent model');
  if(stage===0&&(!prompt.includes('"focus":"التامين"')||!prompt.includes('"focus":"الادارة"')))throw new Error('requested topics were merged');
  const content=JSON.stringify(responses[stage++]);
  if(!validate(content))throw new Error('valid response rejected');
  if(stage===2&&(!prompt.includes('"reviews"')||!prompt.includes('brand')||!prompt.includes('انشئ حمله')))throw new Error('missing object envelope');
  return {content,tokensIn:10,tokensOut:100,provider:'test',model:'test',fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('انشئ حمله اسبوع يبدأ من انهارده عن التامين والادارة',['facebook','instagram','linkedin'],{post_count:7,schedule:{dates}},'brand','mem',llm,agents);
 if(stage!==4||out.result.slots.length!==7||out.result.slots.some((s,i)=>s.date!==dates[i]||!s.content||s.quality.verdict!=='pass'))throw new Error('incomplete campaign');
 if(!out.result.slots[2].content.startsWith('محتوى محسّن'))throw new Error('improvement lost');
});
Deno.test('an invalid durable cached generation is rejected before quality or persistence',async()=>{
 let calls=0;
 const llm:CampaignLLM=async()=>{calls++;return {content:'{"slots":[]}',tokensIn:0,tokensOut:0,provider:'test',model:'test',fallbackCount:0,fallbackLog:[]};};
 let failed=false;
 try {await generateCampaign('weekly',['facebook'],{post_count:7,schedule:{dates}},'','',llm,agents);} catch {failed=true;}
 if(!failed||calls!==1)throw new Error('invalid campaign accepted');
});
