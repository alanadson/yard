import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}

/** In-place rename field on the tree (Enter confirms, Esc cancels). */
export function InlineRename({ value, onCommit, onCancel }: Props) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (cancelled.current) return;
    const next = draft.trim();
    if (!next || next === value) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      ref={ref}
      className="tree-rename"
      value={draft}
      aria-label="Novo nome"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
    />
  );
}
