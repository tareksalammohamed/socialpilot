CREATE INDEX IF NOT EXISTS idx_inbox_auto_reply_runs_analysis_id
  ON public.inbox_auto_reply_runs(analysis_id)
  WHERE analysis_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_auto_reply_runs_outbound_message_id
  ON public.inbox_auto_reply_runs(outbound_message_id)
  WHERE outbound_message_id IS NOT NULL;
