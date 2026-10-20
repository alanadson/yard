# Code checkpoints

Checkpoints preserve the working files of a task before another edit or prompt.
Their scope is a working directory and a task identity. Fronts created for the
same task keep that identity, but their separate working directories never share
restoration targets. A checkpoint of a shared directory includes everyone's
saved changes in that directory; it does not attribute edits to individual agents.

## Captured state

- Tracked files and untracked files that Git does not ignore, including binary
  files and exact line endings. Deletions are represented by absence.
- Files saved on disk. Unsaved editor buffers are not snapshots of disk.
- Task identity, task label, checkpoint label, timestamp and repository identity.

Git branches, commits and the index are outside restoration. Ignored files are
excluded unless their paths were already captured in the selected checkpoint;
the recovery snapshot includes those paths even if they are now ignored.
Checkpoints are local archives under the Yard data directory, separate from Git.
They do not create commits or branches, and are not pushed to any remote.

## Review and restore

Open **Code checkpoints** in Source control, or the focused terminal's checkpoint
entry in a bench task menu. The manager lists all tasks' checkpoints in that
working directory with their task labels. Manual checkpoints use the current task
context. Select a row, inspect each changed file and choose **Restore files**.
Recovery snapshots appear as **Before restoring** and can themselves be restored
to undo the previous operation. Individual checkpoints can also be deleted.

The checkpoint manager shows additions, modifications and deletions since the
selected checkpoint. A file comparison shows the checkpoint against current disk
contents. Binary and oversized files remain restorable without a text diff.

Restore requires an explicit confirmation of the reviewed checkpoint. The backend
compares the current file fingerprint with the preview token and refuses a stale
preview. A different working directory, branch or HEAD is also refused. The editor
refuses restoration while local drafts or active agents would compete with it.

Before any restoration write, Yard saves a recovery checkpoint. The operation
changes only files that differ. Recovery checkpoints use the same review and
restore flow. A write failure retains that recovery checkpoint and reports its ID.
Restoration is not a filesystem transaction across external processes: agents and
other editors must remain idle while it runs.

## Boundaries

Archive IDs and file paths are validated before reads or writes. Paths cannot
traverse the root or address Git metadata. Links and junctions are refused rather
than followed. Snapshots fail explicitly at their size limits instead of silently
omitting files. Restoring never recursively deletes a directory.

Limits are 32 MiB per file, 256 MiB of uncompressed content and 20,000 paths per
checkpoint. Text comparisons are limited to 512 KiB per side. File/directory
type replacements and Git submodules are refused.

A capture reads the tree one file at a time: a first pass computes a SHA-256
digest over the sorted paths and bytes, and only when it differs from the newest
checkpoint of the same working directory does a second pass stream the files into
a new archive. An identical capture records its own manifest (task identity,
label, timestamp, repository state) that points at the existing archive, so each
task keeps its checkpoint and review link without another copy on disk. Deleting
a checkpoint removes its archive only when no other manifest still reads it.

After each automatic or manual capture, retention keeps the newest 50 checkpoints
per working directory. Recovery snapshots (**Before restoring**) younger than 24
hours are never pruned, and an archive is deleted only when no remaining manifest
references it. A checkpoint linked from a task's review panel can therefore
disappear once 50 newer captures exist in that directory.

The composer (including paste without Enter), bench sends and non-bridge queue
items save a checkpoint before delivery to a local agent in a Git directory.
Queued delivery performs this capture in the native scheduler, even while the
application page is unloaded. The queue request ID and the agent's actual working
directory remain the checkpoint scope. Managed work uses its task ID as the
checkpoint identity; standalone prompts retain their queue request ID. Capture and restore share
one native serialization lock. The scheduler checks readiness again after the
capture before attempting delivery.
A new front with an initial task also saves a checkpoint before starting its
local agent, after setup hooks have completed.
A capture failure is recorded and delivery continues. The native scheduler
persists a warning until the interface displays it. Acknowledged warnings remain
in the recovery history across reloads, and managed tasks retain the failure in
their event timeline. Successful snapshots are linked from the task's review
panel. Native pipeline stages use this same capture and outcome contract.
Checkpoints are best effort;
the user request is preserved even when a repository exceeds snapshot limits.
Native routine occurrences also use the queued capture path for local agents.
Direct terminal input, agent-to-agent messages and remote
SSH/WSL sessions do not automatically capture local code.

Checkpoints cover local Git working directories. SSH files, ignored build output,
external services and changes made only inside a remote runtime are not captured.
Typing directly into a terminal does not create an automatic checkpoint.

## Validation

Rust tests use independent temporary Git repositories and snapshot stores. They
cover byte preservation, ignored files, index preservation, previews, recovery,
stale previews, scope/path boundaries, archive deduplication, shared-archive
deletion and retention. Frontend tests cover task identity,
draft/activity guards, prompt delivery ordering and stale asynchronous responses.
The isolated native scheduler check unloads the page, delivers a user queue item,
lets its agent change a file, and verifies the checkpoint still contains the
original bytes under that request ID.
