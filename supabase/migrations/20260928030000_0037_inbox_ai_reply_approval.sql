-- Phase 2A follow-up: explicit human approval for AI-suggested Inbox replies.
-- Approval never sends a message; it only authorizes loading the draft into the composer.

ALTER TABLE public.inbox_ai_analyses
  ADD COLUMN IF NOT EXISTS reply_status text NOT NULL DEFAULT 'pending'
    CHECK (reply_status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS approved_reply text,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

CREATE INDEX IF NOT EXISTS idx_inbox_ai_analysis_reply_status
  ON public.inbox_ai_analyses(workspace_id, reply_status, updated_at DESC);
