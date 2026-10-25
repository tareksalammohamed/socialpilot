const {build}=require('esbuild');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const projectRoot=resolve(__dirname,'../..');
const scratch=mkdtempSync(join(tmpdir(),'socialpilot-ui-'));
process.on('exit',()=>rmSync(scratch,{recursive:true,force:true}));
(async()=>{
 const {Window}=await import('happy-dom');
 const window=new Window({url:'http://localhost/app/inbox'});
 for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Event','MouseEvent','MutationObserver','requestAnimationFrame','cancelAnimationFrame','localStorage','history','location'])global[key]=key==='window'?window:typeof window[key]==='function'&&['requestAnimationFrame','cancelAnimationFrame'].includes(key)?window[key].bind(window):window[key];
 global.IS_REACT_ACT_ENVIRONMENT=true;
 await build({entryPoints:[__dirname+'/entry.jsx'],outfile:join(scratch,'bundle.cjs'),nodePaths:[projectRoot+'/node_modules'],bundle:true,format:'cjs',platform:'node',jsx:'automatic',alias:{'@':projectRoot+'/src'},define:{'import.meta.env.VITE_SUPABASE_URL':'"http://qa"','import.meta.env.VITE_SUPABASE_ANON_KEY':'"qa"'},plugins:[{name:'mock-db',setup(b){b.onResolve({filter:/lib\/supabase$|^\.\/supabase$/},()=>({path:__dirname+'/supabase.js'}))}}]});
 const qa=require(join(scratch,'bundle.cjs'));
 const root=qa.createRoot(document.body.appendChild(document.createElement('div')));
 const settle=()=>qa.act(()=>new Promise(resolve=>setTimeout(resolve,100)));
 await qa.act(async()=>root.render(qa.React.createElement(qa.App)));await settle();await settle();
 function input(){return document.querySelector('input[placeholder="اكتب ردًا..."]')}
 function clickText(text){const button=[...document.querySelectorAll('button')].find(el=>el.textContent.includes(text));assert.ok(button,'button '+text);button.click()}
 assert.ok(input(),document.body.textContent);
 assert.ok(document.body.textContent.includes('WhatsApp Web متصل عبر مزود الربط'));
 let query=qa.calls.find(c=>c.table==='inbox_messages');assert.ok(query.args.some(a=>a[0]==='order'&&a[1]==='created_at'&&a[2].ascending===false));
 assert.ok(document.body.textContent.indexOf('رسالة أقدم')<document.body.textContent.indexOf('أحدث رسالة'));
 function write(text){Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input(),text);input().dispatchEvent(new window.Event('input',{bubbles:true}));input().dispatchEvent(new window.Event('change',{bubbles:true}));}
 await qa.act(async()=>write('مسودة العميل الأول'));assert.equal(input().value,'مسودة العميل الأول');
 await qa.act(async()=>clickText('عميل 2'));await settle();assert.equal(input().value,'');
 await qa.act(async()=>write('مسودة العميل الثاني'));
 await qa.act(async()=>clickText('عميل 1'));await settle();assert.equal(input().value,'مسودة العميل الأول');
 const count=qa.calls.filter(c=>c.table==='workspace_members').length;
 await qa.act(async()=>qa.emit('TOKEN_REFRESHED',{...qa.session,user:{...qa.session.user}}));await settle();
 assert.equal(qa.calls.filter(c=>c.table==='workspace_members').length,count);assert.equal(input().value,'مسودة العميل الأول');
 console.log('PASS latest messages, WAHA/WPPConnect UI, scoped drafts, auth refresh preserves workspace and input');
 await qa.act(async()=>root.unmount());
 qa.setDnaError(true);const root2=qa.createRoot(document.body.appendChild(document.createElement('div')));
 await qa.act(async()=>root2.render(qa.React.createElement(qa.App)));await settle();
 assert.ok(document.body.textContent.includes('تعذّر تحميل بيانات علامتك التجارية'));
 qa.setDnaError(false);await qa.act(async()=>clickText('إعادة المحاولة'));await settle();assert.ok(input());
 console.log('PASS failed Brand DNA read presents retry and recovers into app');
 await qa.act(async()=>root2.unmount());
 qa.enableAutoAnalyze();
 let analyses = 0;
 global.fetch = async (url) => {
   assert.ok(String(url).endsWith('/inbox-ai'), 'Unexpected external request: ' + url);
   analyses++;
   // A real asynchronous response must survive the effect's loading transition.
   await new Promise(resolve => setTimeout(resolve, 30));
   return Response.json({ analysis: {
     id: 'analysis', conversation_id: 'a', summary: 'تحليل المحادثة مكتمل',
     source_message_ids: ['latest'], suggested_reply: 'أهلاً بحضرتك', quality_reasons: [],
     quality_verdict: 'pass', reply_status: 'pending', next_best_action: 'رد على العميل',
   } });
 };
 const root3 = qa.createRoot(document.body.appendChild(document.createElement('div')));
 await qa.act(async()=>root3.render(qa.React.createElement(qa.App)));await settle();await settle();
 assert.equal(analyses, 1);
 assert.ok(document.body.textContent.includes('تحليل المحادثة مكتمل'));
 assert.ok(![...document.querySelectorAll('button')].find(button=>button.textContent.includes('تحليل AI')).disabled);
 console.log('PASS automatic AI analysis survives its loading state and completes once');
 await qa.act(async()=>root3.unmount());await window.happyDOM.abort();
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
