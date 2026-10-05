-- Durable, scoped, all-or-nothing draft edits with a receipt and original snapshot.
CREATE TABLE public.editorial_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, operation_key text NOT NULL, snapshot jsonb NOT NULL,
 result jsonb NOT NULL, feedback text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,operation_key)
);
ALTER TABLE public.editorial_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY editorial_revision_read ON public.editorial_revisions FOR SELECT TO authenticated USING(public.user_workspace_role(workspace_id) IS NOT NULL);
GRANT SELECT ON public.editorial_revisions TO authenticated;
GRANT ALL ON public.editorial_revisions TO service_role;

CREATE OR REPLACE FUNCTION public.apply_editorial_revision(p_workspace_id uuid,p_user_id uuid,p_operation_key text,p_task_id uuid,p_worker_id text,p_snapshot jsonb,p_updates jsonb,p_remove_ids uuid[],p_feedback text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE receipt jsonb; old jsonb; edit jsonb; v public.content_variants; q jsonb; qs text; cid uuid; ids uuid[]; memory_id uuid; memory_key text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_user_id) THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 IF p_task_id IS NOT NULL THEN
  PERFORM 1 FROM public.assistant_tasks WHERE id=p_task_id AND workspace_id=p_workspace_id AND user_id=p_user_id AND worker_id=p_worker_id AND status='running' AND locked_at>now()-interval '10 minutes' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease_lost'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||p_operation_key,0));
 SELECT result INTO receipt FROM public.editorial_revisions WHERE workspace_id=p_workspace_id AND operation_key=p_operation_key;
 IF FOUND THEN RETURN receipt; END IF;
 IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot)=0 OR jsonb_typeof(p_updates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_updates)=0 THEN RAISE EXCEPTION 'empty_revision'; END IF;
 SELECT array_agg((x->>'id')::uuid) INTO ids FROM jsonb_array_elements(p_snapshot) x;
 IF (SELECT count(DISTINCT x) FROM unnest(ids)x)<>cardinality(ids) THEN RAISE EXCEPTION 'duplicate_revision'; END IF;
 PERFORM 1 FROM public.content_variants WHERE workspace_id=p_workspace_id AND id=ANY(ids) ORDER BY id FOR UPDATE;
 FOR old IN SELECT value FROM jsonb_array_elements(p_snapshot) LOOP
  SELECT * INTO v FROM public.content_variants WHERE workspace_id=p_workspace_id AND id=(old->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'variant_not_found'; END IF;
  IF v.text IS DISTINCT FROM old->>'text' OR v.platform IS DISTINCT FROM old->>'platform' OR v.updated_at IS DISTINCT FROM (old->>'updated_at')::timestamptz THEN RAISE EXCEPTION 'content_changed_retry_revision'; END IF;
  IF v.status='published' OR EXISTS(SELECT 1 FROM public.publishing_jobs WHERE variant_id=v.id AND status IN ('running','succeeded')) THEN RAISE EXCEPTION 'published_or_publishing_content_cannot_be_replaced'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(COALESCE(p_remove_ids,'{}')) x WHERE NOT x=ANY(ids)) THEN RAISE EXCEPTION 'invalid_revision_target'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_updates) x WHERE NOT (x->>'id')::uuid=ANY(ids) OR (x->>'id')::uuid=ANY(COALESCE(p_remove_ids,'{}'))) THEN RAISE EXCEPTION 'invalid_revision_target'; END IF;
 IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_updates)x)<>jsonb_array_length(p_updates) THEN RAISE EXCEPTION 'duplicate_revision'; END IF;
 IF jsonb_array_length(p_updates)+cardinality(COALESCE(p_remove_ids,'{}'))<>cardinality(ids) THEN RAISE EXCEPTION 'incomplete_revision'; END IF;
 UPDATE public.publishing_jobs SET status='cancelled',last_error='Content edited; approval required again' WHERE workspace_id=p_workspace_id AND variant_id=ANY(ids) AND status IN ('queued','failed');
 UPDATE public.calendar_items SET status='planned' WHERE workspace_id=p_workspace_id AND variant_id=ANY(ids);
 FOR edit IN SELECT value FROM jsonb_array_elements(p_updates) LOOP
  q:=edit->'quality';
  IF NULLIF(btrim(edit->>'content'),'') IS NULL OR length(btrim(edit->>'content'))<30 OR NULLIF(btrim(edit->>'title'),'') IS NULL OR edit->>'platform' IS NULL OR edit->>'platform' NOT IN ('facebook','instagram','linkedin','x','telegram') OR q->>'verdict' IS NULL OR q->>'verdict' NOT IN ('pass','review','fail') OR q->'scores'->>'overall' IS NULL THEN RAISE EXCEPTION 'invalid_editorial_output'; END IF;
  IF (q#>>'{scores,overall}')::numeric NOT BETWEEN 0 AND 100 OR (q->>'verdict'='pass' AND (q#>>'{scores,overall}')::numeric<70) THEN RAISE EXCEPTION 'invalid_quality_score'; END IF;
  qs:=CASE q->>'verdict' WHEN 'pass' THEN 'passed' WHEN 'fail' THEN 'failed' ELSE 'needs_improvement' END;
  UPDATE public.content_variants SET text=edit->>'content',platform=edit->>'platform',hashtags=ARRAY(SELECT jsonb_array_elements_text(COALESCE(edit->'hashtags','[]'))),cta=edit->>'cta',status='review',quality_status=qs,quality_score=(q#>>'{scores,overall}')::numeric,updated_at=now() WHERE workspace_id=p_workspace_id AND id=(edit->>'id')::uuid RETURNING content_id INTO cid;
  UPDATE public.content SET title=edit->>'title',master_text=edit->>'content',status='review',quality_status=qs,quality_score=(q#>>'{scores,overall}')::numeric WHERE id=cid AND workspace_id=p_workspace_id;
  UPDATE public.calendar_items SET platform=edit->>'platform' WHERE variant_id=(edit->>'id')::uuid AND workspace_id=p_workspace_id;
  INSERT INTO public.quality_reviews(variant_id,workspace_id,verdict,scores,reasons,fixes_applied) VALUES((edit->>'id')::uuid,p_workspace_id,q->>'verdict',q->'scores',COALESCE(q->'reasons','[]')||COALESCE(q->'suggested_improvements','[]'),1);
 END LOOP;
 -- Keep job history but remove obsolete calendar entries and unpublished variants.
 UPDATE public.publishing_jobs SET variant_id=NULL,calendar_item_id=NULL WHERE variant_id=ANY(COALESCE(p_remove_ids,'{}')) AND workspace_id=p_workspace_id;
 DELETE FROM public.calendar_items WHERE variant_id=ANY(COALESCE(p_remove_ids,'{}')) AND workspace_id=p_workspace_id;
 DELETE FROM public.quality_reviews WHERE variant_id=ANY(COALESCE(p_remove_ids,'{}')) AND workspace_id=p_workspace_id;
 DELETE FROM public.content_variants WHERE id=ANY(COALESCE(p_remove_ids,'{}')) AND workspace_id=p_workspace_id;
 UPDATE public.content c SET platforms=(SELECT COALESCE(jsonb_agg(DISTINCT platform),'[]') FROM public.content_variants WHERE content_id=c.id AND workspace_id=p_workspace_id),
 quality_status=CASE WHEN EXISTS(SELECT 1 FROM public.content_variants WHERE content_id=c.id AND quality_status='failed') THEN 'failed' WHEN EXISTS(SELECT 1 FROM public.content_variants WHERE content_id=c.id AND quality_status='needs_improvement') THEN 'needs_improvement' WHEN EXISTS(SELECT 1 FROM public.content_variants WHERE content_id=c.id AND quality_status IS DISTINCT FROM 'passed') THEN 'pending' ELSE 'passed' END,
 quality_score=(SELECT min(quality_score) FROM public.content_variants WHERE content_id=c.id AND workspace_id=p_workspace_id)
 WHERE c.workspace_id=p_workspace_id AND c.id IN (SELECT (x->>'content_id')::uuid FROM jsonb_array_elements(p_snapshot)x);
 -- Learn user instructions only, never the model's invented biography or numbers.
 IF p_feedback ~ '(مصري|لهج|نبر|أسلوب|اسلوب|ألفاظ|الفاظ|كلمات|كلمة|كلمه|صياغ|اختصر|مختصر|رسمي|فصحى)' THEN
 memory_key:=CASE WHEN p_feedback ~ '(مصري|مصرية|مصريه)' THEN 'editorial_dialect' ELSE 'editorial_correction_'||md5(btrim(p_feedback)) END;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||memory_key,0));
 SELECT id INTO memory_id FROM public.brand_memory WHERE workspace_id=p_workspace_id AND type='edit_pattern' AND key=memory_key ORDER BY updated_at DESC LIMIT 1;
 IF FOUND THEN UPDATE public.brand_memory SET value=p_feedback,evidence_count=evidence_count+1,confidence=LEAST(1,confidence+0.1),updated_at=now() WHERE id=memory_id;
 ELSE INSERT INTO public.brand_memory(workspace_id,type,key,value,source,confidence) VALUES(p_workspace_id,'edit_pattern',memory_key,p_feedback,'user_correction',0.9); END IF;
 END IF;
 receipt:=jsonb_build_object('updated',jsonb_array_length(p_updates),'removed',cardinality(COALESCE(p_remove_ids,'{}')),'quality', (SELECT jsonb_agg(x->'quality') FROM jsonb_array_elements(p_updates)x));
 INSERT INTO public.editorial_revisions(workspace_id,user_id,operation_key,snapshot,result,feedback) VALUES(p_workspace_id,p_user_id,p_operation_key,p_snapshot,receipt,p_feedback);
 RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.apply_editorial_revision(uuid,uuid,text,uuid,text,jsonb,jsonb,uuid[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_editorial_revision(uuid,uuid,text,uuid,text,jsonb,jsonb,uuid[],text) TO service_role;

-- Claims lock the variant so editing cannot race an in-flight publication.
CREATE OR REPLACE FUNCTION public.guard_editorial_publication() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.content_variants;
BEGIN
 IF NEW.status='running' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
  SELECT * INTO v FROM public.content_variants WHERE id=NEW.variant_id AND workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND OR v.quality_status IS DISTINCT FROM 'passed' OR v.status='rejected' THEN RAISE EXCEPTION 'quality_review_required'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_editorial_publication() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER publishing_editorial_guard BEFORE INSERT OR UPDATE OF status ON public.publishing_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_editorial_publication();

CREATE OR REPLACE FUNCTION public.approve_content_variant(
  p_workspace_id uuid,
  p_variant_id uuid,
  p_scheduled_for timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_variant public.content_variants;
  v_calendar public.calendar_items;
BEGIN
  SELECT * INTO v_variant FROM public.content_variants
  WHERE id = p_variant_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'variant_not_found'; END IF;
  IF v_variant.quality_status IS DISTINCT FROM 'passed' THEN RAISE EXCEPTION 'quality_review_required'; END IF;

  UPDATE public.content_variants SET status = 'approved' WHERE id = p_variant_id;
  SELECT * INTO v_calendar FROM public.calendar_items
  WHERE workspace_id = p_workspace_id AND variant_id = p_variant_id
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    UPDATE public.calendar_items
    SET scheduled_for = COALESCE(p_scheduled_for, scheduled_for), status = 'scheduled'
    WHERE id = v_calendar.id RETURNING * INTO v_calendar;
  ELSE
    INSERT INTO public.calendar_items (workspace_id, content_id, variant_id, platform, scheduled_for, status)
    VALUES (p_workspace_id, v_variant.content_id, v_variant.id, v_variant.platform,
      COALESCE(p_scheduled_for, now() + interval '1 day'), 'scheduled')
    RETURNING * INTO v_calendar;
  END IF;

  UPDATE public.content SET status = 'scheduled', scheduled_at = v_calendar.scheduled_for
  WHERE id = v_variant.content_id AND workspace_id = p_workspace_id;

  INSERT INTO public.publishing_jobs (workspace_id, variant_id, calendar_item_id, idempotency_key, action, status, scheduled_for, platform)
  VALUES (p_workspace_id, v_variant.id, v_calendar.id,
    concat(p_workspace_id, ':', v_variant.id, ':', to_char(v_calendar.scheduled_for, 'YYYYMMDDHH24MISSMS')), 'schedule', 'queued', v_calendar.scheduled_for, v_variant.platform)
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('variant_id', v_variant.id, 'calendar_item_id', v_calendar.id, 'scheduled_for', v_calendar.scheduled_for);
END;
$$;

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
   ELSIF tool->>'name' IN ('create_content_plan','create_campaign') THEN kind:='plan'; END IF;
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
     PERFORM public.run_assistant_task_rpc(t.id,p_worker_id,CASE WHEN qs='passed' AND when_at>now() AND COALESCE(t.payload#>>'{legacyContext,draft_only}','false')<>'true' THEN 'approve_content_variant' ELSE 'schedule_content_variant' END,jsonb_build_object('p_workspace_id',t.workspace_id,'p_variant_id',vid,'p_scheduled_for',when_at));
     IF qs<>'passed' OR when_at<=now() OR t.payload#>>'{legacyContext,draft_only}'='true' THEN UPDATE public.content SET status='review' WHERE id=cid; END IF;
    END IF;
    idx:=idx+1;
   END LOOP;
  END LOOP;
 END IF;
 UPDATE public.assistant_tasks SET status=CASE WHEN t.task_kind='approved' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_turn->'toolResults') WHERE NOT (value->>'ok')::boolean) THEN 'failed' ELSE 'completed' END,result_type=kind,result=v_result,content_id=CASE WHEN kind='content' THEN cid ELSE NULL END,batch_id=bid,completed_at=now(),locked_at=NULL,worker_id=NULL,error=CASE WHEN t.task_kind='approved' THEN (SELECT string_agg(value->>'error',' | ') FROM jsonb_array_elements(p_turn->'toolResults') WHERE NOT (value->>'ok')::boolean) ELSE NULL END WHERE id=t.id;
END $$;
REVOKE ALL ON FUNCTION public.complete_assistant_task(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_assistant_task(uuid,text,jsonb) TO service_role;

