# Lead Hunter — AI Research Agent Brain — ملخص التغييرات

## الملفات المعدّلة/المضافة
- `supabase/functions/lead-hunter/researchAgent.ts` — إعادة كتابة كاملة: حلقة PLAN→SEARCH→ANALYZE→VERIFY→REVIEW/STOP حقيقية تستدعي AI في كل جولة.
- `supabase/functions/lead-hunter/connectors/serper.ts` **[جديد]** — Connector بحث حقيقي (Serper.dev): search_web + fetch_public_page.
- `supabase/functions/lead-hunter/index.ts` — ربط الـConnector، قراءة مفاتيح المصادر من `lead_source_secrets`، الاتصال الفعلي بـ`ai-gateway`، كتابة كل النتائج الخام في `lead_source_records` (Candidate Ledger)، حفظ `strategy_notes`.
- `supabase/functions/ai-gateway/index.ts` — Intent جديد `research_agent_reasoning` (4 خطوات: plan_round / extract_candidates / verify_candidate / round_review)، ومسار مصادقة إضافي (additive) لـService Role يسمح للـbackground job بالاتصال بدون جلسة مستخدم.
- `supabase/migrations/20260819120000_0029_lead_hunter_research_agent_brain.sql` **[جديد]** — عمود إضافي واحد فقط: `lead_search_jobs.strategy_notes`.

## لم يتم تعديله
Publishing, Scheduler, Inbox, Analytics, Authentication, Workspace, RLS، وباقي intents الـAI Gateway — كل التغيير إضافي (additive)، لا حذف ولا كسر.

## قبل التشغيل الفعلي
1. طبّق migration رقم 0029 على قاعدة البيانات.
2. Deploy لـ`lead-hunter` و`ai-gateway` edge functions.
3. من شاشة Lead Hunter Admin → Sources: أضف مصدرًا جديدًا بـ connector_key = `serper_search` وألصق مفتاح Serper API الخاص بك، وفعّله.
4. بدون خطوة 3: النظام يتوقف بأمانة عند `NOT_CONFIGURED` — صفر نتائج مزيفة.

## نقاط لم تُختبر فعليًا (تحتاج بيئة بشبكة حقيقية)
- استدعاء Serper API فعليًا (لم يُختبر لعدم وجود شبكة في بيئة التطوير الحالية ولا مفتاح API بعد).
- زمن استجابة/تكلفة AI الفعلية لكل خطوة استدلال ضمن حدود `max_runtime_seconds` الحالية (900 ثانية افتراضيًا).
- أوصي بتشغيل أول Search Job حقيقي ومراقبة `lead_search_jobs.strategy_notes` و`lead_source_records` مباشرة بعد الإضافة، وتعديل الـPrompts في `AGENTS.research_researcher` إذا لزم ضبط دقيق بعد أول نتائج حقيقية.

## Phase 1 stabilisation — 2026-09-28

Scope: fix / complete / unify / stabilise only. No new features, no Phase 2.

- **Security (ai-gateway):** `agentContext.workspaceId/userId` from the client no longer override the authorized values (cross-workspace read/write via service-role executors). Approved tool calls are validated (known tool, ≤20, well-formed).
- **Router:** circuit breaker no longer sets `status='disabled'` (it excluded models permanently and made the cooldown unreachable); exhausted fallback chain reports the real per-provider errors (`AllModelsFailedError`, still HTTP 503); `allow_paid_fallback=false` now really excludes paid models; skipped providers are logged. Migration `0034` repairs models already stuck in `disabled`.
- **AI observability:** agent requests (plan/tools/approved calls) are recorded in `ai_runs` with tokens, cost, fallback log (per-request `AsyncLocalStorage` accumulator).
- **Agent tools:** `create_schedule`, `reschedule`, `cancel_schedule`, `publish`, `retry_failed_publish` implemented on top of the existing RPCs / `social-publish` (run with the caller's JWT). New RPC `cancel_calendar_item` (migration `0035`). `read_brand_dna` now reads the row instead of asking the LLM to invent one; `enforce_brand_rules` implemented (deterministic forbidden-phrase check). Unknown tools hallucinated by the planner are dropped.
- **Publishing:** media attached via `media_id` is now actually published (Telegram photo/video, Facebook photo, Instagram JPEG); X/LinkedIn/video fail explicitly instead of posting without the media. `social-publish` applies the same quality/rejected gate as `approve_content_variant`. Same change applied in both `social-publish` and `scheduler-tick` (kept identical by design).
- **Config:** `supabase/config.toml` declares `verify_jwt=false` for `scheduler-tick`, `inbox-webhook`, `social-linkedin-webhook` (they authenticate internally).
- **UI:** ContentScreen reloads content/calendar/variants after approved agent actions and shows every failed step.
