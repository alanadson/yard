import { ipc } from "../../lib/ipc";
import { mediaUrl } from "../../lib/media";

export async function loadAttachmentPreview(
  root: string,
  name: string,
): Promise<string> {
  const file = await ipc.fsReadText(root, name);
  return mediaUrl(root, name, file.modifiedAt);
}
