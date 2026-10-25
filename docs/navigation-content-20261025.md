# Draft continuity and bounded content browsing — 25 October 2026

Baseline main: `bea258efa244b199039917aa4bb74bff7cf9c5ed`.

## Resulting behavior

- Unsent creation requests and inbox reply text persist locally across tab
  navigation, component remount and application reload on the same device.
  Keys include version, authenticated user, workspace and editor/conversation.
  Attachments are not persisted; drafts do not synchronize across devices.
- Creation input clears only after the server accepts the durable task. Failed
  enqueue leaves the request available. Successful replies/approvals replace
  only the exact draft they started with; a newer edit is preserved. Storage
  failure leaves the editor usable and shows a warning instead of claiming the
  text was saved. Invalid stored records are ignored.
- Content uses deterministic server pages of 24 records, title search with
  escaped wildcard characters and server status filtering. Search resets to
  page one after a 300ms debounce. Late query responses are ignored.
- Global counters use exact head/count queries and do not become page-local
  totals. Counts/accounts refresh on data changes, not every page/search.
- The calendar loads the displayed browser-local week, in bounded batches,
  with related title/text previews. Calendar titles do not depend on the list
  page/search. Errors clear old week rows rather than relabel stale data.
- Publish Now resolves the variant's linked calendar record from the database,
  independently of the displayed week. A calendar read failure prevents
  submitting a publication with a guessed identity. Existing job/approval,
  quality and uncertain-publication rules remain unchanged.
- Content task observation restores task status on progress but refreshes data
  only on terminal transitions, once per observed change rather than once per
  historical content ID. Idle polling is reduced to a minute, with active
  polling, realtime and focus recovery. Large checkpoints are not selected.
- Shared buttons forward standard HTML/accessibility attributes. Calendar and
  pagination controls have accessible labels; calendar statuses are Arabic.

## Verification

Frontend lint, TypeScript and production build pass. React DOM integration
regressions with simulated Supabase cover: navigation/remount draft recovery,
user isolation, failed enqueue/send, late send success preserving new input,
successful-send clearing, unavailable storage, 73-record pagination, search
beyond the first page, global counts, wildcard escaping, calendar titles and
week boundaries, out-of-view publication identity, and progress/completion
refresh behavior. Existing auth/brand-error/automatic-analysis tests pass.
These are DOM behavior tests, not live service calls or visual browser QA.

The live calendar foreign keys were inspected read-only to verify the joined
content relationship. No production content or task was changed for testing.

## Rollout and limits

Frontend only; no Edge Function deployment, schema migration, configuration or
credential change is needed. Native Git/Vercel release follows passing CI.
Local drafts require browser storage and survive until sent, cleared or device
storage is removed. This does not persist every editor or unsent attachments.
Offsets are ordinary live pagination: concurrent insertions can shift pages;
no immutable snapshot of the entire content history is claimed.
