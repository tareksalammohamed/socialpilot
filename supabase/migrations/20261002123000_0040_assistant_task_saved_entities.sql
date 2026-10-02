ALTER TABLE public.assistant_tasks
  ADD COLUMN IF NOT EXISTS content_id uuid REFERENCES public.content(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_id uuid;

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_content_id
  ON public.assistant_tasks(content_id)
  WHERE content_id IS NOT NULL;
