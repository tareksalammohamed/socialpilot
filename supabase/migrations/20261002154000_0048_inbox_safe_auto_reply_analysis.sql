ALTER TABLE public.inbox_ai_analyses
  ADD COLUMN IF NOT EXISTS safe_to_auto_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automation_reason text,
  ADD COLUMN IF NOT EXISTS automated_at timestamptz;

ALTER TABLE public.inbox_ai_analyses
  DROP CONSTRAINT IF EXISTS inbox_ai_analyses_reply_status_check;

ALTER TABLE public.inbox_ai_analyses
  ADD CONSTRAINT inbox_ai_analyses_reply_status_check
  CHECK (reply_status IN ('pending','approved','rejected','auto_sent'));

CREATE INDEX IF NOT EXISTS idx_inbox_ai_analysis_safe_auto
  ON public.inbox_ai_analyses(workspace_id, safe_to_auto_reply, updated_at DESC)
  WHERE safe_to_auto_reply = true;
