BEGIN;
INSERT INTO auth.users VALUES('10000000-0000-0000-0000-000000000010');
INSERT INTO public.workspaces VALUES('20000000-0000-0000-0000-000000000010');
INSERT INTO public.workspace_members VALUES('20000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000010','owner');
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000010',true);
DO $$
DECLARE invalid_id uuid; before_count integer; tid uuid:=gen_random_uuid(); wid uuid:='20000000-0000-0000-0000-000000000010'; bid uuid;
BEGIN
 PERFORM public.enqueue_assistant_task(wid,'create','{"message":"weekly","legacyContext":{"timezone":"Africa/Cairo","schedule":{"time":"20:30"}}}',tid);
 PERFORM public.claim_assistant_task('schedule-test',tid);
 PERFORM public.complete_assistant_task(tid,'schedule-test','{"toolResults":[{"ok":true,"name":"create_content_plan","output":{"theme":"Test","slots":[{"date":"2027-07-01","platform":"facebook","title":"Summer","content":"Draft","quality":{"verdict":"review","scores":{"overall":70}}},{"date":"2027-12-01","platform":"facebook","title":"Winter","content":"Draft","quality":{"verdict":"review","scores":{"overall":70}}}]}}]}');
 SELECT batch_id INTO bid FROM public.assistant_tasks WHERE id=tid;
 IF (SELECT scheduled_at FROM public.content WHERE batch_id=bid AND title='Summer') IS DISTINCT FROM '2027-07-01 17:30:00+00'::timestamptz THEN RAISE EXCEPTION 'Cairo summer hour lost'; END IF;
 IF (SELECT scheduled_at FROM public.content WHERE batch_id=bid AND title='Winter') IS DISTINCT FROM '2027-12-01 18:30:00+00'::timestamptz THEN RAISE EXCEPTION 'Cairo winter hour lost'; END IF;
 IF EXISTS(SELECT 1 FROM public.publishing_jobs WHERE workspace_id=wid) THEN RAISE EXCEPTION 'quality review gate bypassed'; END IF;
 SELECT count(*) INTO before_count FROM public.content;
 invalid_id:=gen_random_uuid();
 PERFORM public.enqueue_assistant_task(wid,'create','{"message":"broken plan"}',invalid_id);
 PERFORM public.claim_assistant_task('broken-test',invalid_id);
 BEGIN
  PERFORM public.complete_assistant_task(invalid_id,'broken-test','{"toolResults":[{"ok":true,"name":"create_content_plan","output":{"slots":[{"date":"2027-07-01","platform":"facebook","title":"منشور 1","content":"","quality":{"verdict":"review","scores":{"overall":70}}}]}}]}');
  RAISE EXCEPTION 'empty_content_accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'incomplete_plan_content' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.complete_assistant_task(invalid_id,'broken-test','{"toolResults":[{"ok":true,"name":"create_content_plan","output":{"slots":[{"date":"2027-07-01","platform":"facebook","title":"Test","content":"Actual body","quality":{"verdict":"review","scores":{}}}]}}]}');
  RAISE EXCEPTION 'empty_quality_accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'incomplete_plan_quality' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM public.content)<>before_count OR (SELECT status FROM public.assistant_tasks WHERE id=invalid_id)<>'running' THEN RAISE EXCEPTION 'invalid_plan_saved'; END IF;
END $$;
ROLLBACK;
