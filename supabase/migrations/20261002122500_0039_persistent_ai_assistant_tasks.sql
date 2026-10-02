-- Durable AI assistant tasks so Create workflow survives route changes/reloads.
CREATE TABLE IF NOT EXISTS public.assistant_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_text text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  result_type text CHECK (result_type IN ('content','plan','advice','clarification')),
  result jsonb,
  error text,
  legacy_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.assistant_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "assistant_tasks_select_own" ON public.assistant_tasks;
CREATE POLICY "assistant_tasks_select_own"
ON public.assistant_tasks FOR SELECT TO authenticated
USING (user_id = (select auth.uid()) AND public.user_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS "assistant_tasks_insert_own" ON public.assistant_tasks;
CREATE POLICY "assistant_tasks_insert_own"
ON public.assistant_tasks FOR INSERT TO authenticated
WITH CHECK (user_id = (select auth.uid()) AND public.user_workspace_role(workspace_id) IS NOT NULL);

DROP POLICY IF EXISTS "assistant_tasks_update_own" ON public.assistant_tasks;
CREATE POLICY "assistant_tasks_update_own"
ON public.assistant_tasks FOR UPDATE TO authenticated
USING (user_id = (select auth.uid()) AND public.user_workspace_role(workspace_id) IS NOT NULL)
WITH CHECK (user_id = (select auth.uid()) AND public.user_workspace_role(workspace_id) IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_user_workspace_created
  ON public.assistant_tasks(user_id, workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_touch_assistant_tasks ON public.assistant_tasks;
CREATE TRIGGER trg_touch_assistant_tasks
BEFORE UPDATE ON public.assistant_tasks
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.assistant_tasks TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'assistant_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.assistant_tasks;
  END IF;
END $$;
