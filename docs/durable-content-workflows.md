# Durable content workflows

The browser calls `enqueue_assistant_task`, receives an id and displays persisted
state. Closing a page never cancels accepted work. `assistant-worker` runs from
pg_cron every minute with the existing Vault scheduler secret. No Windows
computer or additional server is required for these workflows.

Creation, AI editing/review, approved scheduling actions and immediate publishing
use the queue. AI planning and each generation/quality/improvement stage are
checkpointed in `assistant_tasks.ai_steps`. Each new AI stage yields; the next
invocation resumes its cached output. Long plans can therefore span multiple
function invocations on the free runtime. This adds minute-scale latency.

Generated content, variants, quality reviews, calendar entries and task completion
commit in one database transaction. Failed saves reuse the AI output, rather than
regenerating or saving half a plan. Workspace membership is checked again before
execution/commit. User tokens are never stored in the queue. Worker RPCs are
service-role only, with leases that fence old workers.

The content screen restores task status, clarification and pending approval on
return, and refreshes content/calendar when state changes. User approval remains
required where proposed tools request it. AI quality failures remain in review;
the scheduled publisher checks variant approval and quality again before sending.

Transient AI/database failures retry at most three times. Expired generation
leases resume after ten minutes. A timed-out publish can have succeeded at the
platform; expired publish/approval work is flagged for review instead of being
blindly sent again. Check the platform and publishing job before an explicit
retry. No system can promise successful publication with disconnected accounts
or unavailable external providers.

## Deployment

Deploy `ai-gateway`, `social-publish`, `scheduler-tick` and `assistant-worker`, then
apply the durable content migration before shipping the frontend. Keep
`assistant-worker.verify_jwt=false` with its custom authentication. The cron URL
in the migration targets the SocialPilot Supabase project; adjust it for another
project. The migration reuses `socialpilot_scheduler_cron_secret` in Vault.

Monitor `assistant_tasks` (status/error/attempt_count/ai_steps),
`publishing_jobs`, `calendar_items`, and `cron.job_run_details`. A cron invocation
returning 202 acknowledges dispatch, not task completion. Results persist in the
database and are visible after reconnecting.

CI runs Deno checks and checkpoint tests, plus real PostgreSQL transactions for
idempotent enqueue/save, stale leases, retry exhaustion, atomic plan rollback,
quality gates, revoked membership and worker permissions.
