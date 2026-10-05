import { editorialRules, enforceEditorialReview, cleanGeneratedText } from '../_shared/editorial-policy.ts';
import type { StepProgress } from '../_shared/durable-steps.ts';

import { parseStructured, validItems } from '../_shared/structured-output.ts';
export type CampaignLLMResult = { content: string; tokensIn: number; tokensOut: number; provider: string; model: string; fallbackCount: number; fallbackLog: Array<{provider:string;model:string;error:string}> };
export type CampaignLLM = (system: string, prompt: string, jsonMode: boolean, validate: (content:string)=>boolean, maxOutputTokens: number, excludedModelIds?: string[], progress?: StepProgress) => Promise<CampaignLLMResult>;
export async function generateCampaign(message:string, platforms:string[], runtimeContext:Record<string,unknown>, brandStr:string, memStr:string, runLLM:CampaignLLM, AGENTS: {strategy_planner:(brand:string,mem:string)=>string;content_creator:(brand:string,mem:string)=>string;quality_engine:()=>string}) {
      const scheduleDates = (runtimeContext.schedule as { dates?: string[] } | undefined)?.dates ?? [];
      const requestedCount = Math.max(1, Number(runtimeContext.post_count ?? scheduleDates.length) || scheduleDates.length || 1);
      const plats = platforms.length > 0 ? platforms : ['linkedin', 'facebook', 'instagram'];
      const today = new Date().toISOString().slice(0, 10);
      const slotDates = scheduleDates.length > 0
        ? Array.from({ length: requestedCount }, (_, i) => scheduleDates[Math.min(i, scheduleDates.length - 1)])
        : Array.from({ length: requestedCount }, () => today);
      const topicTail = message.match(/عن\s+([^\n]+)$/)?.[1] ?? '';
      const topics = topicTail.split(/\s+و(?:عن\s+)?/).map(t => t.trim()).filter(t => t.length >= 2 && t.length <= 80);
      const existing = runtimeContext.existing_slots as Array<Record<string, unknown>> | undefined;
      const rules = editorialRules(message, memStr);
      const skeletons = slotDates.map((date, i) => ({ date, platform: existing?.[i]?.platform ? String(existing[i].platform) : plats[i % plats.length], ...(topics.length > 1 ? { focus: topics[i % topics.length] } : {}) }));

      const arabicOnly = /[\p{Script=Arabic}]/u.test(message) && !/english|french|إنجليزي|انجليزي|بالإنجليزية|بالانجليزية|فرنسي/i.test(message);
      const sys = AGENTS.strategy_planner(brandStr, memStr);
      const prompt = `${rules}
${existing ? `عدّل هذه النصوص الموجودة حسب طلب المستخدم، حافظ على موضوع كل نص وهويته، ولا تنشئ حملة مختلفة: ${JSON.stringify(existing)}` : ""}
الطلب: "${message}"
اكتب محتوى فعلي كامل (وليس عنوانًا فقط) لكل فترة من الفترات التالية، بنفس الترتيب والعدد بالضبط (${skeletons.length} فترة):
${JSON.stringify(skeletons)}
عند وجود focus في الفترة، اجعله محور هذا المنشور تحديدًا؛ لا تدمج باقي المحاور فيه قسرًا.
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
      const r = await runLLM( sys, prompt, true, c => validItems(c, "slots", skeletons.length, false, arabicOnly), budget, [], { phase: 'generation', label: 'تأليف منشورات الحملة', detail: `كتابة ${skeletons.length} منشورات للمنصات المحددة` });
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
          content: cleanGeneratedText(String(s.content)),
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
      const authorModels = new Set([r.model]);

      const runQuality = async (items: Slot[], recheck = false): Promise<Record<string, unknown>[]> => {
        if (items.length === 0) return [];
        const reviews: Record<string, unknown>[] = [];
        for (let offset = 0; offset < items.length; offset += 1) {
        const batch = items.slice(offset, offset + 1);
        const qPrompt = `${rules}
أنت تراجع منشورًا واحدًا فقط ضمن حملة من ${slots.length} منشورات. لا تطلب منه احتواء بقية أيام الحملة ولا ترفضه لأنه منشور واحد. لا تطلب دمج المحاور المختلفة في كل منشور.
خريطة الحملة للاطلاع فقط: ${JSON.stringify(slots.map((s, i) => ({position:i+1, date:s.date, platform:s.platform, title:s.title})))}
الذاكرة والتصحيحات الملزمة: ${memStr}
طلب المستخدم الأصلي: ${message}
سياق العلامة والجمهور الذي يجب أن تقيس عليه الملاءمة: ${brandStr}
قيّم كل عنصر من عناصر المحتوى التالية وفق: Hook, Clarity, Brand Fit, Brand Voice, Platform Fit, Engagement Potential, CTA, Readability, Structure, Originality, Overall Score.
اكتب الأسباب والمقترحات بالعربية. الدرجات من 0 إلى 100 حصراً، وليس من 0 إلى 10. لا تعط pass إذا overall أقل من 70 أو النص بعيد عن الطلب أو يحتوي ادعاءات غير مدعومة.
أرجع كائن JSON فقط يحتوي reviews بنفس الترتيب والعدد (${batch.length} عنصر):
{"reviews": [{ "verdict": "pass|review|fail", "scores": { "hook": 0, "overall": 0 }, "reasons": [], "suggested_improvements": [] }]}
قيّم أيضًا فهم الطلب وتنوع المحاور؛ لا تقبل حملة تختزل كل المحاور في دمج مصطنع متكرر. تحقق من أي منتج أو تغطية أو علاقة سببية يدعيها النص ولا تمررها بدون سند من السياق. تحقق من ملاءمة العلامة ودقة الادعاءات، وارفض القصص أو الإحصاءات المختلقة والنص المختلط بلغات غير مطلوبة.
المحتوى: ${JSON.stringify(batch.map((s) => ({ platform: s.platform, title: s.title, content: s.content })))}`;
        const run = await runLLM( AGENTS.quality_engine(), qPrompt, true, c => validItems(c, "reviews", batch.length, true, arabicOnly), 2500, [...authorModels], { phase: 'quality', label: recheck ? 'إعادة مراجعة المنشورات المحسّنة' : 'مراجعة جودة منشورات الحملة', current: offset + 1, total: items.length });

        tokensIn += run.tokensIn; tokensOut += run.tokensOut;
        fallbackCount += run.fallbackCount; fallbackLog = [...fallbackLog, ...run.fallbackLog];
        if (!validItems(run.content, "reviews", batch.length, true, arabicOnly)) throw new Error("Incomplete campaign quality review");
        reviews.push(...(parseStructured(run.content) as { reviews: Record<string, unknown>[] }).reviews.map((q,i) => enforceEditorialReview(q, batch[i], message, rules)));
        }
        return reviews;
      };

      const qualities = await runQuality(slots);
      const MAX_IMPROVEMENT_ROUNDS = 2;
      for (let round = 0; round < MAX_IMPROVEMENT_ROUNDS; round++) {
        const needsWork = slots
          .map((slot, i) => ({ slot, i, q: qualities[i] as { verdict?: string; reasons?: string[]; suggested_improvements?: string[] } }))
          .filter(({ q }) => q?.verdict !== 'pass');
        if (needsWork.length === 0) break;

        const improvePrompt = `${rules}
المراجعة هنا لإعادة الكتابة فعليًا: أصلح كل ملاحظة وأرجع النص النهائي، لا تكتب تقريرًا أو خطة. كل عنصر منشور منفصل داخل حملة، لا تحوله لحملة جديدة ولا تضف عناوين اليوم الأول أو وعودًا بمنشورات مستقبلية.
الطلب الأصلي: ${message}
أعد كتابة الموضوع نفسه عند الحاجة لتحقيق الطلب، ولا تكتف بتلميع صياغة فكرة غير مناسبة. اكتب بالعربية الطبيعية بلا كلمات أجنبية دخيلة ولا تخترع تغطيات أو منتجات تأمين.
حسّن عناصر المحتوى التالية بناءً على ملاحظات الجودة، مع الحفاظ على المنصة والموضوع الأساسي لكل عنصر.
أرجع كائن JSON فقط يحتوي posts بنفس العدد والترتيب (${needsWork.length} عنصر): {"posts": [{ "title": "...", "content": "...", "hashtags": [], "cta": "..." }]}
العناصر وملاحظاتها: ${JSON.stringify(needsWork.map(({ slot, q }) => ({ platform: slot.platform, title: slot.title, content: slot.content, issues: q.reasons ?? [], suggestions: q.suggested_improvements ?? [] })))}`;
        const improveRun = await runLLM( AGENTS.content_creator(brandStr, memStr), improvePrompt, true, c => validItems(c, "posts", needsWork.length, false, arabicOnly), budget, [], { phase: 'improvement', label: 'تحسين المنشورات وفق ملاحظات الجودة', detail: `تحسين ${needsWork.length} منشورات` });
        authorModels.add(improveRun.model);

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
              content: cleanGeneratedText(String(upd.content ?? slots[i].content)),
              hashtags: Array.isArray(upd.hashtags) ? (upd.hashtags as string[]) : slots[i].hashtags,
              cta: upd.cta ? String(upd.cta) : slots[i].cta,
            };
          }
        });

        const recheck = await runQuality(needsWork.map(({ i }) => slots[i]), true);
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
