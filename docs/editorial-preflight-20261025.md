# Editorial preflight and campaign quality

Authoring now runs the existing deterministic editorial rules before calling a critic. Obvious violations go directly to bounded rewriting. Clean or corrected copy must still pass both independent critics with complete checklists. This removes one unnecessary critic call in the tested one-repair scenario (four model calls instead of five), without claiming measured provider latency. Repeatedly failing copy remains a review draft.

The gate checks the complete published body, CTA and hashtags against the same text limits used by social-publish. Telegram media captions retain their separate stricter check at publication; authoring cannot assume the final media choice. Text is rewritten, never truncated.

New campaign items cannot pass with identical bodies differing only in punctuation, Arabic diacritics or headings/CTA. This is exact normalized-body detection, not semantic similarity. Variants of one single post and revisions carrying the same content identity may share copy. Rewrites are checked against all campaign slots again so a new collision cannot remain approved.

Verdict severity precedes score when combining audits; a failed audit stays failed. The authoring cache namespace changes to editorial-v11 so persisted calls from the previous sequence cannot be reused at the wrong stage after preflight skips a call.

Create shows an aggregate review result and distinguishes completed generation from full review approval. Existing database quality/lease/approval gates remain authoritative.

Validation uses mocked model responses, content and publication tests, UI integration tests, TypeScript/build checks and CI database checks. No actual generation, public post, or message is sent as validation. Live writing evaluation, real mobile visual checks and end-to-end provider latency measurements remain outstanding.
