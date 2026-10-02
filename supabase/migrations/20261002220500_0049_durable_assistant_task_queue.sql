-- Durable server-side queue for the Create assistant.
-- Existing "running" rows with no lock are recoverable by the worker.

ALTER TABLE public.assistant_tasks
  DROP CONSTRAINT IF EXISTS assistant_tasks_status_check;

ALTER TABLE public.assistant_tasks
  ADD CONSTRAINT assistant_tasks_status_check
  CHECK (status IN ('queued','running','completed','failed'));

ALTER TABLE public.assistant_tasks
  ALTER COLUMN status SET DEFAULT 'queued';

ALTER TABLE public.assistant_tasks
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.assistant_tasks
  DROP CONSTRAINT IF EXISTS assistant_tasks_attempt_count_check;
ALTER TABLE public.assistant_tasks
  ADD CONSTRAINT assistant_tasks_attempt_count_check
  CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_queue
  ON public.assistant_tasks(status, created_at)
  WHERE status IN ('queued','running');

CREATE OR REPLACE FUNCTION public.claim_assistant_task(
  p_worker_id text,
  p_task_id uuid DEFAULT NULL
)
RETURNS SETOF public.assistant_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_id uuid;
BEGIN
  SELECT t.id
    INTO v_task_id
  FROM public.assistant_tasks t
  WHERE t.attempt_count < t.max_attempts
    AND (p_task_id IS NULL OR t.id = p_task_id)
    AND (
      t.status = 'queued'
      OR (
        t.status = 'running'
        AND (t.locked_at IS NULL OR t.locked_at < now() - interval '5 minutes')
      )
    )
  ORDER BY
    CASE WHEN p_task_id IS NOT NULL AND t.id = p_task_id THEN 0 ELSE 1 END,
    t.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_task_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.assistant_tasks t
  SET
    status = 'running',
    attempt_count = t.attempt_count + 1,
    locked_at = now(),
    worker_id = p_worker_id,
    started_at = COALESCE(t.started_at, now()),
    error = NULL,
    updated_at = now()
  WHERE t.id = v_task_id
  RETURNING t.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_assistant_task(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_assistant_task(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_assistant_task(text, uuid) TO service_role;
