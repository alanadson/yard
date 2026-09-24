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
type replacements and Git submodules are refused. Archives are retained until
manually deleted; there is no automatic pruning or deduplication.

The composer (including paste without Enter), bench sends and non-bridge queue
items save a checkpoint before delivery to a local agent in a Git directory.
A new front with an initial task also saves a checkpoint before starting its
local agent, after setup hooks have completed.
A capture failure prevents that delivery; drafts and queued items remain
available. Direct terminal input, agent-to-agent messages, routines and remote
SSH/WSL sessions do not automatically capture local code.

Checkpoints cover local Git working directories. SSH files, ignored build output,
external services and changes made only inside a remote runtime are not captured.
Typing directly into a terminal does not create an automatic checkpoint.

## Validation

Rust tests use independent temporary Git repositories and snapshot stores. They
cover byte preservation, ignored files, index preservation, previews, recovery,
stale previews and scope/path boundaries. Frontend tests cover task identity,
draft/activity guards, prompt delivery ordering and stale asynchronous responses.
