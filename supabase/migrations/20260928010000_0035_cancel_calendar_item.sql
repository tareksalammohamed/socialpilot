-- 0035: cancel_calendar_item — the missing counterpart of reschedule_calendar_item.
--
-- The Universal Agent registers a `cancel_schedule` tool, but no DB operation
-- existed for it, and the UI has no cancel path either. Business logic for
-- state transitions lives in RPCs here (approve/schedule/reschedule), so
-- cancelling follows the same pattern: SECURITY INVOKER (RLS applies), member
-- check, row lock, and one place that keeps calendar_items, publishing_jobs,
-- content_variants and content consistent.
CREATE OR REPLACE FUNCTION public.cancel_calendar_item(
  p_workspace_id uuid,
  p_calendar_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item public.calendar_items;
  v_job_count integer;
  v_active_left integer;
BEGIN
  IF public.user_workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION 'workspace_access_denied';
  END IF;

  SELECT * INTO v_item
  FROM public.calendar_items
  WHERE id = p_calendar_item_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'calendar_item_not_found';
  END IF;
  IF v_item.status IN ('published', 'publishing', 'cancelled') THEN
    RAISE EXCEPTION 'calendar_item_not_cancellable';
  END IF;

  UPDATE public.calendar_items SET status = 'cancelled' WHERE id = v_item.id;

  -- Only jobs that have not started/finished; a running or succeeded job is
  -- never touched.
  UPDATE public.publishing_jobs
  SET status = 'cancelled', completed_at = now()
  WHERE calendar_item_id = v_item.id
    AND workspace_id = p_workspace_id
    AND status IN ('queued', 'failed');
  GET DIAGNOSTICS v_job_count = ROW_COUNT;

  IF v_item.variant_id IS NOT NULL THEN
    UPDATE public.content_variants
    SET scheduled_at = NULL
    WHERE id = v_item.variant_id AND workspace_id = p_workspace_id;
  END IF;

  -- Return the parent content to 'approved' only if nothing else is still
  -- pending for it; never downgrade a content row already published.
  IF v_item.content_id IS NOT NULL THEN
    SELECT count(*) INTO v_active_left
    FROM public.calendar_items
    WHERE workspace_id = p_workspace_id
      AND content_id = v_item.content_id
      AND status IN ('planned', 'scheduled', 'publishing');
    IF v_active_left = 0 THEN
      UPDATE public.content
      SET status = 'approved', scheduled_at = NULL
      WHERE id = v_item.content_id
        AND workspace_id = p_workspace_id
        AND status = 'scheduled';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'calendar_item_id', v_item.id,
    'status', 'cancelled',
    'publishing_jobs_cancelled', v_job_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_calendar_item(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_calendar_item(uuid, uuid) TO authenticated;
