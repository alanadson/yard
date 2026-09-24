# Refactoring implementation, September 2026

Work was performed on the existing `main` branch. No dependency was added,
no branch was created, and no commit or push was performed.

## Implementation coverage

| Review | Applied change |
| --- | --- |
| R01 | Diff invalidation follows file content independently of status fingerprints. Viewers receive a content revision. Removed projects and superseded requests cannot republish stale results. |
| R02, R11 | Markdown preview, outline and counts subscribe through document-view leaves and share a parsed model per immutable document object through a WeakMap. |
| R03 | SCM, history and worktree reads share pending work and reject superseded results. Mutations retain the originating project and invalidate history. Sidebar refresh decisions follow project/group membership instead of layout edits. |
| R04 | The PTY pump waits on a condition variable until its next output, persistence or activity deadline. Input, visibility, EOF and stopping can wake it. Existing output limits and offscreen activity remain. |
| R05 | Pending full Git status reads can serve concurrent header readers. Weak ownership avoids retaining completed snapshots. Mutations and file activity invalidate sharing. Standalone headers retain the cheaper `-uno` mode. |
| R06 | Editor events are deduplicated and matched through a path index. Read ownership rejects older disk responses. Background documents follow their own root. File indexing follows root switches and repeats scans invalidated by file creation/deletion. |
| R07 | Canvas content is partitioned once per content revision. Visibility filters only visit relevant card arrays. Vector selection geometry is memoized independently of the camera. |
| R08 | Rail metadata ignores note body/updated-time edits. Palette terminal metadata ignores CPU/RAM ticks while retaining status changes. Shared clock subscriptions have stable identities. |
| R09 | Unchanged document patches and canvas updates preserve state identity. Editor autosave sends changed preference keys through a serialized writer and atomic SQLite batch. Closing waits for edits made during the flush and stays open on persistence failure. |
| R10 | File and note editors share surface ownership/disposal. Retained state, language services, save policy and external text handling stay with their hosts. |
| R12 | Markdown code-span escaping and file-icon name/extension precedence have shared tested implementations. Theme loading and expanded-folder policies stay separate. |
| R13 | Late hotkey registration, partial PTY listener failure and bridge registration failure use shared disposal infrastructure. Notifications share pending permission checks and preserve caller delivery policies. |
| R14 | Session summaries, cost history and live Claude tails share token normalization. Codex cumulative totals become deltas; repeated Claude message IDs contribute once. Pricing is unchanged. |
| R15 | Session and cost caches evict individual least recently used entries. Warm cost reads share immutable Arc sample storage instead of cloning vectors. |
| R16 | Watcher intake is bounded at 400 events, with a per-event path cap and explicit overflow/rescan signals. Clean files resynchronize; dirty drafts are marked stale. Shared directory policy preserves operation-specific exclusions and fixes case-insensitive indexing of Pods. |
| R17 | Extraction was incremental: document views, canvas layers, metadata, request coordination, notification and lifecycle helpers. Large orchestration modules were not wholesale rewritten. |

## Decisions and pending work

R18 was investigated without forcing incompatible dependencies. The application
requests KaTeX `^0.18.4`; installed Mermaid 11.16.1 requests `^0.16.45`. These
ranges do not overlap. Both optional renderers remain lazy. Mermaid Tiny would
remove supported diagram/math capabilities, as described in
[Mermaid's usage documentation](https://mermaid.js.org/config/usage.html).
[Mermaid's math documentation](https://mermaid.js.org/config/math.html) explains
its KaTeX integration. No override, downgrade or speculative upgrade was applied.

Splitting the palette's mixed entry builder by domain, and profiling the
notebook-tree traversal, have since been implemented. Palette entries are
built per domain (`src/components/Palette/compose.ts` cells). File rows are
reused per path within a project, so a feed tick on a 6761-row list costs
about 1.06 ms instead of 8.71 ms. The notebook-path traversal was profiled at
1.98 ms per 1000-memo rebuild and is now off the feed/git path.

The following proposals are not reported as implemented:

- Broader canvas/bridge command-family extraction, toolbar descriptors and card
  chrome beyond the shared behavior extracted in this change.
- Native CPU/frame-time profiling and final editor/canvas interaction checks.

Two items this list used to carry have since landed, each held against the old
algorithm by oracle tests:

- Workspace delta persistence. A save deletes the ids missing from the
  snapshot and upserts the rest in place, writing only rows that differ
  (`persistence/workspace.rs`); anything it cannot prove equivalent (duplicate
  ids, an unexpected schema, triggers, extra foreign keys) runs the old
  delete-and-reinsert path verbatim.
- Incremental JSONL append parsing for the usage scans, `costs.rs` and
  `sessions::usage`: a file that grew is parsed from where its complete lines
  ended (`agents/bookmark.rs`), into typed fields (`agents/usage_line.rs`).

## Regression evidence

Baseline: 264 frontend test files, 3,120 tests; 381 Rust tests passed and four
existing environment probes were ignored. The working tree was initially clean.

Final checks: 276 frontend test files, 3,163 tests passed; 392 Rust tests passed
with the same four existing ignored probes. Type checking, production frontend
build and Clippy with `-D warnings` passed. No old test was deleted, skipped or
weakened. Formatting-only cleanup was followed by type checking and Clippy.

Observed failures before implementation included:

| Test | Failure |
| --- | --- |
| `refreshes a cached diff when text changes with unchanged line counts` | Old diff text was returned. |
| `does not restore a removed project when an older Git read finishes` | The removed summary reappeared. |
| `refreshes the project that started a mutation after the visible project changes` | The original project remained undefined. |
| `discards history that was read before a successful repository mutation` | Obsolete commits were published. |
| `releases the successful listener when another subscription fails` | The successful listener stayed active. |
| `reports a bridge listener registration failure to its owner` | No error reached the owner; an unhandled rejection occurred. |
| `includes edits made while the closing draft flush is still pending` | The first closing draft was saved instead of the latest one. |
| `updates an open document in a background project when that project's files change` | The original text remained. |
| `repeats an index scan invalidated by file creation before it finishes` | The created file was missing. |
| `session_usage_counts_cumulative_tokens_once` | 250 tokens instead of 150. |
| `session_and_history_count_each_api_message_once` | 32 tokens instead of 22. |
| `index_directory_exclusions_match_case_insensitively` | Lowercase pods failed to match. |

New helper/API tests also failed on missing symbols before implementation,
including pump deadlines, atomic preference rollback, metadata, canvas layers,
surface ownership and cache eviction. Additional preference-writer ordering and
retry checks passed against the already implemented writer; those additional
checks are not claimed as observed red.

## Measurements and validation limits

A synthetic workload with 5,000 half-note/half-stroke items and 300 visibility
updates reduced four full-array filter visits from 6,000,000 to one 5,000-item
partition and 750,000 relevant visibility visits. Local aggregate derivation
time was approximately 55 ms before and 14 ms after. This is not React frame
time or an end-to-end speedup claim.

For 100 acknowledged preference snapshots changing only the draft, the writer
sent 107 key/value pairs instead of 800. Native batches are atomic.

The production entry grew from approximately 1,335.51 kB to 1,338.45 kB. The two
optional KaTeX chunks remain. Startup CPU, React commit counts, frame times and
large-session allocation profiles were not measured.

The release launcher built successfully. An isolated native instance booted
with `YARD_DATA_DIR` outside the user's Yard profile. Logs confirmed SQLite,
bridge and frontend startup, and the welcome screen rendered. A remote update
check failed to fetch release metadata. The user stopped Computer Use with
Escape before editor/canvas interaction checks. No further UI automation was
attempted. Focus, IME, undo, pan/zoom and visual Markdown/diff refresh checks
remain pending. Later editor race fixes passed tests and the frontend build,
but were not exercised in that native instance.
