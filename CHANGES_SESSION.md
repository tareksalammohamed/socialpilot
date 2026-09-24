# SocialPilot V2 — Rebuild Progress (Phases 1-6)

## حالة النشر الفعلية (آخر تحديث)
- ✅ Migration الميديا (`0033_media_system.sql`) **مُطبّقة فعليًا** على `iqbuedqugkpxqdrzhfzn`
- ✅ Customer Center / Lead Hunter **اتشالت بالكامل من الداتا بيز الحية** (28 جدول)، وأكدت إن البيانات كانت شبه فاضية قبل الحذف
- ✅ `ai-gateway` edge function **منشورة فعليًا** على المشروع الحي (version 35) — بنيتها فوق الكود الحي الحقيقي بعد ما اكتشفت إن نسخة الـzip كانت متأخرة عنه (فيها `web_search` capability و`onBehalfOfUserId` مش موجودين عندي محليًا)
- ✅ `lead-hunter` و`lead-hunter-admin` تم استبدالهم بـstub بيرجّع 410 بدل ما يفشلوا على جداول محذوفة — **لسه موجودين في قائمة الـfunctions** (معنديش أداة حذف فعلي، تقدر تشيلهم بنفسك من الـDashboard لو عايز)
- ⏳ **الفرونت‑إند (هذا الكود) لسه مش منشور** — التعديلات في `CreateScreen.tsx`/`ContentScreen.tsx`/إلخ موجودة في الملفات بس محتاجة نشر يدوي منك (أو Claude Code)

## قبل ما تشغّل حاجة محليًا
- محتاج `npm install` عادي (عندي هنا كان فيه حظر شبكة بس، مش مشكلة عندك)
- متغيرات البيئة (`.env`) متلمستش خالص

## ملفات جديدة (لأول مرة)
### Backend — Universal AI Agent (`supabase/functions/ai-gateway/agent/`)
- `types.ts` — العقد الأساسي (Request/Context/Plan/ToolCall/ToolResult)
- `tools.ts` — Tool Registry (35 أداة)
- `pipeline.ts` — الـorchestration (Planning → Tool Selection → Execution → Approval)
- `executors.ts` — الموزّع الرئيسي
- `executors-content.ts` — تعديل محتوى موجود (rewrite/hook/cta/hashtags/translate/adapt)
- `executors-brand.ts` — Brand Memory (قراءة/تسجيل pattern)
- `executors-accounts.ts` — قراءة حسابات السوشيال المتصلة
- `executors-media.ts` — media brief + image prompt (نصي بحت)
- `executors-media-link.ts` — ربط/فك ربط ميديا بمنشور
- `executors-campaign.ts` — بناء حملة كاملة (يعيد استخدام create_content_plan)
- `executors-analytics.ts` — compare_platforms/detect_trends/analyze_content/recommend_next_content (مبنيين على `post_insights` الحقيقي)

### Frontend
- `src/components/PlatformPreview.tsx` — معاينة شكل البوست قبل الموافقة

### Database
- `supabase/migrations/20260921000000_0033_media_system.sql` — جدول `media` + storage bucket + RLS + عمود `content_variants.media_id`

## ملفات معدّلة (موجودة أصلاً، لمستها)
- `supabase/functions/ai-gateway/index.ts` — أضفت مسار `agentMode` جنب الـintent القديم (القديم متلمسش)
- `src/lib/types.ts` — أنواع الـAgent + `ContentVariant.media_id` + `MediaItem`
- `src/lib/api.ts` — `callAgentTurn()`, `callApprovedTools()`
- `src/screens/CreateScreen.tsx` — بقت بتستخدم الـAgent الجديد بدل الـregex المحلي (نفس منطق الحفظ/الجدولة زي ما هو)
- `src/screens/ContentScreen.tsx` — تعديل بالـAI لكل variant + رفع/حذف صورة + معاينة + كارد الموافقة

## اللي اتفحص فعليًا (مش بس "المفروض شغال")
- Backend كامل: `tsc --strict` نظيف (صفر أخطاء) — كل الملفات مع بعض، مش ملف ملف
- سكريبت تحقق آلي: كل الـ35 أداة ليها handler واحد بالظبط، صفر تضارب
- Frontend: syntax-check لكل الملفات المعدّلة
- الـmigration: مراجعة يدوية سطر سطر مقابل الـconventions الموجودة فعلًا في مشروعك

## اللي لسه مش موجود (بصراحة)
- `create_schedule/reschedule/cancel_schedule/publish/retry_failed_publish` كأدوات Agent (بيستخدموا المنطق الموجود في `ContentScreen.tsx` مباشرة حاليًا)
- `analyze_media` (تحليل صور بالـvision) — محتاج تمديد حقيقي لطبقة الـproviders مقدرتش أعمله من غير ما أضمن شغله
- `upload_media`, `repurpose_content`, `enforce_brand_rules`
- Design system موحّد للـPlatform Preview (نسخة واحدة عامة دلوقتي، مش 5 تصاميم مطابقة لكل منصة)

## خطوات التجربة المقترحة
1. `npm install && npm run typecheck && npm run build`
2. راجع الـmigration، وطبّقها على مشروع Supabase تجريبي لو متاح قبل الحي
3. جرب `agentMode` من `CreateScreen` و`ContentScreen` (تعديل AI، رفع صورة، معاينة)
4. لما تكون مبسوط، نرجع نطبق الـmigration على `iqbuedqugkpxqdrzhfzn` (المشروع الحي) ونكمل الباقي
