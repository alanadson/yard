# UX and accessibility implementation

Date: 2026-09-13. Audience: developers using Yard to coordinate terminals, agents and Git worktrees.

This change addresses the 17 implementation findings from the interface audit. It was applied on the existing branch and preserves the working tree changes that preceded the audit. Native visual and assistive technology validation remains outstanding because Windows Application Control refused to launch the compiled executable.

## Resulting behavior

| Finding | Surface | Implemented behavior |
| --- | --- | --- |
| 1 | Terminal accessibility | Settings exposes a screen reader mode. The preference reaches new xterm instances and updates running instances. It is opt-in because accessible output has a rendering and memory cost. |
| 2 | Terminal contrast | Accessible contrast is enabled by default. xterm applies a 4.5:1 minimum text contrast without rewriting ANSI background colors. Users can disable the adjustment when exact terminal colors matter. |
| 3 | Applying roles | The form waits for terminal delivery before claiming that instructions were sent. Pending and failed states are visible, failures support retry, and delivery completion after navigation cannot close another dialog. Successful PTY writes do not claim that the agent understood or completed the instructions. |
| 4 | Routine intervals | Submission validates the current numeric draft. Empty, fractional and out-of-range intervals cannot fall back to the previous committed number. |
| 5 | Authored drafts | Closing role and routine forms asks before discarding drafts. Role editor cancellation uses the same explicit choice. An active nested role draft blocks Apply until saved or cancelled. Routine creation establishes the new saved schedule, preventing a false unsaved warning afterward. |
| 6 | Role name collisions | Saving a different role under an existing name, including a case variation, requires explicit replacement approval. Cancelling preserves the draft for renaming. Scope remains part of the decision. |
| 7 | Canvas connections | The connection manager offers named source and destination pickers and a removable connection list. The canvas connection shortcut opens the manager; the pointer tool remains available. Changes use the existing canvas commit path and support Undo. |
| 8 | Role library failures | Loading, failure and retry are distinct. Failed reads cannot masquerade as an empty library and authorize a destructive overwrite. Removal and save errors remain visible outside the editor. Validation focuses and identifies the responsible field. |
| 9 | SCM questions | Branch, tag, stash and PR questions await the operation. Failed operations retain their input and show an associated error. Required values are validated; an empty stash description remains supported. |
| 10 | Landing previews | The first comparison failure offers retry. Refreshing clears the old preview; loading and failed comparisons cannot enable landing. |
| 11 | New tab continuation | Configuring agents or creating a prerequisite project returns to the original tab context. New front creation receives the selected agent. Finishing a successful single front resumes in its new destination. Browser selection on a board opens portal creation directly. |
| 12 | Notifications | Error notices have priority over transient information in the three-notice stack. The last 100 session notifications retain their time, source and details after dismissal. History is reachable from the status bar, command palette, window menu and overflow indicator. Details can be copied with result feedback. History is intentionally session-only and bounded. |
| 13 | Select keyboard behavior | Tab and Shift Tab leave the popup in one keypress and respect modal focus boundaries. Typed prefixes locate enabled options, and repeated letters cycle matching options. |
| 14 | CLI grid navigation | Arrow movement uses measured tile centers rather than assuming one flat row. Focus follows the tile the user last visited. |
| 15 | Batch field semantics | Each row has a fieldset and accessible legend. Repeated field names include the front number; invalid fields reference their own stable error IDs. |
| 16 | Search status | Stable live regions announce loading, failure and current results. Stale matches are not announced as the current result. The results region exposes its busy state. |
| 17 | Responsive layout | Agent connection fields, modal footers and composer controls wrap within the available space. Scrollable modal bodies can shrink; the composer adapts its minimum editor height to short windows. These CSS changes still require native visual validation. |

## Behavioral regression evidence

New rules were exercised before implementation and then rerun with the full frontend suite. The observed failures included:

- `keeps role delivery pending until the prompt has been submitted`: `expected undefined to be an instance of Promise`.
- `surfaces failed reads and preserves the library when saving cannot read existing roles`: the promise resolved to `{}` instead of rejecting.
- `keeps errors ahead of transient notices and retains a bounded history after dismissal`: the stack contained only `one`, `two`, `three` and had discarded `merge failed`.
- New decision modules initially failed because the requested API did not yet exist, including numeric draft validation, connection endpoints, keyboard movement, field error association and flow continuation.

The regression tests live next to their implementation:

- `src/lib/terminalAccessibility.test.ts`, `routineDraft.test.ts`, `roleBrief.test.ts`, `roleLibrary.test.ts`, `roleDraft.test.ts`, `roles.test.ts`, `draftExit.test.ts`.
- `src/components/BenchPanel/askSubmission.test.ts`, `searchAnnouncement.test.ts`.
- `src/components/Floors/landState.test.ts`, `fieldAccessibility.test.ts`, `frontContinuation.test.ts`.
- `src/components/Select/keyboard.test.ts`.
- `src/components/modals/gridNavigation.test.ts`, `roleDelivery.test.ts`.
- `src/components/CanvasView/connectionForm.test.ts`.
- `src/stores/modalFlow.test.ts`, `toastHistory.test.ts`.

No existing test was removed, skipped or weakened. No test dependencies were added. CSS changes have no new unit test because a class snapshot would not validate layout.

## Validation and remaining limits

The initial baseline passed 277 frontend files and 3,181 tests, TypeScript checking, and 392 Rust library tests. Four existing Rust tests were already ignored. This implementation does not modify Rust source.

Final frontend verification passed 294 files and 3,201 tests, including 20 added regression tests. TypeScript checking and `git diff --check` passed. The final frontend production build and Rust release binary compilation passed through `npm run app -- -NoLaunch`. The native launch was attempted with an isolated `YARD_DATA_DIR`. Windows returned: `Uma política de Controle de Aplicativo bloqueou este arquivo.` The protection was not bypassed.

Consequently, these checks remain unverified: actual layout at 900 x 560 and display scaling, visible keyboard focus through full native flows, NVDA output with WebView2, and terminal contrast rendered by each graphics backend. Passing unit tests and compiling the executable do not establish accessibility conformance or replace those checks.

Visual-only changes: no new unit test; native validation in `npm run app` was attempted but blocked by Windows Application Control.
