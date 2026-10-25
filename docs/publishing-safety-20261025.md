# Publishing safety and provider eligibility — 25 October 2026

Based on main `2b91cf0a7fca40ccb2fdfdb57d62590da482cdff` (PR #42).
Read-only production inspection confirms the owner's LinkedIn reconnection:
connected, needs_reconnect=false, synchronized on 25 October. No real posts,
AI calls or replayed tasks were used as tests.

## Changes

- Authoring/review/planning may use prompt-only JSON models only when the
  caller explicitly opts in and supplies validation. They receive a JSON-only
  instruction instead of unsupported native response_format. The same output
  validation, editorial gates and independent critic exclusions still apply.
  Cost policy, circuit filtering, deadlines and the 12-call limit are preserved.
- Provider admin cards show eligible candidate counts under saved cost and
  circuit settings, including native JSON counts. Eligibility is not a promise
  of available quota or reviewer independence after selecting the author.
- Both active publishers persist a dispatch marker before any public-post
  POST. Persistence failure prevents sending. These POSTs are never retried
  inside the HTTP helper, including after 5xx, and have a 45-second deadline.
- Network failures, HTTP 408/5xx, malformed success responses and absent remote
  IDs remain uncertain. A workspace/variant hold blocks another key or changed
  schedule from bypassing that outcome. Stale dispatches become failed; fresh
  in-flight dispatches remain running. Other explicit 4xx errors are rejected.
- Confirm the remote post ID in the job result before the final success update.
  A subsequent attempt restores success from that ID without posting again.
  If storage fails after sending, the earlier durable dispatch marker remains.

## Verification

Frontend lint, build and React DOM regressions pass locally. All 73
content/router/publication tests pass locally (Deno manual module mode with
--no-check); CI runs full Edge Function type checks and PostgreSQL tests.
New cases cover validated text fallback, missing validators, rejected schemas,
network/503/408 failures, malformed responses, missing IDs, persistence failure,
explicit rejection, confirmed ID persistence, scoped holds and active dispatch.

## Limits and rollout

This is conservative hold-and-recovery, not platform-wide exactly-once
publication or automatic remote reconciliation. Unknown outcomes require
operator inspection; this change does not add a user-facing unlock action.
Concurrent independent calendar items are not one distributed transaction.
Live posting and visual browser verification remain separate.

The active frontend/worker/cron paths use social-publish and scheduler-tick;
legacy publish-post/run-scheduler are unchanged. Existing JSON/timestamp fields
support the change, so no migration is needed. No keys, quotas, model flags,
cost policies or earlier tasks are changed.

After CI, deploy the frontend and ai-gateway, ai-admin, social-publish and
scheduler-tick, retaining their existing JWT configuration. Smoke checks must
not publish content or replay earlier failed tasks.
