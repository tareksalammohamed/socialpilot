# Authoring follow-up reliability

## Shipped scope

- Egyptian short editing requests (اختصره، طوله شوية، خليها بالمصري), language corrections, and explicit platform-only selections use the existing-content edit path without another AI planning call. New-content requests and mixed publish/schedule/delete instructions retain their normal planning/approval path.
- The Create screen sends the identity of its visible saved post or campaign for editorial requests. New content does not inherit that identity. Completed revisions retain identity through subsequent edits.
- A context-free follow-up may inspect only the immediately preceding create/agent task within 24 hours for the same user/workspace; deleted, unresolved or unrelated results form a boundary. It no longer searches arbitrarily far back for an editable item. Scheduling replies also stop at deleted/unresolved requests.
- Platform exclusions actually remove the specified draft variants; explicit retention supports multiple platforms. An attempt to remove every variant, create extra variants through a revision, or save an incomplete/wrong-platform writer response fails before persistence. Existing database scope, lease, published-content and approval checks remain authoritative.
- Direct editorial work skips the unused account-wide performance scan. Ordinary generation and analytics retain their current performance context. This removes unnecessary reads; no absolute latency improvement is claimed without live measurements.
- Explicit shortening/expansion instructions override the default medium-length instruction.

## Validation

79 content/router/publication tests passed locally, plus frontend integration tests for visible revision identity and new-draft isolation. Frontend lint, TypeScript and build checks accompany CI backend type and PostgreSQL workflow checks. Tests use mocked model responses and do not establish live writing quality or provider latency. No public post, paid generation, or message is sent as part of validation.

## Still required for full readiness

Human-scored live Egyptian content samples, measured end-to-end stage latency, approved live schedule-to-publication checks, real mobile visual/accessibility inspection, and local Windows WhatsApp connector activation remain separate validation work. These changes improve request handling; they do not certify the entire platform as production-ready in every integration.
