import { useEffect, useState } from "react";
import { FileImage } from "lucide-react";
import { loadAttachmentPreview } from "./preview";
import { useT } from "../../hooks/useT";

export function AttachmentImage({
  root,
  name,
}: {
  root: string;
  name: string;
}) {
  const t = useT();
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setSource(null);
    setFailed(false);
    void loadAttachmentPreview(root, name)
      .then((url) => {
        if (current) setSource(url);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [root, name]);
  return source && !failed ? (
    <img src={source} alt={name} onError={() => setFailed(true)} />
  ) : (
    <span title={failed ? t("Prévia indisponível") : t("Carregando prévia…")}>
      <FileImage size={24} />
    </span>
  );
}
