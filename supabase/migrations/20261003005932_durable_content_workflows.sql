-- The browser submits work; cron owns execution, leases and recovery.
ALTER TABLE public.assistant_tasks
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS task_kind text NOT NULL DEFAULT 'create',
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS checkpoint jsonb,
  ADD COLUMN IF NOT EXISTS ai_steps jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.assistant_tasks DROP CONSTRAINT IF EXISTS assistant_tasks_status_check;
ALTER TABLE public.assistant_tasks ADD CONSTRAINT assistant_tasks_status_check CHECK(status IN ('queued','running','completed','failed'));
ALTER TABLE public.assistant_tasks ALTER COLUMN status SET DEFAULT 'queued';
CREATE INDEX IF NOT EXISTS assistant_tasks_pending ON public.assistant_tasks(available_at,created_at) WHERE status IN ('queued','running');
-- Clients cannot forge results, worker leases or another user's work.
REVOKE INSERT, UPDATE ON public.assistant_tasks FROM authenticated;
DROP POLICY IF EXISTS assistant_tasks_insert_own ON public.assistant_tasks;
DROP POLICY IF EXISTS assistant_tasks_update_own ON public.assistant_tasks;

CREATE OR REPLACE FUNCTION public.enqueue_assistant_task(p_workspace_id uuid,p_kind text,p_payload jsonb,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR public.user_workspace_role(p_workspace_id) IS NULL THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 IF p_kind NOT IN ('create','agent','approved','rpc','publish') OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text)>100000 THEN RAISE EXCEPTION 'invalid_task'; END IF;
 IF p_kind IN ('create','agent') AND length(trim(p_payload->>'message')) IS NOT DISTINCT FROM 0 THEN RAISE EXCEPTION 'message_required'; END IF;
 IF p_kind IN ('create','agent') AND p_payload->>'message' IS NULL THEN RAISE EXCEPTION 'message_required'; END IF;
 IF p_kind='rpc' AND COALESCE(p_payload->>'rpc','') NOT IN ('approve_content_variant','reschedule_calendar_item','cancel_calendar_item') THEN RAISE EXCEPTION 'invalid_rpc'; END IF;
 IF p_kind='approved' AND (jsonb_typeof(p_payload->'toolCalls') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'toolCalls') NOT BETWEEN 1 AND 20) THEN RAISE EXCEPTION 'invalid_tools'; END IF;
 INSERT INTO public.assistant_tasks(id,workspace_id,user_id,request_text,status,task_kind,payload,legacy_context)
 VALUES(p_request_id,p_workspace_id,auth.uid(),COALESCE(p_payload->>'message',p_kind),'queued',p_kind,p_payload,COALESCE(p_payload->'legacyContext','{}'))
 ON CONFLICT(id) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN
  SELECT id INTO v_id FROM public.assistant_tasks WHERE id=p_request_id AND user_id=auth.uid() AND workspace_id=p_workspace_id AND task_kind=p_kind AND payload=p_payload;
  IF v_id IS NULL THEN RAISE EXCEPTION 'request_id_conflict'; END IF;
 END IF;
 RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_assistant_task(uuid,text,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.enqueue_assistant_task(uuid,text,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_assistant_task(p_worker_id text,p_task_id uuid DEFAULT NULL)
RETURNS SETOF public.assistant_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE public.assistant_tasks SET status='failed',error='انتهت محاولات الاستعادة؛ راجع المهمة قبل إعادة التشغيل',locked_at=NULL,worker_id=NULL
 WHERE status IN ('queued','running') AND (attempt_count>=max_attempts OR (status='running' AND task_kind IN ('publish','approved'))) AND (locked_at IS NULL OR locked_at<now()-interval '10 minutes');
 RETURN QUERY UPDATE public.assistant_tasks t SET status='running',attempt_count=t.attempt_count+1,locked_at=now(),worker_id=p_worker_id,started_at=COALESCE(t.started_at,now())
 WHERE t.id=(SELECT id FROM public.assistant_tasks WHERE (p_task_id IS NULL OR id=p_task_id) AND attempt_count<max_attempts AND available_at<=now()
 AND (status='queued' OR (status='running' AND (locked_at IS NULL OR locked_at<now()-interval '10 minutes')))
 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING t.*;
END $$;
REVOKE ALL ON FUNCTION public.claim_assistant_task(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_assistant_task(text,uuid) TO service_role;

-- Impersonation is confined to this service-only, leased-task boundary. No JWT
-- or refresh token is persisted. Membership is rechecked at execution time.
CREATE OR REPLACE FUNCTION public.run_assistant_task_rpc(p_task_id uuid,p_worker_id text,p_rpc text,p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t public.assistant_tasks; r jsonb;
BEGIN
 SELECT * INTO t FROM public.assistant_tasks WHERE id=p_task_id AND worker_id=p_worker_id AND status='running' AND locked_at>now()-interval '10 minutes' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'lease_lost'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=t.workspace_id AND user_id=t.user_id) THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 IF (p_args->>'p_workspace_id')::uuid IS DISTINCT FROM t.workspace_id THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 PERFORM set_config('request.jwt.claim.sub',t.user_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',t.user_id,'role','authenticated')::text,true);
 CASE p_rpc
 WHEN 'approve_content_variant' THEN
  IF NOT EXISTS(SELECT 1 FROM public.content_variants WHERE id=(p_args->>'p_variant_id')::uuid AND workspace_id=t.workspace_id AND status<>'rejected') THEN RAISE EXCEPTION 'variant_not_found'; END IF;
  SELECT public.approve_content_variant(t.workspace_id,(p_args->>'p_variant_id')::uuid,(p_args->>'p_scheduled_for')::timestamptz) INTO r;
 WHEN 'schedule_content_variant' THEN SELECT public.schedule_content_variant(t.workspace_id,(p_args->>'p_variant_id')::uuid,(p_args->>'p_scheduled_for')::timestamptz) INTO r;
 WHEN 'reschedule_calendar_item' THEN SELECT public.reschedule_calendar_item(t.workspace_id,(p_args->>'p_calendar_item_id')::uuid,(p_args->>'p_scheduled_for')::timestamptz) INTO r;
 WHEN 'cancel_calendar_item' THEN SELECT public.cancel_calendar_item(t.workspace_id,(p_args->>'p_calendar_item_id')::uuid) INTO r;
 ELSE RAISE EXCEPTION 'invalid_rpc';
 END CASE;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.run_assistant_task_rpc(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.run_assistant_task_rpc(uuid,text,text,jsonb) TO service_role;

-- All generated rows and final task state commit together. A failed save rolls
-- back completely; a retry reuses the AI checkpoint without generating again.
CREATE OR REPLACE FUNCTION public.complete_assistant_task(p_task_id uuid,p_worker_id text,p_turn jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t public.assistant_tasks; tool jsonb; v_result jsonb; kind text; slot jsonb; v jsonb; q jsonb; cid uuid; vid uuid; bid uuid; when_at timestamptz; qs text; score integer; dates jsonb; idx integer:=0;
BEGIN
 SELECT * INTO t FROM public.assistant_tasks WHERE id=p_task_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found'; END IF;
 IF t.status='completed' THEN RETURN; END IF;
 IF t.worker_id IS DISTINCT FROM p_worker_id OR t.status<>'running' OR t.locked_at IS NULL OR t.locked_at<now()-interval '10 minutes' THEN RAISE EXCEPTION 'lease_lost'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=t.workspace_id AND user_id=t.user_id) THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 kind:='advice'; v_result:=p_turn;
 IF t.task_kind='create' THEN
  IF p_turn->>'clarifyingQuestion' IS NOT NULL THEN kind:='clarification'; v_result:=jsonb_build_object('text',p_turn->>'clarifyingQuestion');
  ELSE
   SELECT value INTO tool FROM jsonb_array_elements(p_turn->'toolResults') WHERE (value->>'ok')::boolean AND value->'output' IS NOT NULL LIMIT 1;
   IF tool IS NULL THEN
    IF p_turn->'pendingApproval' IS NOT NULL THEN kind:='clarification'; v_result:=jsonb_build_object('text',p_turn->'pendingApproval'->>'reason');
    ELSE RAISE EXCEPTION 'agent_execution_failed: %',p_turn->'toolResults'; END IF;
   END IF;
   IF tool IS NOT NULL THEN v_result:=tool->'output'; END IF;
   IF tool->>'name'='create_content' THEN kind:='content';
   ELSIF tool->>'name'='create_content_plan' THEN kind:='plan'; END IF;
  END IF;
 END IF;
 IF kind='plan' AND (jsonb_typeof(v_result->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(v_result->'slots')=0) THEN RAISE EXCEPTION 'empty_plan'; END IF;
 IF kind IN ('content','plan') THEN
  IF kind='plan' THEN bid:=gen_random_uuid(); END IF;
  dates:=COALESCE(t.legacy_context->'schedule'->'dates','[]');
  FOR slot IN SELECT value FROM jsonb_array_elements(CASE WHEN kind='plan' THEN v_result->'slots' ELSE jsonb_build_array(v_result) END) LOOP
   q:=slot->'quality'; qs:=CASE q->>'verdict' WHEN 'pass' THEN 'passed' WHEN 'fail' THEN 'failed' WHEN 'review' THEN 'needs_improvement' ELSE 'pending' END;
   SELECT round(avg(value::numeric)) INTO score FROM jsonb_each_text(COALESCE(NULLIF(q->'scores','null'),'{}')) WHERE value ~ '^[0-9]+(\.[0-9]+)?$';
   when_at:=CASE WHEN kind='plan' THEN (slot->>'date')::date+time '09:00' ELSE NULL END AT TIME ZONE 'UTC';
   INSERT INTO public.content(workspace_id,batch_id,title,goal,topic,audience,master_text,platforms,status,quality_score,quality_status,scheduled_at)
   VALUES(t.workspace_id,bid,slot->>'title',COALESCE(slot->>'goal',v_result->>'theme'),COALESCE(slot->>'topic',v_result->>'theme'),slot->>'audience',COALESCE(slot->>'master_text',slot->>'content',slot->>'title'),
    CASE WHEN kind='plan' THEN jsonb_build_array(slot->>'platform') ELSE slot->'platforms' END,'draft',score,qs,when_at) RETURNING id INTO cid;
   FOR v IN SELECT value FROM jsonb_array_elements(CASE WHEN kind='plan' THEN jsonb_build_array(jsonb_build_object('platform',slot->>'platform','text',COALESCE(slot->>'content',slot->>'title'),'hashtags',slot->'hashtags','cta',slot->'cta')) ELSE slot->'variants' END) LOOP
    IF kind='content' AND jsonb_array_length(dates)>0 THEN when_at:=((dates->>LEAST(idx,jsonb_array_length(dates)-1))::date+time '09:00') AT TIME ZONE 'UTC'; END IF;
    INSERT INTO public.content_variants(content_id,workspace_id,platform,text,hashtags,cta,media_brief,status,quality_score,quality_status,scheduled_at)
    VALUES(cid,t.workspace_id,v->>'platform',v->>'text',ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(v->'hashtags','null'),'[]'))),v->>'cta',COALESCE(NULLIF(v->'media_brief','null'),'{}'),'review',score,qs,when_at) RETURNING id INTO vid;
    IF q IS NOT NULL AND q<>'null'::jsonb THEN
     INSERT INTO public.quality_reviews(variant_id,workspace_id,verdict,scores,reasons,fixes_applied)
     VALUES(vid,t.workspace_id,q->>'verdict',q->'scores',COALESCE(NULLIF(q->'reasons','null'),'[]')||COALESCE(NULLIF(q->'suggested_improvements','null'),'[]'),0);
    END IF;
    IF when_at IS NOT NULL THEN
     PERFORM public.run_assistant_task_rpc(t.id,p_worker_id,CASE WHEN qs='passed' THEN 'approve_content_variant' ELSE 'schedule_content_variant' END,jsonb_build_object('p_workspace_id',t.workspace_id,'p_variant_id',vid,'p_scheduled_for',when_at));
     IF qs<>'passed' THEN UPDATE public.content SET status='review' WHERE id=cid; END IF;
    END IF;
    idx:=idx+1;
   END LOOP;
  END LOOP;
 END IF;
 UPDATE public.assistant_tasks SET status=CASE WHEN t.task_kind='approved' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_turn->'toolResults') WHERE NOT (value->>'ok')::boolean) THEN 'failed' ELSE 'completed' END,result_type=kind,result=v_result,content_id=CASE WHEN kind='content' THEN cid ELSE NULL END,batch_id=bid,completed_at=now(),locked_at=NULL,worker_id=NULL,error=CASE WHEN t.task_kind='approved' THEN (SELECT string_agg(value->>'error',' | ') FROM jsonb_array_elements(p_turn->'toolResults') WHERE NOT (value->>'ok')::boolean) ELSE NULL END WHERE id=t.id;
END $$;
REVOKE ALL ON FUNCTION public.complete_assistant_task(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_assistant_task(uuid,text,jsonb) TO service_role;

-- Reuse the existing Vault-backed scheduler credential; no secret in git.
SELECT cron.schedule('assistant-worker-every-minute','* * * * *', $cron$
 SELECT net.http_post(url:='https://iqbuedqugkpxqdrzhfzn.supabase.co/functions/v1/assistant-worker',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='socialpilot_scheduler_cron_secret' LIMIT 1)),body:='{}'::jsonb,timeout_milliseconds:=1000);
$cron$);
