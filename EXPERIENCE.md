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


## Batch 2: published job expectations
The single fictional company's job settings are shared across experiences. B edits title, three work scenes, next step and answer contact; save does not publish. A saved candidate preview must be explicitly published, with stale preview and duplicate confirmation guards. C can save a private reason/question proposal; B explicitly copies, edits and previews it before publication. This is role-switching within one browser, not access control.
Each new submission captures an immutable job-description snapshot. Current vs submitted descriptions show differences, while experiences and prior answers remain untouched. Optional continue/add/question responses are independent of wait/proceed/pause and never signal a deficit. Pre-feature storage has no complete job snapshot: migration labels that limitation and retains the exact scenario already saved in each submission rather than claiming to reconstruct missing fields.
Validation: 45 model, render and projection tests. Visual/browser QA was attempted but CUA initialization failed before a tab could be opened (kernel assets path missing); no claim of completed mobile screenshots.


## Batch 3: preview freshness and input recovery
Reproduced an answer preview missing a comparison with the previously published answer: restoring identical draft text could allow an outdated preview after an intervening answer. Previews now include the prior public answer ID, while retaining experience/question IDs, exact question text and submission/question revision checks. Job previews also bind the single job ID in addition to the existing saved draft and public version checks. At confirmation the UI rereads localStorage, including when a storage event has not arrived, and model guards reject changed targets. Storage events close confirmations without writing back. Conflicting company inputs are kept in private recovery fields for explicit restoration and a new preview. These fields never enter candidate projections. This remains a local demo, not transactional multi-user storage.
A paused candidate preference does not block answers and is never changed automatically. The scene-free draft wording no longer claims submission. Validation: 53 tests, including stale publication, queued storage event, recovery/projection, pause and unsubmitted copy regressions.


## Batch 4: the same read-only conversation preparation
The common #preparation route uses one explicit public projection for both roles, including only the selected experience. It shows the latest sent proposal (never agenda drafts), the exact submitted original referenced by that proposal, shared questions and current/previous public answers, the referenced job snapshot/current job/differences, and the experience-specific candidate preference. No proposal is labeled unproposed; no response is treated as agreement. Corrections retain the old source, show differences and require review without silently replacing the original. Private candidate drafts/questions, unpublished answers, internal company notes/recovery fields and other experiences are excluded. Opening this screen does not save or edit state.
No additional summary input, AI generation, sharing link, download, scoring or external transmission was added. Existing proposals contain public confirmation points but no independent company rationale: the screen quotes those points and labels the missing rationale rather than deriving one from internal notes. Validation: 59 model/render/projection tests.

