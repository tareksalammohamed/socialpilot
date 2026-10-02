-- Source-of-truth sync for the safe AI auto-reply ledger.
-- The unique inbound_message_id is the idempotency guard against webhook retries.
CREATE TABLE IF NOT EXISTS public.inbox_auto_reply_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.inbox_conversations(id) ON DELETE CASCADE,
  inbound_message_id uuid NOT NULL UNIQUE REFERENCES public.inbox_messages(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES public.inbox_ai_analyses(id) ON DELETE SET NULL,
  outbound_message_id uuid REFERENCES public.inbox_messages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','sent','skipped','failed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inbox_auto_reply_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inbox_auto_reply_runs_select_member" ON public.inbox_auto_reply_runs;
CREATE POLICY "inbox_auto_reply_runs_select_member"
  ON public.inbox_auto_reply_runs FOR SELECT TO authenticated
  USING (public.user_workspace_role(workspace_id) IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_inbox_auto_reply_runs_workspace_status
  ON public.inbox_auto_reply_runs(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_auto_reply_runs_conversation
  ON public.inbox_auto_reply_runs(conversation_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_touch_inbox_auto_reply_runs ON public.inbox_auto_reply_runs;
CREATE TRIGGER trg_touch_inbox_auto_reply_runs
BEFORE UPDATE ON public.inbox_auto_reply_runs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
