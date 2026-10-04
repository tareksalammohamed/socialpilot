type AiIntent = 'generate_brand_dna' | 'create_content' | 'create_content_plan' | 'analyze_performance' | 'suggest_ideas' | 'general_advice';

export type ParsedIntent = {
  intent: AiIntent;
  postCount: number;
  platforms: string[];
  startDate: string | null;
  endDate: string | null;
  frequency: 'once' | 'daily' | 'weekly' | 'custom';
  schedule: { dates: string[]; time: string | null };
  contentGoal: string | null;
  contentType: string | null;
};

export const DEFAULT_SCHEDULE_HOUR = 9; // single source of truth for the default publish hour

const PLATFORM_ALIASES: Record<string, string> = {
  facebook: 'facebook', فيسبوك: 'facebook',
  instagram: 'instagram', انستجرام: 'instagram', إنستجرام: 'instagram',
  linkedin: 'linkedin', 'لينكد ان': 'linkedin', 'لينكد إن': 'linkedin', لينكدإن: 'linkedin', لينكدان: 'linkedin', لينكد_إن: 'linkedin',
  x: 'x', تويتر: 'x', twitter: 'x',
  telegram: 'telegram', تيليجرام: 'telegram',
};

// Spelled-out Arabic numbers commonly used in requests ("خمس بوستات", "عشرة بوستات")
const ARABIC_NUMBER_WORDS: Record<string, number> = {
  واحدة: 1,
  اثنين: 2, اثنان: 2, ثنين: 2,
  ثلاثة: 3, تلاتة: 3, ثلاث: 3,
  أربعة: 4, اربعة: 4, أربع: 4, اربع: 4,
  خمسة: 5, خمس: 5,
  ستة: 6, ست: 6,
  سبعة: 7, سبع: 7,
  ثمانية: 8, ثمان: 8,
  تسعة: 9, تسع: 9,
  عشرة: 10, عشر: 10,
};

const GOAL_KEYWORDS: Record<string, string> = {
  'وعي|awareness|تعريف': 'brand_awareness',
  'مبيعات|بيع|sales|عرض': 'sales',
  'تفاعل|engagement': 'engagement',
  'تعليم|تثقيف|educational|معلومة': 'education',
  'إطلاق|اطلاق|launch': 'launch',
};

const TYPE_KEYWORDS: Record<string, string> = {
  'فيديو|video|ريلز|reel': 'video',
  'صورة|image|كاروسيل|carousel': 'image',
  'نص|text|مقال': 'text',
  'قصة|story|ستوري': 'story',
};

function numberFromArabic(value: string): number | null {
  const normalized = value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractNumber(text: string): number | null {
  const digitMatch = text.match(/([0-9٠-٩]+)\s*(?:بوست|بوستات|منشور|منشورات|posts?)/i);
  if (digitMatch) return numberFromArabic(digitMatch[1]);

  for (const [word, value] of Object.entries(ARABIC_NUMBER_WORDS)) {
    const re = new RegExp(`${word}\\s*(?:بوست|بوستات|منشور|منشورات)`);
    if (re.test(text)) return value;
  }
  return null;
}

function matchKeyword(text: string, table: Record<string, string>): string | null {
  for (const [pattern, value] of Object.entries(table)) {
    if (new RegExp(pattern).test(text)) return value;
  }
  return null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Spread `count` posts evenly across `spanDays` days (extra posts stack on later days). */
function spreadDates(start: Date, count: number, spanDays: number): string[] {
  const days = Math.max(1, spanDays);
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    const dayOffset = Math.floor((i * days) / count);
    dates.push(isoDate(addDays(start, dayOffset)));
  }
  return dates;
}

export function parseIntent(message: string, now = new Date(), timezone = 'Africa/Cairo'): ParsedIntent {
  const text = message.toLowerCase().replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

  const platforms = Object.entries(PLATFORM_ALIASES)
    .filter(([alias]) => /^[a-z]+$/.test(alias) ? new RegExp(`\\b${alias}\\b`).test(text) : text.includes(alias))
    .map(([, platform]) => platform)
    .filter((value, index, values) => values.indexOf(value) === index);

  const daily = /كل يوم|يوميًا|يوميا|daily/.test(text);
  const week = /أسبوع|اسبوع|week/.test(text);
  const month = /شهر|month/.test(text);
  const durationMatch = text.match(/(?:خلال|لمدة|لمده|for)\s*([0-9٠-٩]+)\s*(?:يوم|أيام|day|days|أسبوع|اسبوع|أسابيع|اسابيع|شهر|شهور|week|weeks|month|months)?/i);
  const duration = durationMatch ? numberFromArabic(durationMatch[1]) : null;
  const durationIsWeeks = durationMatch ? /أسبوع|اسبوع|أسابيع|اسابيع|week/.test(durationMatch[0]) : false;
  const durationIsMonths=durationMatch?/شهر|شهور|month/.test(durationMatch[0]):false;
  const distributed = /وزع|وزّع|distribute|spread/.test(text);
  const campaign = /حملة|حمله|campaign/.test(text);
  const hasScheduleSignal = campaign || daily || week || month || durationMatch !== null || distributed || /خطة|plan|جدول|schedule/.test(text);

  // post_count: explicit number > 1 wins; otherwise defaults to 1 (adjusted below for "daily" phrasing).
  const explicitCount = extractNumber(text);
  const postCount = explicitCount ?? 1;
  const isMultiPost = postCount > 1 || (daily && hasScheduleSignal);

  let intent: AiIntent = 'general_advice';
  if (/أداء|تحليل|analyze|performance|حلل/.test(text)) intent = 'analyze_performance';
  else if (/أفكار|اقترح|ideas|suggest/.test(text)) intent = 'suggest_ideas';
  else if (/بوست|منشور|اكتب|محتوى|post|write|content/.test(text)) {
    intent = isMultiPost || hasScheduleSignal ? 'create_content_plan' : 'create_content';
  } else if (hasScheduleSignal) intent = 'create_content_plan';

  // --- Scheduling window -----------------------------------------------
  const localToday = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  let start = addDays(new Date(`${localToday}T00:00:00Z`),1);
  const explicitDate=text.match(/(?:من|يوم|بداية|بدايه|بدء|starting|from|on)\s*(\d{4}-\d{2}-\d{2})/);
  if(explicitDate && Number.isFinite(Date.parse(explicitDate[1])))start=new Date(`${explicitDate[1]}T00:00:00Z`);
  else if(/اليوم|النهارده|today/.test(text))start=new Date(`${localToday}T00:00:00Z`);
  else if(/بكرة|بكره|غد|tomorrow/.test(text))start=addDays(new Date(`${localToday}T00:00:00Z`),1);
  if(!explicitDate&&!/اليوم|النهارده|today|بكرة|بكره|غد|tomorrow/.test(text)){
    const weekdays=[['الأحد','الاحد','sunday'],['الإثنين','الاثنين','الإتنين','الاتنين','monday'],['الثلاثاء','التلات','tuesday'],['الأربعاء','الاربعاء','wednesday'],['الخميس','thursday'],['الجمعة','الجمعه','friday'],['السبت','saturday']];
    const day=weekdays.findIndex(names=>names.some(name=>text.includes(name.toLowerCase())));
    if(day>=0){const today=new Date(`${localToday}T00:00:00Z`);const delta=(day-today.getUTCDay()+7)%7;start=addDays(today,delta||7);}
  }
  const timeMatch=text.match(/(?:الساعة|الساعه|ساعة|at)\s*(\d{1,2})(?::(\d{2}))?\s*(صباح(?:ا|ًا)?|مساء(?:ا|ً)?|ص|م|am|pm)?/);
  let hour=DEFAULT_SCHEDULE_HOUR,minute=0;
  if(timeMatch){hour=Number(timeMatch[1]);minute=Number(timeMatch[2]??0);if(/مساء|^م$|pm/.test(timeMatch[3]??'')&&hour<12)hour+=12;if(/صباح|^ص$|am/.test(timeMatch[3]??'')&&hour===12)hour=0; if(hour>23||minute>59)throw new Error('موعد النشر غير صحيح');}
  const time=`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  let spanDays: number;
  let count: number;

  if (daily && !explicitCount) {
    // "بوست كل يوم لمدة أسبوع" -> N posts, one per day, N = duration/week/month
    spanDays = duration ? duration * (durationIsWeeks ? 7 : durationIsMonths ? 30 : 1) : week ? 7 : month ? 30 : 7;
    count = spanDays;
  } else if (duration) {
    // "5 بوستات خلال 5 أيام"
    spanDays = duration * (durationIsWeeks ? 7 : durationIsMonths ? 30 : 1);
    count = explicitCount ?? spanDays;
  } else if (week || month) {
    // "10 بوستات ووزعهم على الأسبوع"
    spanDays = week ? 7 : 30;
    count = explicitCount ?? spanDays;
  } else {
    // No explicit window: one post per day starting today.
    spanDays = campaign && !explicitCount ? 7 : Math.max(postCount, 1);
    count = campaign && !explicitCount ? 7 : postCount;
  }

  const dates = intent === 'create_content_plan' ? spreadDates(start, count, spanDays) : [];
  const endDate = dates[dates.length - 1] ?? null;

  return {
    intent,
    postCount: intent === 'create_content_plan' ? count : 1,
    platforms,
    startDate: dates[0] ?? null,
    endDate,
    frequency: daily ? 'daily' : durationMatch || week || month ? 'custom' : 'once',
    schedule: { dates, time },
    contentGoal: matchKeyword(text, GOAL_KEYWORDS),
    contentType: matchKeyword(text, TYPE_KEYWORDS),
  };
}

export function classifyIntent(message: string): AiIntent {
  return parseIntent(message).intent;
}

/** Assigns one date to each of `count` posts, cycling the parsed schedule if needed. */
export function scheduleDates(parsed: ParsedIntent, count: number): string[] {
  if (parsed.schedule.dates.length === 0) return [];
  return Array.from({ length: count }, (_, index) => parsed.schedule.dates[Math.min(index, parsed.schedule.dates.length - 1)]);
}
