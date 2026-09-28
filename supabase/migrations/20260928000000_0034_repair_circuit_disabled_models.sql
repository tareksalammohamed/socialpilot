-- 0034: repair AI models permanently excluded by the old circuit breaker.
--
-- router.ts used to set ai_models.status = 'disabled' when the circuit
-- opened. loadCandidates() excludes status = 'disabled' before the cooldown
-- check runs, so such models were never retried. Nothing else in the project
-- writes 'disabled' (ai-admin never sets it), so every 'disabled' row was
-- produced by the breaker. Move them to 'degraded'; circuit_state/'open'
-- plus circuit_opened_at keep the cooldown, after which the model gets one
-- half-open attempt. Idempotent.
UPDATE public.ai_models
SET status = 'degraded'
WHERE status = 'disabled';
