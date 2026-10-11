# SocialPilot scenario review — 11 October 2026

Reviewed main at `4d9d828c8e42de5caca16b4bee4e825cf0766438`, the task worker,
content creation/revision, editorial gates, provider routing, publishing,
analytics and WhatsApp lifecycle. Production checks were read-only; no content
was generated, scheduled, published, deleted or restarted during this review.

## Confirmed production state

- The assistant worker, scheduled publisher and analytics cron jobs are active.
- Nine publishing jobs have recorded successful completion.
- Facebook, Instagram and LinkedIn accounts are marked connected. This does
  not itself verify current platform tokens or permissions.
- Three creation tasks have failed. The latest stopped in quality review on
  OpenRouter HTTP 402; two earlier failures reported invalid structured output.
- Four providers are enabled: OpenRouter, Groq, Cerebras and Mistral. Availability
  still depends on keys, account quotas and model capabilities.

## Changes in this review

| Stage | Problem | Resulting behavior |
| --- | --- | --- |
| Understand the request | Negated platform names were included; common Egyptian aliases were missed | Excluded destinations are removed from both explicit choices and connected-account defaults |
| Plan actions | Incomplete or invented planner steps could become an empty execution plan | Complete, actionable plans are validated before execution; invalid output triggers model fallback |
| Write a campaign | A monthly plan requested all bodies in one large response | Creation and rewriting use batches of at most eight posts with exact counts and preserved dates |
| Respect language | Generation and rewriting prompts forced Arabic despite English requests | User language is used consistently by author, editor and independent critics; negated English keeps Egyptian defaults |
| Rewrite | CTA and hashtags were missing from the editor's input | Editors receive the entire post; explicit empty/null metadata can remove an unsafe CTA or hashtags |
| Validate output | Objects could appear in hashtags, CTA or improvement lists | Invalid types fail before persistence while optional null/absent metadata remains supported |
| Recover from provider failure | Credit exhaustion aborted all fallback | HTTP 402 tries alternatives, skipping further paid models of that provider while retaining its free models |
| Resume durable stages | Successful checkpoint yields received the same delay as errors | Saved stages become eligible immediately for the next worker tick; genuine failures retain backoff |
| Publish | Immediate and scheduled publishing silently truncated reviewed copy | Both paths share a text builder that refuses excessive length with a clear message before sending |
| Explain failure | Previously saved credit errors exposed raw upstream billing JSON | The progress UI displays a readable Arabic cause |

Two independent editorial reviewers, the 85-point application threshold,
anti-fabrication checks, two rewrite rounds, atomic content saves, task lease
fencing and the existing approval/scheduling rules remain in place.

## Verification scope and remaining limitations

Behavior tests cover creation, monthly batching and repair, metadata removal,
Arabic/English requests, structured output, independent critics, credit
fallback, task checkpoints, publishing text and analytics. GitHub CI additionally
checks Edge Function types and real PostgreSQL workflow/permission transactions.

No live external post or AI call was used as a test. Model judgment cannot
guarantee flawless writing; content that does not pass the gates must remain
under review. When all candidates fail, generation checkpoints remain saved,
but the task can fail rather than finish a reviewed draft. Large campaigns can
still take many worker ticks because every post receives independent reviews.

WhatsApp is an inbox integration rather than a public-feed publishing channel.
The local computer connector still needs its separate setup and a live
connect/send/receive/disconnect test. There is no connected WhatsApp account in
the production state checked here. Some media generation/repurposing tools are
still explicitly unavailable; text workflow success does not prove those tools.

Publication POST requests still need a broader treatment of ambiguous platform
responses: a network failure after a platform accepts a post cannot prove that
it was not published. Existing task lease recovery avoids blind replay after a
worker timeout, but this review does not claim full platform-wide exactly-once
delivery. Future work should add persisted uncertain outcomes and reconcile
them against platform IDs before retrying.

## Rollout

Merge only after CI succeeds. Deploy `ai-gateway`, `assistant-worker`,
`social-publish` and `scheduler-tick`, and deploy the frontend. No database
migration is needed. Already failed tasks are not automatically replayed.
The editorial checkpoint version changes so old generation checkpoints are
not read as differently shaped batches after rollout.
