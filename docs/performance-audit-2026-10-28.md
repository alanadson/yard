# Performance audit, 2026-10-28

Base: `5fb19327fe0ae99832d090ce58caa36c164af2c3`, on the existing `main` branch.

## Scope and findings

This audit combined repository-wide searches for timers, subscriptions, caches,
allocations and disk reads with focused inspection of the paths below. It is
not a claim that every source line was profiled or that the application has
reached a universal minimum for CPU or RAM.

| Area | Evidence reviewed | Result |
| --- | --- | --- |
| Startup and bundle | `App.tsx`, `main.tsx`, lazy view loaders, Vite manifest, Cargo profiles | Existing deferred editor, diagrams, fonts and bridge loading retained. No dependency added. |
| React snapshots | `stableSelect.ts`, title bar, workspace grid, sidebar and armed-flow selectors | Repeated reads of the same immutable snapshot reuse its projection. This avoids repeated filtering, graph indexing and temporary arrays. |
| Background UI work | `liveRead.ts`, global events, native queue reader | Hidden announcements wait for visibility. One queue reader owns events, startup, catch-up and the safety tick, coalescing overlapping reads. |
| Project search | `explorer.rs`, `globs.rs`, `searchStore.ts` | Glob patterns compile once using the existing regex dependency. Matching no longer recursively explores wildcard combinations or copies the basename. `?` now consumes one Unicode character. |
| Terminal history search | `scrollback_search.rs` | Snippets borrow a bounded slice of the original line. Removed the full-line `Vec<char>` allocation; only the returned snippet becomes an owned string. |
| Terminal streaming and resources | `pty/reader.rs`, `ptyStream.ts`, `terminalsStore.ts`, `resources.rs`, `process_tree.rs` | Existing bounded buffers, batched acknowledgements, sleeping pumps, precision-aware store updates and per-job process measurements retained. |
| Session and cost reads | `agents/sessions.rs`, `agents/tail.rs`, `costs.rs`, `bounded_cache.rs` | Existing incremental reads, bounded caches, shared sample strings and idle dedup-state release retained. |
| Persistence and canvas | `persistence/workspace.rs`, `canvasViewport.ts`, `culling.ts`, `watcher.rs`, `portalLive.ts` | Existing differential saves, separate camera preferences, viewport culling and visibility-aware observers retained. |

Native scheduling and delivery continue in the backend while the window is
hidden. Only UI mirror reads are deferred. Startup still reads each mirror
once, including when initially hidden, and returning to the window refreshes it.
One already-running read is allowed to finish; it cannot launch a queued
reread while hidden.

## Measurements

Local synthetic workloads, median of five trials. They measure the named
functions, not total application performance. Node was `v26.8.1`; Rust harnesses
were optimized builds. The glob harness used release-optimized regex `1.13.1`,
the same version already present in the application's lockfile.

| Workload | Before | After |
| --- | ---: | ---: |
| 50,000 ordinary path filters | 12.346 ms | 10.160 ms |
| 1,000 filters with repeated wildcards and a missing suffix | 5,504.341 ms | 0.147 ms |
| 10,000 reads of one immutable snapshot containing 10,000 rows | 1,760.256 ms | 1.788 ms |
| Projection evaluations in that workload, per trial | 10,000 | 1 |
| Search in one 8,388,616-byte ASCII line | 30.093 ms | 11.323 ms |
| Requested allocation volume during that search | 67,109,362 bytes | 8,389,022 bytes |
| Startup JavaScript, raw Vite entry size | 737,312 bytes | 737,341 bytes |

The allocation figure counts bytes requested from the allocator during the
search, including reallocations. It is not peak process memory or RSS. Input
construction was excluded. The remaining roughly 8 MB is principally the
existing lowercased search copy.

The ordinary glob workload used `*.rs,src/**,**/*.test.ts` against
`src/components/TerminalPane/index.tsx`. The wildcard workload used
`*a*a*a*a*a*a*b.ts` against 24 `a` characters followed by `c.ts`, reusing one
parsed filter. Setup and compilation were outside both timed loops. A separate
exhaustive check compared 188,155 ASCII pattern/path pairs with the original
matcher and found identical results.

The selector workload projected row IDs and used `sameItems`, then repeatedly
read the same state object. The search workload placed `needle` between two
4 MiB ASCII runs. These workloads deliberately expose redundant work; their
ratios should not be applied to an entire interactive session.

Total emitted JavaScript changed from 10,152,056 to 10,152,085 bytes, with 235
chunks in both builds. This change targets runtime work and allocation rather
than installer size. No feature was removed to achieve the measured reductions.

## Regression evidence

Each implementation change followed an observed failure first:

| Test | Initial failure |
| --- | --- |
| `defers hidden announcements and catches up once when the window returns` | `expected 3 to be 1`: hidden announcements started extra reads. |
| `projects an unchanged immutable snapshot only once` | The projection ran 101 times instead of once. |
| `a_question_mark_matches_one_unicode_character` | `assertion failed: takes("caf?.ts", "café.ts")`. |
| `a_long_line_window_borrows_only_the_matching_snippet` | `expected (&str, usize, bool), found (String, usize, bool)`: the previous API allocated its own window. |

Additional checks cover hiding during an active read, event payloads, long
repeated filenames, literal regex metacharacters and Unicode snippet boundaries.
No existing assertion was loosened or test removed. The old matcher behavior
for `?` on multibyte text was a defect against its documented one-character
contract; ASCII matching and path-separator rules are preserved.

The existing native scheduler scenario needed two fixture corrections: an
explicit 1280 by 900 viewport, and a routine interval of 5 minutes, matching
`ROUTINE_MIN_MIN`. Its previous 1-minute definition was normalized to 5 on UI
load, so it no longer matched the backend's delivered execution record. The
scenario's assertions and default timeout were preserved. The debug integration
run supplies the existing 90-second timeout option because its three real
process deliveries consume most of the default 30-second budget.

## Verification

- Baseline frontend: 412 files, 4,593 tests passed.
- Final frontend: 412 files, 4,596 tests passed with `npm test`.
- Baseline Rust: 1,047 passed, 6 already ignored.
- Final Rust: 1,052 passed, 6 already ignored. No new ignored tests.
- `npm run typecheck`: passed.
- `npm run build -- --manifest`: passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: passed.
- Native build with `tauri/custom-protocol`: passed.
- Isolated native network trace: 101 queue announcements caused zero queue reads
  with hidden visibility, followed by one completed catch-up read on return.
  The same run found `café.ts` through `caf?.ts` and recorded no page errors.
- Native scheduler integration: passed with the existing 90-second option.
  Authenticated hooks, durable queue and managed task delivery, human review,
  checkpoint preservation, routine delivery without a renderer and routine
  rearming in the UI all passed. The fixture corrections are described above.

The first concurrent baseline run hit an existing 5-second LSP test timeout.
The same file passed in isolation, and the complete baseline passed on retry
without changing tests or timeouts. Timings vary with concurrent work on the
host, so suite wall times are not used as optimization evidence.

The first native tracing harness attempted to wrap Tauri's read-only `invoke`
property and therefore counted no requests, including its manual probe. It was
replaced by passive network observation, with a successful manual probe before
checking application behavior. No production change was made for that harness
failure. Native runs use temporary data and home directories.

No aggregate CPU/RAM reduction, installer-size reduction or long-running stress
result is claimed. Those require a controlled native workload and measurements
of the full process tree, including WebView2 and spawned agents.
