BEGIN;
INSERT INTO auth.users VALUES('a0000000-0000-0000-0000-000000000001'),('b0000000-0000-0000-0000-000000000001');
INSERT INTO public.workspaces VALUES('a0000000-0000-0000-0000-000000000002'),('b0000000-0000-0000-0000-000000000002');
INSERT INTO public.workspace_members VALUES('a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001','owner'),('b0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001','owner');
INSERT INTO public.publishing_jobs(id,workspace_id,platform,status,external_post_id,published_at) VALUES
 ('a0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000002','facebook','succeeded','one','2026-09-01'),
 ('a0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000002','facebook','succeeded','one','2026-09-01'),
 ('b0000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000002','facebook','succeeded','one','2026-09-01');
INSERT INTO public.post_insights(workspace_id,publishing_job_id,external_post_id,platform,metric,value,timestamp,fetched_at) VALUES
 ('a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003','one','facebook','likes',10,'2026-09-01','2026-09-10'),
 ('a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000004','one','facebook','likes',0,'2026-09-02','2026-10-02'),
 ('b0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000003','one','facebook','likes',99,'2026-09-01','2026-10-02');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','a0000000-0000-0000-0000-000000000001',true);
DO $$ BEGIN
 IF (SELECT count(*) FROM public.latest_post_insights)<>1 THEN RAISE EXCEPTION 'snapshot dedup or workspace RLS failed'; END IF;
 IF (SELECT value FROM public.latest_post_insights)<>0 THEN RAISE EXCEPTION 'latest zero correction lost'; END IF;
 IF (SELECT count(*) FROM public.latest_analytics_jobs)<>1 THEN RAISE EXCEPTION 'job dedup or workspace RLS failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.latest_post_insights WHERE published_at>='2026-10-01') THEN RAISE EXCEPTION 'fetch date used as publication date'; END IF;
 IF has_table_privilege('authenticated','public.post_insights','INSERT') OR has_table_privilege('authenticated','public.post_insights','UPDATE') OR has_table_privilege('authenticated','public.post_insights','DELETE') THEN RAISE EXCEPTION 'client can forge counters'; END IF;
 PERFORM public.enqueue_assistant_task('a0000000-0000-0000-0000-000000000002','analytics','{}','a0000000-0000-0000-0000-000000000005');
 BEGIN
  PERFORM public.enqueue_assistant_task('b0000000-0000-0000-0000-000000000002','analytics','{}','a0000000-0000-0000-0000-000000000006');
  RAISE EXCEPTION 'cross_workspace_allowed';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'workspace_access_denied' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
ROLLBACK;
