import { editorialRules,enforceEditorialReview,cleanGeneratedText } from '../functions/_shared/editorial-policy.ts';
import { directEditorialPlan,exclusivePlatform } from '../functions/_shared/editorial-followup.ts';
const pass={verdict:'pass',scores:{overall:100},reasons:[],suggested_improvements:[]};
Deno.test('fabricated experiences and percentages override optimistic model scores',()=>{
 const post={title:'قصة حقيقية',content:'كنت أعمل مع فريق مبيعات وارتفع معدل إغلاقه بنسبة 40%.'};
 const q=enforceEditorialReview(pass,post,'اكتب بوست عن المبيعات',editorialRules('اكتب',''));
 if(q.verdict==='pass'||Number((q.scores as Record<string,number>).overall)>60)throw Error('fabrication approved');
 const supported=enforceEditorialReview(pass,post,post.title+' '+post.content,'');if(supported.verdict!=='pass')throw Error('user evidence ignored');
});
Deno.test('Egyptian preference is explicit and user language overrides defaults',()=>{
 if(!editorialRules('اكتب بوست','').includes('اكتب باللهجة المصرية'))throw Error('Egyptian default missing');
 if(editorialRules('اكتب بالفصحى','').includes('اكتب باللهجة المصرية'))throw Error('explicit language ignored');
 if(cleanGeneratedText('أول سطر\\nتاني سطر')!=='أول سطر\nتاني سطر')throw Error('escaped newline leaked');
});
Deno.test('existing campaign platform corrections execute directly without drafting or questions',()=>{
 const text='خليها لينكد ان بس وامسح نسخه انستقرام';
 if(exclusivePlatform(text)!=='linkedin')throw Error('Egyptian platform spelling missed');
 const plan=directEditorialPlan(text,{selectedCampaignId:'existing'});
 if(plan?.steps[0].tool!=='revise_existing_content'||plan.steps[0].input.onlyPlatform!=='linkedin'||plan.steps[0].input.batchId!=='existing')throw Error('existing campaign not targeted');
 if(directEditorialPlan('اعمل حملة جديدة', {selectedCampaignId:'existing'}))throw Error('new campaign treated as edit');
});
