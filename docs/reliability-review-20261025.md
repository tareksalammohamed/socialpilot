# SocialPilot reliability review — 25 October 2026

Baseline: main `bcca0b174086c006cf6194f790851b20fbd6d640`.
Scope: request understanding, content creation/review, fallback routing,
background work, publishing, authentication, navigation and the unified inbox.
Production inspection was read-only; no user content was generated, replayed,
scheduled, sent, published or deleted.

## Production evidence

- 7 completed, 5 failed and 3 cancelled creation tasks; no queued/running tasks
  at inspection. The two most recent failures were in quality review on 22 and
  24 October, each recording one OpenRouter attempt and HTTP 402.
- OpenRouter, Groq, Cerebras and Mistral are enabled with configured keys.
  Current strict structured-output capability metadata excludes the latter
  three from those stages. Provider availability is therefore stage-specific.
- Routing policy is `best_quality`, with paid fallback allowed. Preserve this
  user configuration; do not switch policies or spend to test a fix.
- Nine recorded publishing jobs succeeded. This is historical evidence, not a
  new end-to-end publication test.
- Facebook and Instagram are marked connected; LinkedIn is expired and needs
  user reauthorization. Stored status does not prove a current remote token.
- The worker and publisher crons run every minute; analytics runs every six
  hours. Active cron configuration does not prove every invocation succeeds.
- There are six content records and no inbox conversations/messages. WhatsApp
  is not connected, so real send/receive behavior remains unverified.

## Implemented corrections

| Area | Failure | Correction |
| --- | --- | --- |
| AI fallback | The first 12 ranked models were selected before any attempt. On 402, remaining paid models were skipped; free models later in the catalog were unreachable. | Apply the 12-call budget to actual model calls. Walk past skipped paid candidates to free alternatives, retaining the deadline, cost policy, validation and independent review exclusions. |
| Router latency | The same provider key was read for each candidate. | Cache keys within one routing invocation; never across users/requests. |
| Authentication | Bootstrap and auth events independently loaded context; every refresh could reload workspace/brand data and unmount an active screen. | Keep auth callbacks synchronous; load context on user identity changes. Fence stale results after sign-out/user switches and use a stable explicit refresh callback. |
| Workspace recovery | A failed membership/workspace read could be interpreted as absence and trigger provisioning. | Propagate lookup errors; only provision after a successful absence check. Explicit recovery rechecks admin status. |
| Brand loading | A failed brand query opened onboarding as if no brand existed. | Show retry state and ignore stale responses. |
| Initial download | All screens were part of the initial JS bundle. | Lazy-load screens and provide loading/error recovery boundaries. |
| Inbox history | Ascending order plus limit returned the oldest 200 messages. | Fetch the latest 200 with a stable tie-breaker, then render chronologically. Older-history pagination remains future work. |
| WhatsApp UI | Only Evolution bypassed Cloud templates/24-hour controls. | Apply Web-provider behavior to Evolution, WAHA and WPPConnect. Backend provider behavior is unchanged. |
| Reply drafts | One draft was shared between clients. | Keep drafts per conversation while the inbox is mounted; guard late send/approval results against switching clients. Drafts are not persisted across application reloads. |
| Automatic inbox analysis | Setting `aiLoading` invalidated its own effect, discarding the response and leaving loading stuck. | Allow completion through loading transitions and apply results only to the selected conversation. |
| Idle monitoring | Two task queries ran every three seconds while idle. | Poll at most every minute while idle, every five seconds when active, with realtime/focus recovery. |

Production-build initial JS: about **496.87 → 280.65 KB** before gzip,
**142.08 → 84.13 KB** gzipped (screen chunks are downloaded separately).
This measures bytes, not an observed network or interaction timing improvement.

## Verification

- `npm run lint`, `npm run build` and `npm run test:ui`.
- 60 content/router behavior tests passed locally using Deno in manual module
  mode with `--no-check`; the environment's automatic npm dependency downloads
  were unavailable. GitHub CI performs full Deno checks and PostgreSQL tests.
- Added router tests reproduce a free fallback behind 20 paid candidates and
  verify the actual-call budget remains capped at 12.
- Added React DOM integration regressions (Happy DOM, simulated Supabase) for
  latest message order, WAHA/WPPConnect controls, conversation-scoped drafts,
  token refresh retaining the screen, brand-error retry and automatic analysis.
- A real Chromium run was unavailable: no browser binary was installed and the
  browser download returned an invalid/truncated archive. DOM tests do not
  substitute for mobile visual QA or real external service tests.

## Next development priorities

1. **Stage-aware provider readiness:** expose which configured providers can
   actually handle authoring, planning and independent criticism. Reconcile
   capability metadata against supported provider APIs, rather than pretending
   every enabled provider is an eligible alternative or weakening quality gates.
2. **Ambiguous publication outcomes:** persist and reconcile uncertain remote
   results before retrying. A platform accepting a post before a lost response
   remains a duplicate-publication risk; do not claim exactly-once delivery.
3. **WhatsApp activation:** finish the Windows connector and verify QR,
   reconnect, received messages, text/media replies and disconnect with each
   available provider. Current inbox UI tests do not establish live readiness.
4. **Understand follow-ups:** expand acceptance examples for Egyptian requests,
   campaign scope edits, draft-only instructions, dates and conflicting user
   constraints. Existing deterministic creation and editorial tests already
   cover the core weekly/monthly, platform exclusion and rewriting paths.
5. **Growth and navigation:** add server-side pagination for content and older
   conversations/messages. Content currently loads broad lists; conversation
   selection/search operates on the latest 100 conversations. Preserve unsent
   creation input and inbox drafts across navigation with user/workspace scoping.
6. **Task observation:** consolidate duplicate screen/global task subscriptions
   and pollers, add cancellation/time bounds to UI waiters and report partial
   progress clearly when every eligible model fails.

## Rollout

Review and merge the PR after CI succeeds. Deploy the frontend and the
`ai-gateway` Edge Function. No database migration or configuration change is
needed. Existing failed tasks are not automatically replayed; LinkedIn renewal
and Windows WhatsApp connection require the account owner's interaction.
