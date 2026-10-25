export const calls=[];
export const session={user:{id:'user-1',email:'qa@example.test'},access_token:'qa-token'};
export let dnaError=false;
export function setDnaError(value){dnaError=value;}
let listener;
export function enableAutoAnalyze() { ws.settings = { inbox_ai: { enabled: true, autoAnalyze: true } }; }
const ws={id:'workspace-1',owner_id:'user-1',name:'QA',settings:{}};
export const conversations=['a','b'].map((id,i)=>({id,workspace_id:ws.id,platform:'whatsapp',type:'dm',sender_name:'عميل '+(i+1),status:'open',unread:false,metadata:{provider:i?'wppconnect':'waha'},updated_at:new Date().toISOString()}));
export const supabase={
 auth:{getSession:async()=>({data:{session}}),onAuthStateChange:fn=>{listener=fn;return {data:{subscription:{unsubscribe(){listener=null}}}}},signOut:async()=>{listener('SIGNED_OUT',null)}},
 async rpc(name){calls.push({table:name});return {data:name==='is_super_admin'?false:null,error:null}},
 from(table){let single=false;const query={};const args=[];
 for(const method of ['select','eq','order','limit','in','gte','update'])query[method]=(...a)=>{args.push([method,...a]);return query};
 query.maybeSingle=query.single=()=>{single=true;return query};
 query.then=(resolve,reject)=>{calls.push({table,args});let data;
 if(table==='workspace_members')data={workspace_id:ws.id};else if(table==='workspaces')data=ws;
 else if(table==='brand_dna')data=dnaError?null:{id:'dna',status:'approved'};
 else if(table==='inbox_conversations')data=conversations;
 else if(table==='inbox_messages')data=[{id:'latest',conversation_id:'a',direction:'inbound',content:'أحدث رسالة',created_at:'2026-10-24T10:00:00Z',metadata:{}},{id:'older',conversation_id:'a',direction:'inbound',content:'رسالة أقدم',created_at:'2026-10-20T10:00:00Z',metadata:{}}];
 else data=single?null:[];
 return Promise.resolve({data,error:table==='brand_dna'&&dnaError?{message:'offline'}:null,count:0}).then(resolve,reject)};return query;
 },
 channel(){const channel={on:()=>channel,subscribe:()=>channel};return channel},removeChannel:async()=>{},
};
export function emit(event,next=session){listener(event,next)}
