import { useDeferredValue, useMemo, type ComponentProps } from "react";
import { useT } from "../../hooks/useT";
import { tn } from "../../lib/i18n";
import { useEditor } from "../../stores/editorStore";
import { markdownDocument } from "./markdownDocument";
import { MarkdownPreview } from "./MarkdownPreview";
import { Outline } from "./Outline";

const EMPTY_SOURCE = { text: "" };

/** Only text consumers subscribe to every edit; editor chrome stays stable. */
function useMarkdownDocument(docId: string) {
  const source = useEditor((state) =>
    state.docs.find((doc) => doc.id === docId),
  );
  const deferred = useDeferredValue(source);
  return useMemo(() => markdownDocument(deferred ?? EMPTY_SOURCE), [deferred]);
}

export function LiveMarkdownPreview({
  docId,
  ...props
}: Omit<ComponentProps<typeof MarkdownPreview>, "text" | "blocks"> & {
  docId: string;
}) {
  const model = useMarkdownDocument(docId);
  return <MarkdownPreview {...props} text={model.text} blocks={model.blocks} />;
}

export function MarkdownOutline({
  docId,
  ...props
}: Omit<ComponentProps<typeof Outline>, "entries"> & { docId: string }) {
  const model = useMarkdownDocument(docId);
  return <Outline {...props} entries={model.headings} />;
}

export function MarkdownCounts({ docId }: { docId: string }) {
  const t = useT();
  const { counts } = useMarkdownDocument(docId);
  return (
    <>
      {counts.tasks.total > 0 && (
        <span data-tip={t("Tarefas concluídas neste arquivo")}>
          {t("{done}/{total} tarefas", {
            done: counts.tasks.done,
            total: counts.tasks.total,
          })}
        </span>
      )}
      <span data-tip={t("{n} caracteres", { n: counts.chars })}>
        {tn(counts.words, "{n} palavra", "{n} palavras")}
      </span>
      <span data-tip={t("Tempo de leitura, a 200 palavras por minuto")}>
        {counts.minutes} min
      </span>
    </>
  );
}
