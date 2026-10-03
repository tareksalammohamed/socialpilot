-- Latest cumulative counters, filtered after deduplication, never summed as increments.
CREATE OR REPLACE VIEW public.latest_post_insights WITH (security_invoker=true) AS
 SELECT DISTINCT ON(i.workspace_id,i.platform,COALESCE(i.external_post_id,i.variant_id::text,i.content_id::text),i.metric)
 i.*,COALESCE(j.published_at,j.completed_at,i.timestamp) AS published_at
 FROM public.post_insights i LEFT JOIN public.publishing_jobs j ON j.id=i.publishing_job_id AND j.workspace_id=i.workspace_id
 WHERE i.value>=0 AND COALESCE(i.external_post_id,i.variant_id::text,i.content_id::text) IS NOT NULL
 ORDER BY i.workspace_id,i.platform,COALESCE(i.external_post_id,i.variant_id::text,i.content_id::text),i.metric,i.fetched_at DESC,i.id DESC;
CREATE OR REPLACE VIEW public.latest_analytics_jobs WITH (security_invoker=true) AS
 SELECT DISTINCT ON(workspace_id,platform,external_post_id) * FROM public.publishing_jobs
 WHERE status='succeeded' AND external_post_id IS NOT NULL AND platform IS NOT NULL
 ORDER BY workspace_id,platform,external_post_id,published_at ASC NULLS LAST,created_at ASC,id;
GRANT SELECT ON public.latest_post_insights,public.latest_analytics_jobs TO authenticated,service_role;
REVOKE INSERT,UPDATE,DELETE ON public.post_insights FROM authenticated;
CREATE OR REPLACE FUNCTION public.enqueue_assistant_task(p_workspace_id uuid,p_kind text,p_payload jsonb,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR public.user_workspace_role(p_workspace_id) IS NULL THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 IF p_kind NOT IN ('create','agent','approved','rpc','publish','analytics') OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text)>100000 THEN RAISE EXCEPTION 'invalid_task'; END IF;
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


CREATE POLICY analytics_tasks_select_workspace ON public.assistant_tasks FOR SELECT TO authenticated
 USING(task_kind='analytics' AND public.user_workspace_role(workspace_id) IS NOT NULL);
-- Refresh automatically every six hours, avoiding overlapping queued work.
SELECT cron.schedule('analytics-refresh-six-hourly','17 */6 * * *',$cron$
 INSERT INTO public.assistant_tasks(workspace_id,user_id,request_text,status,task_kind,payload)
 SELECT w.id,m.user_id,'تحديث مؤشرات المنصات','queued','analytics','{}'::jsonb
 FROM public.workspaces w JOIN LATERAL(SELECT user_id FROM public.workspace_members WHERE workspace_id=w.id ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,user_id LIMIT 1)m ON true
 WHERE EXISTS(SELECT 1 FROM public.social_accounts WHERE workspace_id=w.id AND status='connected' AND platform IN('facebook','instagram','linkedin','x'))
 AND NOT EXISTS(SELECT 1 FROM public.assistant_tasks WHERE workspace_id=w.id AND task_kind='analytics' AND status IN('queued','running'));
$cron$);
