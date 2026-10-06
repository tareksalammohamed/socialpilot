export function editorialRules(message: string, memory: string): string {
  const otherLanguage = /english|french|بالإنجليزي|بالانجليزي|بالفصحى|فصحى|بالفرنسي/i.test(message);
  return `قواعد التحرير الملزمة:
${otherLanguage ? 'التزم باللغة أو اللهجة التي طلبها المستخدم صراحة.' : 'اكتب باللهجة المصرية المهنية الطبيعية: مش، إزاي، عشان، ده، دي، خلّي. تجنب الفصحى المتكلفة والخليجي مثل وش، مو، هذي. لا تحشر كلمات مصرية بلا داعي.'}
تصحيح المستخدم الحالي مقدم على تفضيلات الذاكرة القديمة. استخدم العبارات المفضلة طبيعيًا، وتجنب الممنوعة.
القصص البيعية Sales Story مسموحة ومطلوبة عندما يطلبها المستخدم: قصة حقيقية بالتفاصيل التي قدمها المستخدم دون اختراع تفاصيل إضافية، أو قصة افتراضية تبدأ بوضوح «تخيل» أو «مثال افتراضي». حافظ على السرد والحوار والموقف والدرس البيعي؛ لا تحول كل قصة إلى قائمة نصائح. القصة الافتراضية ليست تجربة لصاحب البراند ولا شهادة عميل حقيقية.
ممنوع اختراع تجربة شخصية أو قصة عميل ونسبتها للحقيقة أو نتائج رقمية أو إحصاءات أو خدمات يقدمها صاحب البراند. صيغة «حصل معايا» ليست دليلًا على صحة قصة. احذف الادعاء غير الموثق بدل اختراع دليل له. لا تحول مسودات سابقة أو ملاحظات المراجع أو تفضيلات البراند إلى حقائق موثقة. الأرقام التوضيحية داخل مثال افتراضي مسموحة إذا كان واضحًا أنها افتراضات، ولا تثبت عائدًا أو تغطية أو ضمانًا لمنتج حقيقي.
لا تضف وعدًا بجلسة تدريب أو رابط أو عرض لم يذكره المستخدم. لا تخلط النص بكلمات أجنبية عشوائية.
تعلم الأسلوب من التصحيحات التالية دون اعتبار النصوص المولدة أدلة واقعية: ${memory}`;
}

export const EDITORIAL_CHECKS = ['spelling', 'grammar', 'dialect', 'request_fit', 'brand_voice', 'factual_support', 'story_integrity', 'safe_promises'] as const;

/** Missing/uncertain checks must never inherit an optimistic overall score. */
export function enforceEditorialChecklist(review: Record<string, unknown>): Record<string, unknown> {
  const checks = review.checks as Record<string, unknown> | undefined;
  const failed = EDITORIAL_CHECKS.filter(key => checks?.[key] !== true);
  if (!failed.length && Number((review.scores as Record<string, number>)?.overall ?? 0) >= 85) return review;
  const labels: Record<typeof EDITORIAL_CHECKS[number], string> = {
    spelling: 'الإملاء', grammar: 'النحو وتركيب الجمل', dialect: 'اللهجة المطلوبة', request_fit: 'تنفيذ الطلب',
    brand_voice: 'صوت البراند', factual_support: 'سند الادعاءات والأرقام', story_integrity: 'صدق القصة أو وضوح أنها افتراضية', safe_promises: 'سلامة الوعود والعروض',
  };
  const reason = failed.length ? `التدقيق لم يؤكد سلامة: ${failed.map(key => labels[key]).join('، ')}. أصلحها وأعد فحص النسخة كاملة؛ لا تمررها اعتمادًا على الدرجة العامة.` : 'درجة الجودة أقل من الحد التحريري المطلوب (85). أعد الصياغة لتحسين سلامة الجمل ووضوح المعنى قبل الاجتياز.';
  return { ...review, verdict: review.verdict === 'fail' ? 'fail' : 'review', scores: { ...(review.scores as Record<string, number>), overall: Math.min(60, Number((review.scores as Record<string, number>)?.overall ?? 0)) }, reasons: [...(review.reasons as string[] ?? []), reason], suggested_improvements: [...(review.suggested_improvements as string[] ?? []), reason] };
}

export function cleanGeneratedText(text: string): string { return text.replace(/\\n/g, '\n').trim(); }

/** Conservative publication gate, independent of a model's optimistic score. */
export function enforceEditorialReview(review: Record<string, unknown>, post: {title:string;content:string;cta?:string;hashtags?:string[]}, source: string, rules: string): Record<string, unknown> {
  const text=[post.title,post.content,post.cta??'',...(post.hashtags??[])].join(' ');
  const issues:string[]=[];
  if(rules.includes('اكتب باللهجة المصرية')&&[...text].some(char=>/\p{Letter}/u.test(char)&&!/[\p{Script=Arabic}\p{Script=Latin}]/u.test(char)))issues.push('احذف الكلمات المكتوبة بأبجدية غير عربية وأعد صياغتها بالمصري؛ النص يحتوي لغة غير مطلوبة.');
  const stories=/(?:قصة حقيقية|حدثت معي|حصل(?:ت)? معايا|كنت (?:أعمل|بشتغل|أجلس|قاعد)|(?:فريق|فرق|عميل|وكيل).{0,20}(?:عملت معه|دربته|اشتغلت معاه)|قبل سنوات|غيّرت (?:النهج|الهيكل|طريقة|الأولوية))/gu;
  if([...text.matchAll(stories)].some(m=>!source.includes(m[0]))) issues.push('احذف التجربة الشخصية غير الموثقة أو حوّلها لمثال افتراضي صريح؛ لا تنسبها لصاحب البراند.');
  const factualSentences=text.split(/[.!؟\n]/u).filter(sentence=>!/(?:تخيل|افترض|مثال افتراضي|على سبيل الافتراض)/u.test(sentence));
  const figures=factualSentences.join(' ').match(/[0-9٠-٩]+(?:[.,٫][0-9٠-٩]+)?\s*(?:%|٪|بالمية|في المئة|ألف|مليون|ريال|جنيه|دولار)/g)??[];
  if(figures.some(n=>!source.includes(n))) issues.push('احذف الأرقام والنتائج المالية أو النسب غير الواردة في مصدر المستخدم، أو اذكر افتراضها صراحة داخل الجملة التوضيحية دون ادعاء نتيجة حقيقية.');
  const coverage=/(?:البوليصة|البوليصه|الوثيقة|الوثيقه|الوثائق|المنتج|التأمين|التامين).{0,30}(?:بتغطي|بيغطي|تغطي|يغطي|بيضمن|بتضمن|يضمن|تضمن)/gu;
  if([...text.matchAll(coverage)].some(m=>!source.includes(m[0])&&!/(?:اسأل|اسال|راجع|اتأكد|اتاكّد|تحقق|هل|إيه|ايه|ما إذا).{0,45}$/u.test(text.slice(Math.max(0,m.index!-50),m.index))))issues.push('احذف تأكيد التغطية أو الضمان غير المسند لشروط منتج قدمها المستخدم. حتى في القصة الافتراضية، اذكر مراجعة الشروط والاستثناءات والملاءمة بدل تأكيد أن وثيقة غير محددة تغطي احتياج العميل.');
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
