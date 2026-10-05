-- Cancellation revokes the worker lease; every existing save/complete is fenced.
ALTER TABLE public.assistant_tasks DROP CONSTRAINT assistant_tasks_status_check;
ALTER TABLE public.assistant_tasks ADD CONSTRAINT assistant_tasks_status_check
 CHECK (status IN ('queued','running','completed','failed','cancelled'));
ALTER TABLE public.assistant_tasks
 ADD COLUMN progress jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN original_payload jsonb,
 ADD COLUMN restarted_from uuid REFERENCES public.assistant_tasks(id);
CREATE UNIQUE INDEX assistant_tasks_one_restart ON public.assistant_tasks(restarted_from) WHERE restarted_from IS NOT NULL;
UPDATE public.assistant_tasks SET original_payload=payload WHERE original_payload IS NULL;
CREATE FUNCTION public.capture_assistant_task_request() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN NEW.original_payload:=COALESCE(NEW.original_payload,NEW.payload); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION public.capture_assistant_task_request() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assistant_tasks_capture_request BEFORE INSERT ON public.assistant_tasks
 FOR EACH ROW EXECUTE FUNCTION public.capture_assistant_task_request();

CREATE FUNCTION public.cancel_assistant_task(p_task_id uuid)
RETURNS public.assistant_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t public.assistant_tasks;
BEGIN
 SELECT * INTO t FROM public.assistant_tasks WHERE id=p_task_id AND user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND OR public.user_workspace_role(t.workspace_id) IS NULL THEN RAISE EXCEPTION 'task_access_denied'; END IF;
 IF t.status='running' AND t.task_kind IN ('publish','approved','rpc') THEN RAISE EXCEPTION 'action_already_started'; END IF;
 IF t.status IN ('queued','running') THEN
  UPDATE public.assistant_tasks SET status='cancelled',worker_id=NULL,locked_at=NULL,completed_at=now(),error=NULL,
   updated_at=now() WHERE id=t.id RETURNING * INTO t;
 END IF;
 RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.cancel_assistant_task(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cancel_assistant_task(uuid) TO authenticated;

CREATE FUNCTION public.restart_assistant_task(p_task_id uuid)
RETURNS public.assistant_tasks LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t public.assistant_tasks; fresh public.assistant_tasks; v_id uuid;
BEGIN
 SELECT * INTO t FROM public.assistant_tasks WHERE id=p_task_id AND user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND OR public.user_workspace_role(t.workspace_id) IS NULL THEN RAISE EXCEPTION 'task_access_denied'; END IF;
 -- Never replay immediate publishing or approvals with ambiguous side effects.
 IF t.task_kind NOT IN ('create','agent','analytics') THEN RAISE EXCEPTION 'task_restart_not_supported'; END IF;
 SELECT * INTO fresh FROM public.assistant_tasks WHERE restarted_from=t.id;
 IF FOUND THEN RETURN fresh; END IF;
 PERFORM public.cancel_assistant_task(t.id);
 v_id:=public.enqueue_assistant_task(t.workspace_id,t.task_kind,COALESCE(t.original_payload,t.payload),gen_random_uuid());
 UPDATE public.assistant_tasks SET restarted_from=t.id WHERE id=v_id RETURNING * INTO fresh;
 RETURN fresh;
END $$;
REVOKE ALL ON FUNCTION public.restart_assistant_task(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.restart_assistant_task(uuid) TO authenticated;
