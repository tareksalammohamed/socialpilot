-- Dismissing a proposed action must also survive a reload.
CREATE OR REPLACE FUNCTION public.dismiss_assistant_approval(p_workspace_id uuid,p_variant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR public.user_workspace_role(p_workspace_id) IS NULL THEN RAISE EXCEPTION 'workspace_access_denied'; END IF;
 UPDATE public.assistant_tasks SET result=result-'pendingApproval'
 WHERE workspace_id=p_workspace_id AND user_id=auth.uid() AND status='completed'
 AND task_kind='agent' AND payload->'agentContext'->>'currentVariantId'=p_variant_id::text;
END $$;
REVOKE ALL ON FUNCTION public.dismiss_assistant_approval(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dismiss_assistant_approval(uuid,uuid) TO authenticated;
