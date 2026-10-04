-- Respect saved draft scheduling choices; historical tasks without a zone retain UTC.
CREATE OR REPLACE FUNCTION public.complete_assistant_task(p_task_id uuid,p_worker_id text,p_turn jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t public.assistant_tasks; tool jsonb; v_result jsonb; kind text; slot jsonb; v jsonb; q jsonb; cid uuid; vid uuid; bid uuid; when_at timestamptz; qs text; score integer; dates jsonb; idx integer:=0; publish_time time; publish_zone text;
BEGIN
 SELECT * INTO t FROM public.assistant_tasks WHERE id=p_task_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found'; END IF;
 IF t.status='completed' THEN RETURN; END IF;
 IF t.worker_id IS DISTINCT FROM p_worker_id OR t.status<>'running' OR t.locked_at IS NULL OR t.locked_at<now()-interval '10 minutes' THEN RAISE EXCEPTION 'lease_lost'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=t.workspace_id AND user_id=t.user_id) THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 publish_time:=COALESCE(NULLIF(t.payload#>>'{legacyContext,schedule,time}',''),'09:00')::time;
 publish_zone:=COALESCE(NULLIF(t.payload#>>'{legacyContext,timezone}',''),'UTC');
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=publish_zone) THEN RAISE EXCEPTION 'invalid_timezone'; END IF;
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
   IF kind='plan' AND (NULLIF(btrim(slot->>'content'),'') IS NULL OR NULLIF(btrim(slot->>'title'),'') IS NULL OR btrim(slot->>'content')=btrim(slot->>'title')) THEN RAISE EXCEPTION 'incomplete_plan_content'; END IF;
   IF kind='plan' AND (slot->'quality'->>'verdict' IS NULL OR slot->'quality'->>'verdict' NOT IN ('pass','review','fail') OR jsonb_typeof(slot->'quality'->'scores') IS DISTINCT FROM 'object' OR slot->'quality'->'scores'='{}'::jsonb) THEN RAISE EXCEPTION 'incomplete_plan_quality'; END IF;
   q:=slot->'quality'; qs:=CASE q->>'verdict' WHEN 'pass' THEN 'passed' WHEN 'fail' THEN 'failed' WHEN 'review' THEN 'needs_improvement' ELSE 'pending' END;
   SELECT round(avg(value::numeric)) INTO score FROM jsonb_each_text(COALESCE(NULLIF(q->'scores','null'),'{}')) WHERE value ~ '^[0-9]+(\.[0-9]+)?$';
   when_at:=CASE WHEN kind='plan' THEN (slot->>'date')::date+publish_time ELSE NULL END AT TIME ZONE publish_zone;
   INSERT INTO public.content(workspace_id,batch_id,title,goal,topic,audience,master_text,platforms,status,quality_score,quality_status,scheduled_at)
   VALUES(t.workspace_id,bid,slot->>'title',COALESCE(slot->>'goal',v_result->>'theme'),COALESCE(slot->>'topic',v_result->>'theme'),slot->>'audience',COALESCE(slot->>'master_text',slot->>'content',slot->>'title'),
    CASE WHEN kind='plan' THEN jsonb_build_array(slot->>'platform') ELSE slot->'platforms' END,'draft',score,qs,when_at) RETURNING id INTO cid;
   FOR v IN SELECT value FROM jsonb_array_elements(CASE WHEN kind='plan' THEN jsonb_build_array(jsonb_build_object('platform',slot->>'platform','text',COALESCE(slot->>'content',slot->>'title'),'hashtags',slot->'hashtags','cta',slot->'cta')) ELSE slot->'variants' END) LOOP
    IF kind='content' AND jsonb_array_length(dates)>0 THEN when_at:=((dates->>LEAST(idx,jsonb_array_length(dates)-1))::date+publish_time) AT TIME ZONE publish_zone; END IF;
    INSERT INTO public.content_variants(content_id,workspace_id,platform,text,hashtags,cta,media_brief,status,quality_score,quality_status,scheduled_at)
    VALUES(cid,t.workspace_id,v->>'platform',v->>'text',ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(v->'hashtags','null'),'[]'))),v->>'cta',COALESCE(NULLIF(v->'media_brief','null'),'{}'),'review',score,qs,when_at) RETURNING id INTO vid;
    IF q IS NOT NULL AND q<>'null'::jsonb THEN
     INSERT INTO public.quality_reviews(variant_id,workspace_id,verdict,scores,reasons,fixes_applied)
     VALUES(vid,t.workspace_id,q->>'verdict',q->'scores',COALESCE(NULLIF(q->'reasons','null'),'[]')||COALESCE(NULLIF(q->'suggested_improvements','null'),'[]'),0);
    END IF;
    IF when_at IS NOT NULL THEN
     PERFORM public.run_assistant_task_rpc(t.id,p_worker_id,CASE WHEN qs='passed' AND COALESCE(t.payload#>>'{legacyContext,draft_only}','false')<>'true' THEN 'approve_content_variant' ELSE 'schedule_content_variant' END,jsonb_build_object('p_workspace_id',t.workspace_id,'p_variant_id',vid,'p_scheduled_for',when_at));
     IF qs<>'passed' OR t.payload#>>'{legacyContext,draft_only}'='true' THEN UPDATE public.content SET status='review' WHERE id=cid; END IF;
    END IF;
    idx:=idx+1;
   END LOOP;
  END LOOP;
 END IF;
 UPDATE public.assistant_tasks SET status=CASE WHEN t.task_kind='approved' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_turn->'toolResults') WHERE NOT (value->>'ok')::boolean) THEN 'failed' ELSE 'completed' END,result_type=kind,result=v_result,content_id=CASE WHEN kind='content' THEN cid ELSE NULL END,batch_id=bid,completed_at=now(),locked_at=NULL,worker_id=NULL,error=CASE WHEN t.task_kind='approved' THEN (SELECT string_agg(value->>'error',' | ') FROM jsonb_array_elements(p_turn->'toolResults') WHERE NOT (value->>'ok')::boolean) ELSE NULL END WHERE id=t.id;
END $$;
REVOKE ALL ON FUNCTION public.complete_assistant_task(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_assistant_task(uuid,text,jsonb) TO service_role;

