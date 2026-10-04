import { parseStructured, validItems } from '../_shared/structured-output.ts';
export type CampaignLLMResult = { content: string; tokensIn: number; tokensOut: number; provider: string; model: string; fallbackCount: number; fallbackLog: Array<{provider:string;model:string;error:string}> };
export type CampaignLLM = (system: string, prompt: string, jsonMode: boolean, validate: (content:string)=>boolean, maxOutputTokens: number) => Promise<CampaignLLMResult>;
export async function generateCampaign(message:string, platforms:string[], runtimeContext:Record<string,unknown>, brandStr:string, memStr:string, runLLM:CampaignLLM, AGENTS: {strategy_planner:(brand:string,mem:string)=>string;content_creator:(brand:string,mem:string)=>string;quality_engine:()=>string}) {
      const scheduleDates = (runtimeContext.schedule as { dates?: string[] } | undefined)?.dates ?? [];
      const requestedCount = Math.max(1, Number(runtimeContext.post_count ?? scheduleDates.length) || scheduleDates.length || 1);
      const plats = platforms.length > 0 ? platforms : ['linkedin', 'facebook', 'instagram'];
      const today = new Date().toISOString().slice(0, 10);
      const slotDates = scheduleDates.length > 0
        ? Array.from({ length: requestedCount }, (_, i) => scheduleDates[Math.min(i, scheduleDates.length - 1)])
        : Array.from({ length: requestedCount }, () => today);
      const skeletons = slotDates.map((date, i) => ({ date, platform: plats[i % plats.length] }));

      const arabicOnly = /[\p{Script=Arabic}]/u.test(message) && !/english|french|إنجليزي|انجليزي|بالإنجليزية|بالانجليزية|فرنسي/i.test(message);
      const sys = AGENTS.strategy_planner(brandStr, memStr);
      const prompt = `الطلب: "${message}"
اكتب محتوى فعلي كامل (وليس عنوانًا فقط) لكل فترة من الفترات التالية، بنفس الترتيب والعدد بالضبط (${skeletons.length} فترة):
${JSON.stringify(skeletons)}
بيانات الأداء السابقة التي يجب أن تؤثر على اختيار المحاور: ${JSON.stringify(runtimeContext.performance ?? {})}
هدف المحتوى (إن وُجد): ${runtimeContext.content_goal ?? 'غير محدد'}
أرجع JSON فقط بصيغة:
{
  "theme": "...",
  "slots": [
    { "date": "YYYY-MM-DD", "platform": "...", "title": "...", "content": "النص الكامل للمنشور", "goal": "...", "hashtags": ["..."], "cta": "..." }
  ]
}
كل "content" نص عربي كامل أصلي مخصص لمنصته، ولا تكرر نفس النص بين الفترات. افهم الموضوع في سياق خبرة صاحب العلامة وجمهوره. إذا طلب أكثر من محور، وزع المنشورات بينها ولا تختزلها كلها في دمج مصطنع واحد. عند ذكر التأمين والإدارة استخدم سياق عمل صاحب العلامة في المبيعات وقيادة الفرق؛ لا تفترض أنه يقصد تأمين الشركات أو إدارة حوادث العمل. لا تعد برابط أو خدمة غير متاحة في سياق العلامة. لا تخلط العربية بلغات غير مطلوبة. لا تخترع أرقامًا أو دراسات أو قصص عملاء أو وعود تغطية أو عوائد. أرجع JSON فقط.`;
      const budget = Math.min(16000, Math.max(4000, skeletons.length * 1000));
      const r = await runLLM( sys, prompt, true, c => validItems(c, "slots", skeletons.length, false, arabicOnly), budget);
      if (!validItems(r.content, "slots", skeletons.length, false, arabicOnly)) throw new Error("Incomplete campaign content");
      const parsed = parseStructured(r.content) as { theme?: string; slots: Array<Record<string, unknown>> };
      const rawSlots = Array.isArray(parsed.slots) ? parsed.slots : [];

      type Slot = { date: string; platform: string; title: string; content: string; goal?: string; content_type?: string; hashtags: string[]; cta?: string };
      const slots: Slot[] = skeletons.map((skeleton, i) => {
        const s = rawSlots[i];
        return {
          date: skeleton.date,
          platform: skeleton.platform,
          title: String(s.title),
          content: String(s.content),
          goal: s.goal ? String(s.goal) : (runtimeContext.content_goal as string | undefined),
          content_type: runtimeContext.content_type as string | undefined,
          hashtags: Array.isArray(s.hashtags) ? (s.hashtags as string[]) : [],
          cta: s.cta ? String(s.cta) : undefined,
        };
      });

      let tokensIn = r.tokensIn;
      let tokensOut = r.tokensOut;
      let fallbackCount = r.fallbackCount;
      let fallbackLog = r.fallbackLog;

      const runQuality = async (items: Slot[]): Promise<Record<string, unknown>[]> => {
        if (items.length === 0) return [];
        const qPrompt = `طلب المستخدم الأصلي: ${message}
سياق العلامة والجمهور الذي يجب أن تقيس عليه الملاءمة: ${brandStr}
قيّم كل عنصر من عناصر المحتوى التالية وفق: Hook, Clarity, Brand Fit, Brand Voice, Platform Fit, Engagement Potential, CTA, Readability, Structure, Originality, Overall Score.
أرجع كائن JSON فقط يحتوي reviews بنفس الترتيب والعدد (${items.length} عنصر):
{"reviews": [{ "verdict": "pass|review|fail", "scores": { "hook": 0, "overall": 0 }, "reasons": [], "suggested_improvements": [] }]}
قيّم أيضًا فهم الطلب وتنوع المحاور؛ لا تقبل حملة تختزل كل المحاور في دمج مصطنع متكرر. تحقق من أي منتج أو تغطية أو علاقة سببية يدعيها النص ولا تمررها بدون سند من السياق. تحقق من ملاءمة العلامة ودقة الادعاءات، وارفض القصص أو الإحصاءات المختلقة والنص المختلط بلغات غير مطلوبة.
المحتوى: ${JSON.stringify(items.map((s) => ({ platform: s.platform, title: s.title, content: s.content })))}`;
        const run = await runLLM( AGENTS.quality_engine(), qPrompt, true, c => validItems(c, "reviews", items.length, true), Math.max(4000, items.length * 500));
        tokensIn += run.tokensIn; tokensOut += run.tokensOut;
        fallbackCount += run.fallbackCount; fallbackLog = [...fallbackLog, ...run.fallbackLog];
        if (!validItems(run.content, "reviews", items.length, true)) throw new Error("Incomplete campaign quality review");
        return (parseStructured(run.content) as { reviews: Record<string, unknown>[] }).reviews;
      };

      const qualities = await runQuality(slots);
      const MAX_IMPROVEMENT_ROUNDS = 1;
      for (let round = 0; round < MAX_IMPROVEMENT_ROUNDS; round++) {
        const needsWork = slots
          .map((slot, i) => ({ slot, i, q: qualities[i] as { verdict?: string; reasons?: string[]; suggested_improvements?: string[] } }))
          .filter(({ q }) => q?.verdict !== 'pass');
        if (needsWork.length === 0) break;

        const improvePrompt = `الطلب الأصلي: ${message}
أعد كتابة الموضوع نفسه عند الحاجة لتحقيق الطلب، ولا تكتف بتلميع صياغة فكرة غير مناسبة. اكتب بالعربية الطبيعية بلا كلمات أجنبية دخيلة ولا تخترع تغطيات أو منتجات تأمين.
حسّن عناصر المحتوى التالية بناءً على ملاحظات الجودة، مع الحفاظ على المنصة والموضوع الأساسي لكل عنصر.
أرجع كائن JSON فقط يحتوي posts بنفس العدد والترتيب (${needsWork.length} عنصر): {"posts": [{ "title": "...", "content": "...", "hashtags": [], "cta": "..." }]}
العناصر وملاحظاتها: ${JSON.stringify(needsWork.map(({ slot, q }) => ({ platform: slot.platform, title: slot.title, content: slot.content, issues: q.reasons ?? [], suggestions: q.suggested_improvements ?? [] })))}`;
        const improveRun = await runLLM( AGENTS.content_creator(brandStr, memStr), improvePrompt, true, c => validItems(c, "posts", needsWork.length, false, arabicOnly), budget);
        tokensIn += improveRun.tokensIn; tokensOut += improveRun.tokensOut;
        fallbackCount += improveRun.fallbackCount; fallbackLog = [...fallbackLog, ...improveRun.fallbackLog];
        if (!validItems(improveRun.content, "posts", needsWork.length, false, arabicOnly)) throw new Error("Incomplete campaign improvements");
        const improved = (parseStructured(improveRun.content) as { posts: Record<string, unknown>[] }).posts;

        needsWork.forEach(({ i }, idx) => {
          const upd = Array.isArray(improved) ? improved[idx] : undefined;
          if (upd) {
            slots[i] = {
              ...slots[i],
              title: String(upd.title ?? slots[i].title),
              content: String(upd.content ?? slots[i].content),
              hashtags: Array.isArray(upd.hashtags) ? (upd.hashtags as string[]) : slots[i].hashtags,
              cta: upd.cta ? String(upd.cta) : slots[i].cta,
            };
          }
        });

        const recheck = await runQuality(needsWork.map(({ i }) => slots[i]));
        needsWork.forEach(({ i }, idx) => { qualities[i] = recheck[idx]; });
      }

      const finalSlots = slots.map((slot, i) => ({ ...slot, quality: qualities[i] }));

      return {
        result: { theme: String(parsed.theme ?? message), slots: finalSlots },
        tokensIn,
        tokensOut,
        meta: { provider: r.provider, model: r.model, fallbackCount, fallbackLog },
      };
}
