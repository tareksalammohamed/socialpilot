-- Keep durable execution/audit records and saved content; remove the request from UI.
ALTER TABLE public.assistant_tasks ADD COLUMN archived_at timestamptz;
CREATE FUNCTION public.archive_creation_request(p_task_id uuid)
RETURNS public.assistant_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t public.assistant_tasks;
BEGIN
 SELECT * INTO t FROM public.assistant_tasks WHERE id=p_task_id AND user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND OR public.user_workspace_role(t.workspace_id) IS NULL THEN RAISE EXCEPTION 'task_access_denied'; END IF;
 IF t.task_kind<>'create' THEN RAISE EXCEPTION 'task_archive_not_supported'; END IF;
 -- Same row lock as worker completion: either saved results win first, or the
 -- cancellation revokes the lease and subsequent worker writes fail.
 PERFORM public.cancel_assistant_task(t.id);
 UPDATE public.assistant_tasks SET archived_at=COALESCE(archived_at,now()),updated_at=now()
 WHERE id=t.id RETURNING * INTO t;
 RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.archive_creation_request(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.archive_creation_request(uuid) TO authenticated;
