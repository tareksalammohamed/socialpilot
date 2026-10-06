import { generateCampaign, type CampaignLLM } from '../functions/ai-gateway/campaign.ts';
const checks={spelling:true,grammar:true,dialect:true,request_fit:true,brand_voice:true,factual_support:true,story_integrity:true,safe_promises:true};
const agents={strategy_planner:()=>'',content_creator:()=>'',quality_engine:()=>''};
const dates=Array.from({length:7},(_,i)=>`2026-10-${String(i+4).padStart(2,'0')}`);
Deno.test('whole weekly generation preserves real bodies through quality improvement and recheck',async()=>{
 let stage=0, qualityCalls=0;
 const q=(verdict:string)=>({verdict,checks,scores:{overall:verdict==='pass'?85:60},reasons:[],suggested_improvements:[]});
 const post=(i:number)=>({title:`التأمين وإدارة الفريق ${i}`,content:`محتوى عربي كامل تقدر تستفيد منه ومخصص لليوم ${i} يوضح أهمية فهم احتياجات العميل وتدريب الفريق على شرح شروط التأمين بوضوح.`});
 const llm: CampaignLLM = async (_s,prompt,_j,validate,budget,excluded)=>{
  if(budget<2000)throw new Error('campaign budget too small');
  let response:unknown;
  if(prompt.includes('"reviews"')) {
   if(budget<6000)throw Error('review reasoning/output budget too small');
   qualityCalls++;
   if(!prompt.includes('لا تطلب منه احتواء بقية أيام الحملة')||excluded?.[0]!=='author'||!prompt.includes('brand')||!prompt.includes('انشئ حمله'))throw new Error('independent review context missing');
   const batch=JSON.parse(prompt.split('المحتوى: ')[1]) as {title:string;content:string}[];
   if(batch.length>1)throw new Error('quality batches are too large');
   response={reviews:batch.map(s=>q(s.title.endsWith('2')&&!s.content.startsWith('محتوى محسّن')?'review':'pass'))};
  }else if(prompt.includes('"posts"')){
   response={posts:[{...post(2),content:'محتوى محسّن عملي يوضح إزاي كيف يدرب المدير فريقه على طرح أسئلة العميل قبل تقديم التأمين المناسب.'}]};
  }else{
   if(!prompt.includes('"focus":"التامين"')||!prompt.includes('"focus":"الادارة"'))throw new Error('requested topics were merged');
   response={theme:'التأمين وإدارة الفريق',slots:dates.map((_,i)=>post(i))};
  }
  const content=JSON.stringify(response);stage++;
  if(!validate(content))throw new Error('valid response rejected');
  return {content,tokensIn:10,tokensOut:100,provider:'test',model:prompt.includes('"reviews"')?(excluded?.includes('reviewer-a')?'reviewer-b':'reviewer-a'):'author',fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('انشئ حمله اسبوع يبدأ من انهارده عن التامين والادارة',['facebook','instagram','linkedin'],{post_count:7,schedule:{dates}},'brand','mem',llm,agents);
 if(stage!==17||qualityCalls!==15||out.result.slots.length!==7||out.result.slots.some((s,i)=>s.date!==dates[i]||!s.content||s.quality.verdict!=='pass'))throw new Error('incomplete campaign');
 if(!out.result.slots[2].content.startsWith('محتوى محسّن'))throw new Error('improvement lost');
});
Deno.test('an invalid durable cached generation is rejected before quality or persistence',async()=>{
 let calls=0;
 const llm:CampaignLLM=async()=>{calls++;return {content:'{"slots":[]}',tokensIn:0,tokensOut:0,provider:'test',model:'test',fallbackCount:0,fallbackLog:[]};};
 let failed=false;
 try {await generateCampaign('weekly',['facebook'],{post_count:7,schedule:{dates}},'','',llm,agents);} catch {failed=true;}
 if(!failed||calls!==1)throw new Error('invalid campaign accepted');
});
Deno.test('optimistic reviews cannot pass fabricated results; rewriting repeats and retains the corrected body',async()=>{
 let improvements=0;
 const llm:CampaignLLM=async(_s,p,_j,validate,_budget,excluded)=>{
  let value:unknown;
  if(p.includes('"reviews"'))value={reviews:[{verdict:'pass',checks,scores:{overall:100},reasons:[],suggested_improvements:[]}]};
  else if(p.includes('"posts"')){improvements++;value={posts:[{title:'اسأل العميل',content:improvements===1?'حصلت معايا زيادة مبيعات 40% عشان كنت أعمل مع فريق محترف.':'اسأل العميل إيه أهم حاجة بالنسباله، وافهم احتياجه الأول عشان تقدر تشرحله الحل المناسب بوضوح.'}]};}
  else value={theme:'تأمين',slots:[{title:'قصة حقيقية',content:'حصلت معايا زيادة مبيعات 40% عشان كنت أعمل مع فريق محترف.'}]};
  const content=JSON.stringify(value);if(!validate(content))throw Error('invalid mock output');
  return {content,model:p.includes('"reviews"')?(excluded?.includes('reviewer-a')?'reviewer-b':'reviewer-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const result=await generateCampaign('اكتب بوست تأمين بالمصري',['linkedin'],{post_count:1},'','',llm,agents);
 if(improvements!==2||result.result.slots[0].quality.verdict!=='pass'||result.result.slots[0].content.includes('40%'))throw Error('unsafe final draft');
});

Deno.test('a failed spelling audit triggers real rewriting and an unsafe CTA can be removed',async()=>{
 let rewritten=false;
 const llm:CampaignLLM=async(_s,p,_j,validate,_budget,excluded)=>{
  let value:unknown;
  if(p.includes('"reviews"')) {
   if(!p.includes('hashtags')||!p.includes('cta'))throw Error('review omitted metadata');
   value={reviews:[{verdict:'pass',checks:{...checks,spelling:rewritten},scores:{overall:100},reasons:rewritten?[]:['صحح الإملاء'],suggested_improvements:[]}]};
  } else if(p.includes('"posts"')) {
   rewritten=true;
   value={posts:[{title:'اسأل الأول',content:'تخيل عميل محتار، اسأله إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته.',cta:'',hashtags:[]}]};
  } else value={theme:'قصة بيعية',slots:[{title:'اسأل الأول',content:'تخيل عميل محتار، اسأله إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته.',cta:'احجز جلسة تدريب'}]};
  const content=JSON.stringify(value);if(!validate(content))throw Error('invalid output');
  return {content,model:p.includes('"reviews"')?(excluded?.includes('reviewer-a')?'reviewer-b':'reviewer-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اكتب قصة بيعية بالمصري',['linkedin'],{post_count:1},'','',llm,agents);
 if(!rewritten||out.result.slots[0].cta!==''||out.result.slots[0].quality.verdict!=='pass')throw Error('correction not applied');
});

Deno.test('missing audit fields stay blocked after both automatic repair attempts',async()=>{
 let attempts=0;
 const llm:CampaignLLM=async(_s,p,_j,_validate,_budget,excluded)=>{
  const post={title:'اسأل الأول',content:'اسأل العميل إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته وشروط المنتج.'};
  let value:unknown;
  if(p.includes('"reviews"'))value={reviews:[{verdict:'pass',scores:{overall:100},reasons:[],suggested_improvements:[]}]};
  else if(p.includes('"posts"')){attempts++;value={posts:[post]};}
  else value={slots:[post]};
  return {content:JSON.stringify(value),model:p.includes('"reviews"')?(excluded?.includes('reviewer-a')?'reviewer-b':'reviewer-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اكتب بالمصري',['linkedin'],{post_count:1},'','',llm,agents);
 if(attempts!==2||out.result.slots[0].quality.verdict==='pass')throw Error('incomplete audit publishable');
});

Deno.test('a second independent critic can reject an optimistic first review and force rewriting',async()=>{
 let rewrites=0;
 const llm:CampaignLLM=async(_s,p,_j,validate,_budget,excluded)=>{
  const post={title:'اسأل الأول',content:'تخيل عميل محتار، اسأله إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته.'};
  let value:unknown;
  const second=excluded?.includes('reviewer-a');
  if(p.includes('"reviews"')){
   if(!excluded?.includes('author'))throw Error('author not excluded');
   value={reviews:[{verdict:'pass',checks:{...checks,grammar:!second||rewrites>0},scores:{overall:95},reasons:second&&!rewrites?['الجملة محتاجة ضبط المعنى']:[],suggested_improvements:[]}]};
  }else if(p.includes('"posts"')){rewrites++;value={posts:[post]};}
  else value={slots:[post]};
  const content=JSON.stringify(value);if(!validate(content))throw Error('invalid output');
  return {content,model:p.includes('"reviews"')?(second?'reviewer-b':'reviewer-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اكتب قصة بيعية بالمصري',['linkedin'],{post_count:1},'','',llm,agents);
 if(rewrites!==1||out.result.slots[0].quality.verdict!=='pass'||(out.result.slots[0].quality.review_models as string[]).length!==2)throw Error('critic bypassed');
});

Deno.test('a reviewer resolving back to an author cannot approve a draft',async()=>{
 const llm:CampaignLLM=async(_s,p)=>({content:JSON.stringify(p.includes('"reviews"')?{reviews:[{verdict:'pass',checks,scores:{overall:100},reasons:[],suggested_improvements:[]}]}:{slots:[{title:'اسأل الأول',content:'اسأل العميل إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته وشروط المنتج.'}]}),model:'same',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]});
 let failed=false;
 try{await generateCampaign('اكتب بالمصري',['linkedin'],{post_count:1},'','',llm,agents);}catch{failed=true;}
 if(!failed)throw Error('author approved itself');
});
