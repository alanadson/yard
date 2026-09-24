import { ROLE_NAME_MAX } from "./canvas";
import { t } from "./i18n";

export function roleDraftError(
  name: string,
  text: string,
): { field: "name" | "text"; message: string } | null {
  if (!name.trim())
    return {
      field: "name",
      message: t("Dê um nome ao papel para identificá-lo no cartão."),
    };
  if (name.trim().length > ROLE_NAME_MAX)
    return {
      field: "name",
      message: t("Use no máximo {max} caracteres no nome.", {
        max: ROLE_NAME_MAX,
      }),
    };
  if (!text.trim())
    return {
      field: "text",
      message: t("Escreva as instruções que este agente deve seguir."),
    };
  return null;
}
