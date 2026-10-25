import { generateCampaign, type CampaignLLM } from '../functions/ai-gateway/campaign.ts';
const checks={spelling:true,grammar:true,dialect:true,request_fit:true,brand_voice:true,factual_support:true,story_integrity:true,safe_promises:true};
const agents={strategy_planner:()=>'',content_creator:()=>'',quality_engine:()=>''};
const dates=Array.from({length:7},(_,i)=>`2026-10-${String(i+4).padStart(2,'0')}`);
Deno.test('monthly generation and repair use bounded batches and preserve every date and metadata',async()=>{
 const generatedCounts:number[]=[],repairedCounts:number[]=[];
 const month=Array.from({length:30},(_,i)=>`2026-11-${String(i+1).padStart(2,'0')}`);
 const corrected=new Set<string>();
 const llm:CampaignLLM=async(_s,p,_j,validate,budget,excluded)=>{
  let value:unknown;
  if(p.includes('"reviews"')){
   const [post]=JSON.parse(p.split('المحتوى: ')[1]);
   value={reviews:[{verdict:corrected.has(post.title)?'pass':'review',checks,scores:{overall:corrected.has(post.title)?90:60},reasons:['راجع النص'],suggested_improvements:[]}]};
  }else if(p.includes('"posts"')){
   const work=JSON.parse(p.split('العناصر وملاحظاتها: ')[1]);
   repairedCounts.push(work.length);
   value={posts:work.map((s:{title:string;content:string;cta:string;hashtags:string[]})=>{
    if(s.cta!=='اسألنا' || s.hashtags[0]!=='#تأمين')throw Error('metadata omitted from rewrite');
    corrected.add(s.title);return {...s,content:s.content+' اسأل عن الشروط.'};
   })};
  }else{
   const skeletons=JSON.parse(p.split('فترة):\n')[1].split('\nعند')[0]);
   generatedCounts.push(skeletons.length);
   value={theme:'حملة شهرية',slots:skeletons.map((s:{date:string})=>({title:s.date,content:`العميل محتاج يفهم اختياراته عشان يقدر يسأل الأسئلة المناسبة قبل القرار. موعد الفكرة ${s.date}`,cta:'اسألنا',hashtags:['#تأمين']}))};
  }
  const content=JSON.stringify(value);if(!validate(content)||budget>8000)throw Error('invalid batch');
  return {content,model:p.includes('"reviews"')?(excluded?.includes('reviewer-a')?'reviewer-b':'reviewer-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اعمل حملة شهر',['facebook'],{post_count:30,schedule:{dates:month}},'','',llm,agents);
 if(generatedCounts.join(',')!=='8,8,8,6'||repairedCounts.join(',')!=='8,8,8,6')throw Error('campaign not batched');
 if(out.result.slots.length!==30||out.result.slots.some((s,i)=>s.date!==month[i]||s.quality.verdict!=='pass'||s.cta!=='اسألنا'))throw Error('month incomplete');
 if(out.tokensIn!==98||out.tokensOut!==98)throw Error('usage from batches lost');
});

Deno.test('English requests retain their requested language through real improvement and independent review',async()=>{
 let repaired=false;
 const llm:CampaignLLM=async(_s,p,_j,validate,_budget,excluded)=>{
  let value:unknown;
  const post={title:'Ask first',content:'Ask your client what matters most before recommending a suitable product. Explain the available terms clearly.',cta:'Ask a question',hashtags:['#Insurance']};
  if(p.includes('"reviews"'))value={reviews:[{verdict:repaired?'pass':'review',checks,scores:{overall:repaired?90:60},reasons:[],suggested_improvements:[]}]};
  else if(p.includes('"posts"')){
   if(p.includes('اكتب بالعربية الطبيعية')||!p.includes('اللغة التي طلبها المستخدم'))throw Error('rewrite forced Arabic');
   repaired=true;value={posts:[post]};
  }else {
   if(p.includes('نص عربي كامل')||!p.includes('اللغة التي طلبها المستخدم'))throw Error('generation forced Arabic');
   value={slots:[post]};
  }
  const content=JSON.stringify(value);if(!validate(content))throw Error('English rejected');
  return {content,model:p.includes('"reviews"')?(excluded?.includes('reviewer-a')?'reviewer-b':'reviewer-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اكتب بوست بالإنجليزية',['linkedin'],{post_count:1},'','',llm,agents);
 if(!repaired||out.result.slots[0].quality.verdict!=='pass')throw Error('English repair failed');
});
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
  }else if(p.includes('"posts"')){
   if(!excluded?.includes('reviewer-a')||!excluded?.includes('reviewer-b'))throw Error('critics can be consumed as rewrite authors');
   rewrites++;value={posts:[post]};
  }
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

Deno.test('rule preflight saves an unnecessary critic call but corrected text still needs both independent critics',async()=>{
 let repairs=0,critics=0,generations=0;
 const safe={title:'افهم العميل',content:'اسأل العميل إيه اللي محتاجه عشان تقدر تساعده يفهم الاختيارات قبل القرار.'};
 const llm:CampaignLLM=async(_s,p,_j,validate,_budget,excluded)=>{
  let result:unknown;
  if(p.includes('"reviews"')){critics++;if(!repairs)throw Error('critic called before obvious violation repaired');result={reviews:[{verdict:'pass',checks,scores:{overall:95},reasons:[],suggested_improvements:[]}]};}
  else if(p.includes('"posts"')){repairs++;result={posts:[safe]};}
  else{generations++;result={slots:[{...safe,content:'حققنا زيادة 70% في المبيعات عشان فهمنا احتياج العميل.'}]};}
  const content=JSON.stringify(result);if(!validate(content))throw Error('invalid response');
  return {content,model:p.includes('"reviews"')?(excluded?.includes('critic-a')?'critic-b':'critic-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اكتب بوست بالمصري',['linkedin'],{post_count:1},'','',llm,agents);
 if(generations!==1||repairs!==1||critics!==2||out.tokensIn!==4||out.result.slots[0].quality.verdict!=='pass')throw Error('preflight failed or independent review bypassed');
});
Deno.test('duplicate campaign bodies are rewritten and persistent duplicates cannot auto-pass',async()=>{
 for(const repairSucceeds of [true,false]){
  let repairs=0;
  const text='اسأل العميل إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته قبل القرار.';
  const llm:CampaignLLM=async(_s,p,_j,validate,_budget,excluded)=>{
   let result:unknown;
   if(p.includes('"reviews"'))result={reviews:[{verdict:'pass',checks,scores:{overall:95},reasons:[],suggested_improvements:[]}]};
   else if(p.includes('"posts"')){repairs++;const work=JSON.parse(p.split('العناصر وملاحظاتها: ')[1]);if(work.length!==1||!work[0].issues.some((x:string)=>x.includes('مكرر')))throw Error('duplicate repair scope wrong');result={posts:[{title:'الفكرة الثانية',content:repairSucceeds?'راجع الشروط مع العميل ووضح الاستثناءات عشان يقدر ياخد قرار يناسب احتياجه.':text}]};}
   else result={slots:[{title:'الأول',content:text},{title:'الثاني',content:text,cta:'اسأل دلوقتي'}]};
   const content=JSON.stringify(result);if(!validate(content))throw Error('invalid response');
   return {content,model:p.includes('"reviews"')?(excluded?.includes('critic-a')?'critic-b':'critic-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
  };
  const out=await generateCampaign('اعمل منشورين مختلفين بالمصري',['linkedin'],{post_count:2},'','',llm,agents);
  if(out.result.slots[0].quality.verdict!=='pass'||repairs!==(repairSucceeds?1:2))throw Error('wrong repair bounds');
  if((out.result.slots[1].quality.verdict==='pass')!==repairSucceeds)throw Error('duplicate publishable');
 }
});
Deno.test('single-post platform variants may share the same body without artificial rewrites',async()=>{
 let repairs=0;
 const post={title:'افهم العميل',content:'اسأل العميل إيه اللي محتاجه عشان تقدر تساعده يفهم اختياراته.'};
 const llm:CampaignLLM=async(_s,p,_j,_validate,_budget,excluded)=>{
  if(p.includes('"posts"'))repairs++;
  const value=p.includes('"reviews"')?{reviews:[{verdict:'pass',checks,scores:{overall:95},reasons:[],suggested_improvements:[]}]}:{slots:[post,post]};
  return {content:JSON.stringify(value),model:p.includes('"reviews"')?(excluded?.includes('critic-a')?'critic-b':'critic-a'):'author',provider:'test',tokensIn:1,tokensOut:1,fallbackCount:0,fallbackLog:[]};
 };
 const out=await generateCampaign('اكتب بوست بالمصري',['facebook','linkedin'],{post_count:2,single_content:true},'','',llm,agents);
 if(repairs||out.result.slots.some(s=>s.quality.verdict!=='pass'))throw Error('cross-platform variants rejected');
});
