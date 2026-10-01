-- Unified Inbox workflow state and assignment.
ALTER TABLE public.inbox_conversations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','pending','closed')),
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_inbox_conv_ws_status_updated
  ON public.inbox_conversations(workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_conv_assigned_to
  ON public.inbox_conversations(assigned_to)
  WHERE assigned_to IS NOT NULL;
