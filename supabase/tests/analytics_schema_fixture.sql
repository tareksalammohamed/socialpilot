ALTER TABLE public.publishing_jobs ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE public.publishing_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY publishing_jobs_member ON public.publishing_jobs FOR SELECT TO authenticated USING(public.user_workspace_role(workspace_id) IS NOT NULL);
CREATE TABLE public.social_accounts(workspace_id uuid,platform text,status text);
GRANT SELECT ON public.post_insights,public.publishing_jobs TO authenticated,service_role;
GRANT INSERT,UPDATE,DELETE ON public.post_insights TO authenticated;
