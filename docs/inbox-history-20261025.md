# Inbox history and selection reliability — 25 October 2026

Baseline main: `57ea2913cd3e6d5fd5ecc323363b19f094511e31`.
This release changes the frontend, not provider connection or webhook logic.

## Behavior

- Conversations use server pages of 30 with deterministic updated-at/ID order.
  Name/latest-snippet search and status/platform filters apply across all stored
  conversations, not just the first 100. Quoted filter values and escaped LIKE
  wildcards preserve literal search characters. This is not full-message-body
  search across every historical message.
- The active conversation has its own snapshot. Changing pages/search does not
  silently switch the reply target or erase its draft. Narrow screens show a
  list or conversation pane with an explicit Back action.
- Load the latest 50 messages, then older pages with a timestamp/ID cursor.
  The cursor retains database timestamp precision and covers equal timestamps.
  Merge by ID in chronological order, preserve live updates that arrived after
  a snapshot started, and retain delete tombstones until selection changes.
- History responses, errors and AI results are fenced to the selected visit,
  including A -> B -> A. Analysis must also refer to the currently latest
  inbound source. Failed/stale AI approvals do not replace a current draft.
- Mark read only after stored messages are loaded and the thread is visible in
  a visible browser tab. A hidden mobile prefetch neither marks it read nor
  starts automatic AI analysis. New arrivals in a hidden pane remain unread.
- Realtime events coalesce sidebar refreshes. Focus/visibility and a one-minute
  fallback refresh recover latest messages without dropping loaded history.
  Idempotent reads have bounded deadlines; failed read-state updates report an
  error rather than falsely showing them as saved.
- Global unread/open/AI-review indicators use exact server counts. The fourth
  indicator explicitly counts connected accounts, not platforms inferred from
  the currently loaded page. Page counters remain filter-specific.
- Attachments download only after the user requests them, with explicit retry.
  They are no longer fetched en masse on opening a long conversation.

## Verification

Lint, TypeScript, production build and both React DOM suites run in CI. New
simulated scenarios include 123 conversations and 131 equal-timestamp messages,
all-history cursor coverage, old-page responses after switching clients,
search outside the first 100, literal quoting, stale search responses, global
counts, concurrent realtime inserts/updates/deletes during a slow snapshot,
explicit media loading and late AI errors/results across client visits.
Mobile tests verify hidden prefetch and hidden inbound messages do not mark
read or trigger automatic AI; opening the thread does.

Production PostgREST syntax was checked read-only for the quoted search and
cursor filters using an anonymous public key and an empty workspace predicate:
both returned HTTP 200 with zero rows. This verifies grammar/schema access,
not an authenticated user journey. Existing inbox indexes were inspected.
No live messages, model requests, publications or replayed tasks were used as
tests. DOM tests do not replace visual browser or live WhatsApp verification.

## Rollout and limits

Frontend-only Git/Vercel deployment after CI passes; no migration, Edge
Function or key/configuration changes. Older-message browsing covers messages
already saved in the database; it does not import missing platform history or
connect WhatsApp. Pagination is live, not an immutable snapshot. Model/provider
availability and reply permissions remain subject to their existing rules.
