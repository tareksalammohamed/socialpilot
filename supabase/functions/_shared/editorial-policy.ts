export function editorialRules(message: string, memory: string): string {
  const otherLanguage = /english|french|بالإنجليزي|بالانجليزي|بالفصحى|فصحى|بالفرنسي/i.test(message);
  return `قواعد التحرير الملزمة:
${otherLanguage ? 'التزم باللغة أو اللهجة التي طلبها المستخدم صراحة.' : 'اكتب باللهجة المصرية المهنية الطبيعية: مش، إزاي، عشان، ده، دي، خلّي. تجنب الفصحى المتكلفة والخليجي مثل وش، مو، هذي. لا تحشر كلمات مصرية بلا داعي.'}
تصحيح المستخدم الحالي مقدم على تفضيلات الذاكرة القديمة. استخدم العبارات المفضلة طبيعيًا، وتجنب الممنوعة.
ممنوع اختراع تجربة شخصية أو قصة عميل أو نتائج رقمية أو إحصاءات أو خدمات يقدمها صاحب البراند. صيغة «حصل معايا» ليست دليلًا على صحة قصة. استخدم نصائح عملية أو مثالًا افتراضيًا واضحًا بلا نتائج مزعومة. احذف الادعاء غير الموثق بدل اختراع دليل له. لا تحول مسودات سابقة أو ملاحظات المراجع إلى حقائق موثقة.
لا تضف وعدًا بجلسة تدريب أو رابط أو عرض لم يذكره المستخدم. لا تخلط النص بكلمات أجنبية عشوائية.
تعلم الأسلوب من التصحيحات التالية دون اعتبار النصوص المولدة أدلة واقعية: ${memory}`;
}

export function cleanGeneratedText(text: string): string { return text.replace(/\\n/g, '\n').trim(); }

/** Conservative publication gate, independent of a model's optimistic score. */
export function enforceEditorialReview(review: Record<string, unknown>, post: {title:string;content:string;cta?:string}, source: string, rules: string): Record<string, unknown> {
  const text=[post.title,post.content,post.cta??''].join(' ');
  const issues:string[]=[];
  if(rules.includes('اكتب باللهجة المصرية')&&[...text].some(char=>/\p{Letter}/u.test(char)&&!/[\p{Script=Arabic}\p{Script=Latin}]/u.test(char)))issues.push('احذف الكلمات المكتوبة بأبجدية غير عربية وأعد صياغتها بالمصري؛ النص يحتوي لغة غير مطلوبة.');
  const stories=/(?:قصة حقيقية|حدثت معي|حصل(?:ت)? معايا|كنت (?:أعمل|بشتغل|أجلس|قاعد)|(?:فريق|فرق|عميل|وكيل).{0,20}(?:عملت معه|دربته|اشتغلت معاه)|قبل سنوات|غيّرت (?:النهج|الهيكل|طريقة|الأولوية))/gu;
  if([...text.matchAll(stories)].some(m=>!source.includes(m[0]))) issues.push('احذف التجربة الشخصية غير الموثقة أو حوّلها لمثال افتراضي صريح؛ لا تنسبها لصاحب البراند.');
  const figures=text.match(/[0-9٠-٩]+(?:[.,٫][0-9٠-٩]+)?\s*(?:%|٪|بالمية|في المئة|ألف|مليون|ريال|جنيه|دولار)/g)??[];
  if(figures.some(n=>!source.includes(n))) issues.push('احذف الأرقام والنتائج المالية أو النسب غير الواردة في مصدر المستخدم.');
  if(/جلسة تدريب|جلسه تدريب|تواصل معي مباشرة|تواصل معايا.*(?:خدمة|خدمه|عرض)/u.test(text)&&!/جلسة تدريب|جلسه تدريب|خدمة|خدمه|عرض/u.test(source)) issues.push('لا تعرض خدمة أو جلسة تدريب لم يؤكدها المستخدم.');
  if(rules.includes('اكتب باللهجة المصرية')&&/(?:^|\s)(?:وش|مو|هذي|تبغى|شلون)(?:\s|$)|(?:سوف|ينبغي|حصراً|يتعين عليك)/u.test(text)) issues.push('أعد الصياغة بالمصري المهني الطبيعي حسب طلب المستخدم.');
  if(rules.includes('اكتب باللهجة المصرية')) {
    if(!/(?:^|\s|[،؟.!])(?:مش|إزاي|ازاي|عشان|ده|دي|كده|خلّي|خلي|إيه|ايه|اللي|ليك|ليه|معاك|محتاج|تقدر|بتقدر)(?:\s|[،؟.!]|$)/u.test(text))issues.push('النص محتاج إعادة صياغة بالمصري الطبيعي؛ استخدم تعبيرات مصرية مناسبة للمعنى بدون حشو.');
    const allowed=new Set(['linkedin','instagram','facebook','whatsapp','socialpilot','crm','cta','b2b','api']);
    if((text.match(/[A-Za-z][A-Za-z-]{2,}/g)??[]).some(word=>!allowed.has(word.toLowerCase())&&!source.toLowerCase().includes(word.toLowerCase())))issues.push('استبدل الكلمات الأجنبية الدخيلة بتعبيرات مصرية واضحة.');
  }
  if(!issues.length)return review;
  return {...review,verdict:'review',scores:{...(review.scores as Record<string,number>),overall:Math.min(60,Number((review.scores as Record<string,number>)?.overall??0))},reasons:[...(review.reasons as string[]??[]),...issues],suggested_improvements:[...(review.suggested_improvements as string[]??[]),...issues]};
}
