import { buildPostText } from '../functions/_shared/published-text.ts';
Deno.test('publishing preserves the complete reviewed text, CTA and hashtags',()=>{
 const text=buildPostText({text:'  سؤال واضح؟  ',cta:'شارك رأيك',hashtags:['#تأمين','#تخطيط']});
 if(text!=='سؤال واضح؟\n\nشارك رأيك\n\n#تأمين #تخطيط')throw Error('approved text changed');
 if(buildPostText({text:'قصير'},5)!=='قصير')throw Error('valid text rejected');
});
Deno.test('oversized body or complete metadata cannot be silently truncated',()=>{
 for(const [variant,limit] of [[{text:'ن'.repeat(281)},280],[{text:'ن'.repeat(1025)},1024],[{text:'ن'.repeat(4097)},4096],[{text:'ن'.repeat(3001)},3000],[{text:'ن'.repeat(270),cta:'شارك رأيك في التعليقات',hashtags:['#تأمين']},280]] as const){
  let rejected=false;
  try{buildPostText(variant,limit);}catch(error){rejected=error instanceof Error&&error.message.includes('لم يتم قص النص أو إرساله');}
  if(!rejected)throw Error('oversized approved copy was cut');
 }
});
