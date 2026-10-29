# Candidate experience demo

## Preservation

Before implementation, Sites v5 was opened with the official Sites source helper. Its HEAD was `6d41bee30e596cd3f1022dade97ee87d530b6ac5`.

That exact commit was pushed to `https://github.com/pupuchan1/future-company`, branch `snapshot/haas-sites-v5-20261029`. `git ls-remote` read back the same SHA before implementation started. Work continued on `codex/haas-candidate-experience-20261029`. GitHub main was not changed. The Sites snapshot has its own history; it is not a normal source branch based on future-company main. Do not merge its unrelated history into the application main branch.

The prior static reception UI remains at `/reception/`. The original frontend source is in the upstream application's `frontend/` directory; this checkout contains the independently deployable Sites preview.

## Implemented

- Candidate chooses one fictional experience, follows five fixed text prompts, edits the exact employer-facing document, and explicitly confirms submission.
- Recruiter UI reads only submitted copies. Candidate drafts are never included in recruiter markup. Submitted versions are copied and retained; correction drafts do not change earlier submissions.
- Recruiter agenda records `sourceVersion`. A new candidate submission makes an earlier agenda stale, disables sending, displays differences, and requires explicit review before rebuilding it. Recruiter preparation notes survive updates and are excluded from the proposed agenda. Proposals are immutable records and are never automatically resent.
- Candidate questions appear in the document and in both roles' agenda views. The company publishes `answered`, `checking`, `discuss_in_meeting`, or `unanswered`, with response/reason and optional checking date. Candidate chooses wait / proceed / pause; wait does not decline a proposal. Answers and decisions are scoped to the submitted version. An updated answer leaves the earlier decision visible with a review notice.
- Local drafts, versions, answers, agendas, and choices persist across reloads in this browser's localStorage. Storage failure is labeled as tab-only memory. Canceling a confirmation does not submit; duplicate confirmations cannot produce another version. Inputs are HTML-escaped.

## Limits

This is a browser-local role-switching demo using fictional data. It has no production authentication, authorization, server persistence, AI, microphone, email, calendar, backend, or MCP connection. UI draft separation is not an access-control security boundary: the same browser or developer tools can inspect localStorage. No real applicant or customer information should be entered. Candidate content confirmation is not identity verification or verification of the truth of their experience.

The original reception bundle is retained as a historical preview. The new experience doesn't invoke its voice or API code.

## Run and verify

No installation or build step is needed. Node.js 24 was used.

```sh
npm run dev             # http://127.0.0.1:5188
npm run check           # JS syntax
npm test                # domain and render-flow tests
```

The tests cover draft privacy, immutable versions, stale agendas, review requirement, note retention/exclusion, duplicate submission/proposals, cancellation, reload/back behavior, escaped content, answer publication/version scope, and waiting distinct from declining.

Manual walkthrough: candidate → cafe → use fictional sample at each of five questions → review → submit → recruiter → publish company answer → create/propose agenda → candidate chooses wait/proceed/pause. Then correct the candidate question and submit v2 → recruiter checks the differences and updates the agenda before proposing again. Earlier documents/proposals remain available.

## Verification at handoff

- 11 automated tests passed; both JavaScript modules passed syntax checks.
- Local in-app browser navigation timed out. Native Chrome automation approval timed out without executing the intended tab interaction. Desktop/mobile browser rendering and physical phone behavior were not yet verified at this point; do not describe them as verified solely from responsive CSS or render tests.

## Follow-up corrections after v6 browser feedback

- Independent reproduction confirmed that v6 could change an agenda's source version without requiring its wording to change. Agenda revision now starts a separate saved draft. The source version stays unchanged, and proposing remains blocked until the recruiter edits the wording, confirms the latest question, and explicitly saves. A before/after summary records the human-authored change. Legacy v6 agendas already relabeled to a corrected version also require this review before sending again.
- Company answers shared a counter with proposals in v6. Proposal display numbers now count only actual proposals within that experience; legacy proposal record IDs are retained, with sequential display numbers derived from their sent order.
- New experiences now preserve the current experience, including its correction draft, submissions, company answers, agenda and immutable proposals. Candidate and recruiter can switch experiences. Recruiter choices include only submitted titles, never candidate draft titles. Direct `#candidate/new` opens the explicit experience picker; it no longer silently returns to a submitted version.
- Storage-event rendering no longer writes the received state back, preventing repeated cross-tab updates between candidate and recruiter views.
- All data remains browser-local and fictional; no external API, secret, identity or permission integration was added.

## Follow-up after v7: deliberate reuse instead of arbitrary text changes

Independent browser reproduction confirmed that v7 accepted a return to a still-older proposal's wording and allowed another demo proposal. It also retained an unchanged-text prohibition after saving became enabled.

Revision review now compares the proposed wording with both the current agenda and every sent proposal in the selected experience. The comparison normalizes whitespace and Unicode width, not meaning. A match displays the exact previous references and requires a written reason, an explicit reuse-consistency check, and the final check against the current correction and candidate question. Unchanged wording can be retained after this human review; arbitrary character changes are not required. Editing wording or the reason clears the checks. The readiness message updates with the actual save condition, and the review record retains the rationale without exposing that internal rationale to the candidate.

Legacy v7 agendas already saved with wording matching a proposal from an older submission also require the new reuse review before another proposal; existing sent records are not overwritten.

This checks process and matching text only. It does not verify that the rationale is true or that differently worded text is semantically compatible with the correction. A human recruiter remains responsible for that judgment. Experience/answer/decision/note/proposal isolation remains covered by the regression tests.

## Batch 1: scenes and question tracker
Three company work scenes and an equal no-scene option preserve candidate choice without scoring. Multiple questions have experience-scoped IDs. Private question drafts are shared explicitly. Internal checker/notes use separate save paths from public answers. Answers require a sanitized preview followed by explicit publication. v8 data migrates without rewriting submissions, legacy answers or proposals. All storage is browser-local demo data, not production authorization. Validation: 35 model/render/projection tests.

