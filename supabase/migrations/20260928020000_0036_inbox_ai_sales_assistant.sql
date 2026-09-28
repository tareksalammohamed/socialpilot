-- Phase 2A: Inbox AI Sales Assistant analysis and reply suggestions.
-- Analysis is workspace-scoped, replaceable per conversation, and never auto-sends.

CREATE TABLE IF NOT EXISTS public.inbox_ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.inbox_conversations(id) ON DELETE CASCADE,
  intent text NOT NULL DEFAULT 'unknown',
  lead_score numeric NOT NULL DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  summary text NOT NULL DEFAULT '',
  suggested_reply text,
  next_best_action text NOT NULL DEFAULT '',
  quality_verdict text NOT NULL DEFAULT 'review' CHECK (quality_verdict IN ('pass','review','fail')),
  quality_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text,
  model text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, conversation_id)
);

ALTER TABLE public.inbox_ai_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inbox_ai_analysis_select_member" ON public.inbox_ai_analyses;
CREATE POLICY "inbox_ai_analysis_select_member" ON public.inbox_ai_analyses FOR SELECT
  TO authenticated USING (public.user_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS "inbox_ai_analysis_insert_member" ON public.inbox_ai_analyses;
CREATE POLICY "inbox_ai_analysis_insert_member" ON public.inbox_ai_analyses FOR INSERT
  TO authenticated WITH CHECK (public.user_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS "inbox_ai_analysis_update_member" ON public.inbox_ai_analyses;
CREATE POLICY "inbox_ai_analysis_update_member" ON public.inbox_ai_analyses FOR UPDATE
  TO authenticated USING (public.user_workspace_role(workspace_id) IS NOT NULL)
  WITH CHECK (public.user_workspace_role(workspace_id) IS NOT NULL);
DROP POLICY IF EXISTS "inbox_ai_analysis_delete_admin" ON public.inbox_ai_analyses;
CREATE POLICY "inbox_ai_analysis_delete_admin" ON public.inbox_ai_analyses FOR DELETE
  TO authenticated USING (public.user_workspace_role(workspace_id) IN ('owner','admin'));

CREATE INDEX IF NOT EXISTS idx_inbox_ai_analysis_workspace_priority
  ON public.inbox_ai_analyses(workspace_id, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_ai_analysis_conversation
  ON public.inbox_ai_analyses(conversation_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_touch_inbox_ai_analyses ON public.inbox_ai_analyses;
CREATE TRIGGER trg_touch_inbox_ai_analyses
BEFORE UPDATE ON public.inbox_ai_analyses
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
