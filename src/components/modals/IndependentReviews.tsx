import { useEffect, useState } from "react";
import { nanoid } from "nanoid";
import { useT } from "../../hooks/useT";
import { useProjects } from "../../stores/projectsStore";
import { ipc } from "../../lib/ipc";
import { queueTaskReview } from "../../lib/taskQueue";
import { baseName } from "../../lib/terminals";
import { deliveryArtifactAction, type DeliveryArtifactAction } from "../../lib/workResources";
import type { ReviewRequest, TaskReview, WorkTask } from "../../lib/work";
import { independentReviewLabel, reviewCandidates, validationResultLabel } from "./workReview";

interface ArtifactProps {
  artifacts: string[];
  root: string | null;
  onOpen: (action: DeliveryArtifactAction) => Promise<void>;
}

export function DeliveryArtifacts({ artifacts, root, onOpen }: ArtifactProps) {
  const t = useT();
  return <ul className="work-artifacts">{artifacts.map((reference, index) => {
    const action = deliveryArtifactAction(reference, root);
    return <li key={`${index}:${reference}`}><button className="btn btn--sm" disabled={!action}
      aria-label={t("Abrir artefato: {name}", { name: reference })} onClick={() => { if (action) void onOpen(action); }}>{reference}</button></li>;
  })}</ul>;
}

interface Props {
  task: WorkTask;
  latestRevision: number;
  root: string | null;
  busy: boolean;
  onPerform: (action: () => Promise<unknown>) => Promise<void>;
  onOpenArtifact: ArtifactProps["onOpen"];
}

export function IndependentReviews({ task, latestRevision, root, busy, onPerform, onOpenArtifact }: Props) {
  const t = useT();
  const terminals = useProjects((state) => state.terminals);
  const candidates = reviewCandidates(task, terminals);
  const [reviewerId, setReviewerId] = useState("");
  const [records, setRecords] = useState<TaskReview[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<{ input: ReviewRequest; deliveryRevision: number } | null>(null);

  useEffect(() => {
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const reviews = await ipc.taskReviews(task.id);
        if (active) { setRecords(reviews); setLoadError(false); }
      } catch { if (active) setLoadError(true); }
      finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [task.id, task.revision]);

  const request = () => void onPerform(async () => {
    if (!candidates.some((terminal) => terminal.id === reviewerId)) return;
    const input = pending?.deliveryRevision === latestRevision && pending.input.terminalId === reviewerId ? pending.input : {
      taskId: task.id, revision: task.revision, reviewId: nanoid(), terminalId: reviewerId, queueId: nanoid(), title: t("Revisão: {title}", { title: task.title }),
    };
    setPending({ input, deliveryRevision: latestRevision });
    await queueTaskReview(input);
    setPending(null);
    setRecords(await ipc.taskReviews(task.id));
  });

  return <section className="work-independent-reviews">
    <h4>{t("Pareceres independentes")}</h4>
    <p className="hint">{t("O parecer fica vinculado a esta entrega. A aprovação final é sua.")}</p>
    {loadError && <p className="hint hint--error" role="alert">{t("Não foi possível carregar os pareceres. Tentando novamente.")}</p>}
    {records.map((review) => <section className="work-review-record" key={review.task.id}>
      <strong>{baseName(terminals.find((terminal) => terminal.id === review.task.links.executorTerminalId) ?? { title: review.task.title, program: "" })}</strong>
      <p className="hint">{t(independentReviewLabel(review, latestRevision))}</p>
      {review.task.delivery && <>
        <p className="work-pre">{review.task.delivery.summary}</p>
        {review.task.delivery.checks.map((check, index) => <p key={index} className={check.passed ? "hint work-pre" : "hint hint--error work-pre"}>
          {check.name}: {t(validationResultLabel(check.passed))}<br />{check.evidence}
        </p>)}
        <DeliveryArtifacts artifacts={review.task.delivery.artifacts} root={root} onOpen={onOpenArtifact} />
      </>}
    </section>)}
    {task.status === "in_review" && <div className="work-send">
      <label>{t("Agente revisor")}<select aria-label={t("Agente revisor")} value={reviewerId} disabled={busy} onChange={(event) => setReviewerId(event.target.value)}>
        <option value="">{t("Escolha um agente")}</option>
        {candidates.map((terminal) => <option key={terminal.id} value={terminal.id}>{baseName(terminal)} ({terminal.cwd})</option>)}
      </select></label>
      {candidates.length === 0 && <p className="hint">{t("Abra outro agente para solicitar uma revisão independente.")}</p>}
      <button className="btn" disabled={busy || loadError || !candidates.some((terminal) => terminal.id === reviewerId)} onClick={request}>{t("Solicitar revisão independente")}</button>
    </div>}
  </section>;
}
