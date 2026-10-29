# Independent delivery reviews

The work panel can send a submitted delivery to another agent for an independent
opinion. The reviewer runs through the existing durable task queue and reports
through the authenticated `yard task show` and `yard task submit` commands.

## Request and execution

Open **Tarefas e entregas**, select a task awaiting review, choose **Agente
revisor**, and select **Solicitar revisão independente**. Current and former
participants in the task cannot review it. A registered agent can receive a
queued request while it is busy; normal readiness, budget and concurrency
rules still decide when the prompt is delivered.

The backend creates a separate review task and queues it in one SQLite
transaction. A full queue or another validation failure leaves no partial
review task. Repeating an acknowledged request does not duplicate it. A new
request for the same delivery and reviewer also reuses an unfinished review.
The review task remains visible in the ordinary task list, where interrupted
work can be inspected, resumed or cancelled with the existing controls.

The request contains the original instruction, acceptance criteria and evidence,
delivery summary, validation checks, artifacts, working directory and resource
links. This is an immutable snapshot of the reported delivery, not a copy of
every referenced file. Files can change afterwards; linked code checkpoints
provide the retained file evidence when available.

The reviewer receives instructions to inspect the evidence, run relevant checks,
report unresolved findings and avoid editing project files. It retains its CLI's
normal tools and permissions. These instructions are not a filesystem sandbox.

## Results and approval

`work_task_reviews` links each review task to one revision in
`work_task_deliveries`. Review metadata and task records share the existing
database and backups. The panel polls review results while open and restores
them after a reload.

- A failed validation check labels the opinion **Precisa de ajustes**.
- Passing checks with evidence and evidence for every review criterion label
  it **Parecer favorável**.
- Missing validation or criterion evidence labels it **Parecer inconclusivo**.
- A review targeting an older delivery is labelled **Entrega anterior**.

These labels describe reported evidence. The user still inspects it and approves
the original delivery. A reviewer submission never completes or reassigns the
original task. Reopening a review for corrections shows its execution state
instead of presenting its earlier opinion as finished.

## Artifacts

Delivery files open in the editor using the recorded worktree resource, author
directory or project directory. Relative traversal and absolute paths outside
that directory are refused. Unknown locations remain visible with opening
disabled. HTTP and HTTPS links without embedded credentials open externally;
other URL schemes are not accepted. Opening an artifact does not execute it.

## Verification

Rust tests cover snapshot preservation, reviewer independence, stale task state,
working-directory context, retry deduplication, live source revisions and atomic
queue failure. Vitest covers reviewer choices, opinion labels, queue
acknowledgements and artifact navigation. `npm run test:native-reviews` exercises
the real queue, ConPTY, authenticated CLI, panel persistence and artifact opening
against an isolated data directory without a model provider.
Like the other native checks, it uses an existing Playwright installation;
set `YARD_PLAYWRIGHT_MODULE` to that module directory when it is not installed
in the workspace. No test dependency is downloaded.
