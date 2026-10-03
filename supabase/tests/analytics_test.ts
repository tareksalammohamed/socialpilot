import { aggregateInsights, allPages, metricNumber, interactionCount, normalizeXMetrics, hourInZone, dateInZone, type Insight } from '../functions/_shared/analytics-math.ts';
function equal(actual:unknown,expected:unknown){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);}
function row(metric:string,value:number,overrides:Partial<Insight>={}):Insight{return {metric,value,platform:'facebook',external_post_id:'post',content_id:'content',variant_id:'variant',timestamp:'2026-09-20T22:00:00Z',published_at:'2026-09-20T22:00:00Z',fetched_at:'2026-10-01T00:00:00Z',...overrides};}
Deno.test('cumulative snapshots retain latest correction including zero, per platform',()=>{
 const result=aggregateInsights([row('comments',10),row('comments',0,{fetched_at:'2026-10-02T00:00:00Z'}),row('comments',3,{platform:'linkedin'})]);
 equal(result.readings,2);equal(result.totals.engagements,3);equal(result.posts.length,2);
});
Deno.test('aggregate interactions, reactions and likes never overlap; clicks and reach excluded',()=>{
 equal(interactionCount({total_interactions:8,likes:4,comments:2,shares:2,clicks:50,reach:1000}),8);
 equal(interactionCount({reactions:4,likes:3,comments:2,shares:1}),7);
 equal(interactionCount({engagements:0,likes:50}),0);
 equal(interactionCount({reach:1000,impressions:2000,clicks:50}),null);
});
Deno.test('missing data remains unavailable and zero remains measurable',()=>{
 for(const value of [null,undefined,'',true,{},-1,NaN,Infinity])equal(metricNumber(value),null);
 equal(metricNumber('0'),0);
 equal(normalizeXMetrics({like_count:0}),{likes:0});
 equal(normalizeXMetrics({retweet_count:4}),{});
 equal(normalizeXMetrics({retweet_count:4,quote_count:2}),{shares:6});
 const result=aggregateInsights([row('reach',20),row('likes',0,{external_post_id:'second'})]);
 equal(result.measuredPosts,1);equal(result.posts[0].engagement,null);equal(result.totals.engagements,0);
 equal(aggregateInsights([]).totals,{});
});
Deno.test('posting hour and date use Cairo publication time, not fetch time',()=>{
 const result=aggregateInsights([row('likes',5)]);
 equal(dateInZone(result.posts[0].publishedAt,'Africa/Cairo'),'2026-09-21');
 equal(hourInZone(result.posts[0].publishedAt,'Africa/Cairo'),'01:00');
});
Deno.test('reach cannot influence engagement ranking and account stock is not summed',()=>{
 const result=aggregateInsights([row('reach',100000),row('likes',1),row('followers',100),row('likes',4,{external_post_id:'second'}),row('followers',100,{external_post_id:'second'})]);
 equal(result.posts.filter(p=>p.engagement!==null).sort((a,b)=>b.engagement!-a.engagement!)[0].key,'facebook:second');
 equal(result.totals.followers,undefined);equal(result.totals.engagements,5);
});

Deno.test('pagination includes all counters beyond API page limit and rejects partial failures',async()=>{
 const source=Array.from({length:2001},(_,id)=>id);
 equal((await allPages<number>((from,to)=>Promise.resolve({data:source.slice(from,to+1),error:null}))).length,2001);
 let rejected=false;try{await allPages<number>((from,to)=>Promise.resolve(from?{data:null,error:{message:'denied'}}:{data:source.slice(from,to+1),error:null}));}catch{rejected=true;}
 equal(rejected,true);
});
