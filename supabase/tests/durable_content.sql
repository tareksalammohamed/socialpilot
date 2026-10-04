BEGIN;
INSERT INTO auth.users VALUES('10000000-0000-0000-0000-000000000001');
INSERT INTO public.workspaces VALUES('20000000-0000-0000-0000-000000000001');
INSERT INTO public.workspace_members VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','owner');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
DO $$
DECLARE tid uuid:=gen_random_uuid(); wid uuid:='20000000-0000-0000-0000-000000000001'; task public.assistant_tasks; turn jsonb; count_before integer; cid uuid; bid uuid;
BEGIN
 IF has_function_privilege('anon','public.claim_assistant_task(text,uuid)','EXECUTE') OR has_function_privilege('authenticated','public.claim_assistant_task(text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'worker_rpc_exposed'; END IF;
 IF has_table_privilege('authenticated','public.assistant_tasks','UPDATE') OR has_table_privilege('authenticated','public.assistant_tasks','INSERT') THEN RAISE EXCEPTION 'task_state_forgeable'; END IF;
 IF public.enqueue_assistant_task(wid,'create','{"message":"test"}',tid)<>tid THEN RAISE EXCEPTION 'enqueue_failed'; END IF;
 PERFORM public.enqueue_assistant_task(wid,'create','{"message":"test"}',tid);
 IF (SELECT count(*) FROM public.assistant_tasks WHERE id=tid)<>1 THEN RAISE EXCEPTION 'duplicate_enqueue'; END IF;
 BEGIN PERFORM public.enqueue_assistant_task(wid,'create','{"message":"different"}',tid); RAISE EXCEPTION 'conflicting_request_accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'request_id_conflict' THEN RAISE; END IF; END;
 SELECT * INTO task FROM public.claim_assistant_task('worker-one',tid);
 IF task.worker_id<>'worker-one' OR task.attempt_count<>1 THEN RAISE EXCEPTION 'claim_failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.claim_assistant_task('worker-two',tid)) THEN RAISE EXCEPTION 'double_claim'; END IF;
 turn:='{"toolResults":[{"ok":true,"name":"create_content","output":{"title":"Draft","master_text":"Body","platforms":["facebook"],"variants":[{"platform":"facebook","text":"Body","hashtags":[]}],"quality":{"verdict":"review","scores":{"hook":80},"reasons":["needs review"]}}}]}';
 BEGIN PERFORM public.complete_assistant_task(tid,'worker-two',turn); RAISE EXCEPTION 'stale_completion_accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'lease_lost' THEN RAISE; END IF; END;
 PERFORM public.complete_assistant_task(tid,'worker-one',turn);
 SELECT content_id INTO cid FROM public.assistant_tasks WHERE id=tid;
 IF cid IS NULL OR (SELECT quality_status FROM public.content WHERE id=cid)<>'needs_improvement' THEN RAISE EXCEPTION 'draft_not_saved'; END IF;
 SELECT count(*) INTO count_before FROM public.content;
 PERFORM public.complete_assistant_task(tid,'worker-one',turn);
 IF (SELECT count(*) FROM public.content)<>count_before THEN RAISE EXCEPTION 'duplicate_save'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.quality_reviews WHERE variant_id IN(SELECT id FROM public.content_variants WHERE content_id=cid) AND verdict='review') THEN RAISE EXCEPTION 'quality_not_saved'; END IF;
 -- Partial plan failure must leave no rows or falsely completed task.
 tid:=gen_random_uuid();PERFORM public.enqueue_assistant_task(wid,'create','{"message":"plan"}',tid);PERFORM public.claim_assistant_task('worker-plan',tid);
 turn:='{"toolResults":[{"ok":true,"name":"create_content_plan","output":{"theme":"Plan","slots":[{"date":"2027-01-01","platform":"facebook","title":"One","content":"Text","quality":{"verdict":"pass","scores":{"hook":90},"reasons":[]}},{"date":"bad date","platform":"facebook","title":"Two","content":"Text two","quality":{"verdict":"review","scores":{"hook":60},"reasons":[]}}]}}]}';
 BEGIN PERFORM public.complete_assistant_task(tid,'worker-plan',turn); RAISE EXCEPTION 'invalid_plan_accepted'; EXCEPTION WHEN invalid_datetime_format THEN NULL; END;
 IF (SELECT count(*) FROM public.content)<>count_before THEN RAISE EXCEPTION 'partial_plan_saved'; END IF;
 IF (SELECT status FROM public.assistant_tasks WHERE id=tid)<>'running' THEN RAISE EXCEPTION 'failed_transaction_completed_task'; END IF;
 turn:='{"toolResults":[{"ok":true,"name":"create_content_plan","output":{"theme":"Plan","slots":[{"date":"2027-01-01","platform":"facebook","title":"One","content":"Text","quality":{"verdict":"pass","scores":{"hook":90},"reasons":[]}},{"date":"2027-01-02","platform":"facebook","title":"Two","content":"Other","quality":{"verdict":"review","scores":{"hook":60},"reasons":[]}}]}}]}';
 PERFORM public.complete_assistant_task(tid,'worker-plan',turn);
 SELECT batch_id INTO bid FROM public.assistant_tasks WHERE id=tid;
 IF bid IS NULL OR (SELECT count(*) FROM public.content WHERE batch_id=bid)<>2 THEN RAISE EXCEPTION 'plan_not_saved'; END IF;
 IF (SELECT count(*) FROM public.publishing_jobs)<>1 OR (SELECT count(*) FROM public.calendar_items WHERE status='planned')<>1 THEN RAISE EXCEPTION 'quality_gate_bypassed'; END IF;
 -- Crashed drafting job is reclaimed and fenced; exhausted jobs terminate.
 tid:=gen_random_uuid(); PERFORM public.enqueue_assistant_task(wid,'agent','{"message":"edit"}',tid); PERFORM public.claim_assistant_task('old',tid);
 UPDATE public.assistant_tasks SET locked_at=now()-interval '11 minutes' WHERE id=tid;
 SELECT * INTO task FROM public.claim_assistant_task('new',tid);
 IF task.worker_id<>'new' OR task.attempt_count<>2 THEN RAISE EXCEPTION 'lease_not_recovered'; END IF;
 BEGIN PERFORM public.complete_assistant_task(tid,'old','{}'); RAISE EXCEPTION 'stale_worker_accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'lease_lost' THEN RAISE; END IF; END;
 UPDATE public.assistant_tasks SET locked_at=now()-interval '11 minutes',attempt_count=max_attempts WHERE id=tid;
 PERFORM public.claim_assistant_task('terminal',tid);
 IF (SELECT status FROM public.assistant_tasks WHERE id=tid)<>'failed' THEN RAISE EXCEPTION 'exhausted_job_stuck'; END IF;
 -- Unknown publish outcome must not be sent to the platform a second time.
 tid:=gen_random_uuid();PERFORM public.enqueue_assistant_task(wid,'publish','{}',tid);PERFORM public.claim_assistant_task('publisher',tid);
 UPDATE public.assistant_tasks SET locked_at=now()-interval '11 minutes' WHERE id=tid;
 IF EXISTS(SELECT 1 FROM public.claim_assistant_task('retry',tid)) THEN RAISE EXCEPTION 'ambiguous_publish_replayed'; END IF;
 IF (SELECT status FROM public.assistant_tasks WHERE id=tid)<>'failed' THEN RAISE EXCEPTION 'ambiguous_publish_stuck'; END IF;
 -- Rejecting an approval is persisted; no user can forge completion.
 tid:=gen_random_uuid();PERFORM public.enqueue_assistant_task(wid,'agent','{"message":"schedule","agentContext":{"currentVariantId":"30000000-0000-0000-0000-000000000001"}}',tid);PERFORM public.claim_assistant_task('pending',tid);
 PERFORM public.complete_assistant_task(tid,'pending','{"pendingApproval":{"reason":"Review first","toolCalls":[]}}');
 PERFORM public.dismiss_assistant_approval(wid,'30000000-0000-0000-0000-000000000001');
 IF (SELECT result ? 'pendingApproval' FROM public.assistant_tasks WHERE id=tid) THEN RAISE EXCEPTION 'rejected_approval_restored'; END IF;
 -- Revoked workspace access blocks committing work even with a valid lease.
 tid:=gen_random_uuid();PERFORM public.enqueue_assistant_task(wid,'agent','{"message":"edit"}',tid);PERFORM public.claim_assistant_task('revoked',tid);
 DELETE FROM public.workspace_members WHERE workspace_id=wid;
 BEGIN PERFORM public.complete_assistant_task(tid,'revoked','{}'); RAISE EXCEPTION 'revoked_access_accepted'; EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'workspace_access_denied' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
