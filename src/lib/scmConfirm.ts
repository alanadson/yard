/**
 * The copy of the irreversible warnings in the Source Control tab.
 *
 * "Are you sure?" teaches people to click "Yes" without reading. What still
 * gets read on the fifth use is the warning that says **what**, **how many**
 * and **what does not come back** — which is why these texts are tested code,
 * not literals scattered inside an `onClick`.
 */
import { t, tn } from "./i18n";

export interface ScmConfirmSpec {
  title: string;
  detail: string;
  /** The verb on the red button. Never "OK": the button has to say what it does. */
  confirmLabel: string;
}

const NO_UNDO = "Isso não dá para desfazer."; // i18n-ok

export function discardSpec(paths: string[], untracked: boolean): ScmConfirmSpec {
  const target =
    paths.length === 1 ? `“${paths[0]}”` : tn(paths.length, "{n} arquivo", "{n} arquivos");
  if (untracked) {
    return {
      title: t("Excluir {target}?", { target }),
      detail: `${t("O arquivo é novo — não existe em nenhum commit, então será apagado do disco.")} ${t(NO_UNDO)}`, // i18n-ok
      confirmLabel: t("Excluir"),
    };
  }
  return {
    title: t("Descartar as alterações de {target}?", { target }),
    detail: `${t("O conteúdo volta ao do último commit.")} ${t(NO_UNDO)}`, // i18n-ok
    confirmLabel: t("Descartar"),
  };
}

export function discardAllSpec(counts: {
  tracked: number;
  untracked: number;
}): ScmConfirmSpec {
  const parts = [
    tn(counts.tracked, "{n} arquivo volta ao último commit", "{n} arquivos voltam ao último commit"),
  ];
  if (counts.untracked > 0) {
    parts.push(
      tn(counts.untracked, "{n} arquivo novo será apagado do disco", "{n} arquivos novos serão apagados do disco"),
    );
  }
  return {
    title: t("Descartar todas as alterações?"),
    detail: `${parts.join("; ")}. ${t(NO_UNDO)}`, // i18n-ok
    confirmLabel: t("Descartar tudo"),
  };
}

export function branchDeleteSpec(name: string, force: boolean): ScmConfirmSpec {
  return {
    title: t("Apagar a branch “{name}”?", { name }),
    detail: force
      ? `${t("Ela tem commits que não estão em nenhuma outra branch — esses commits ficam sem referência.")} ${t(NO_UNDO)}` // i18n-ok
      : t("O trabalho dela já está em outra branch; só o ponteiro vai embora."),
    confirmLabel: t("Apagar"),
  };
}

export function remoteDeleteSpec(name: string, remote: string): ScmConfirmSpec {
  return {
    title: t("Apagar “{name}” no servidor?", { name }),
    detail: `${t("A branch some de {remote}, para você e para outras pessoas. A cópia local continua aqui.", { remote })} ${t(NO_UNDO)}`, // i18n-ok
    confirmLabel: t("Apagar no servidor"),
  };
}

export function resetSpec(hash: string, mode: "soft" | "mixed" | "hard"): ScmConfirmSpec {
  const theTitle = t("Voltar a branch até {hash}?", { hash });
  if (mode === "soft") {
    return {
      title: theTitle,
      detail: t(
        "Os commits depois dele são desfeitos, mas tudo o que eles mudaram fica preparado, pronto para virar outro commit.",
      ),
      confirmLabel: t("Voltar a branch"),
    };
  }
  if (mode === "mixed") {
    return {
      title: theTitle,
      detail: t(
        "Os commits depois dele são desfeitos e as mudanças ficam nos arquivos, fora da área preparada.",
      ),
      confirmLabel: t("Voltar a branch"),
    };
  }
  return {
    title: theTitle,
    detail: `${t("Tudo o que veio depois dele se perde — commits, arquivos preparados e alterações no disco.")} ${t(NO_UNDO)}`, // i18n-ok
    confirmLabel: t("Voltar jogando fora"),
  };
}

export function stashDropSpec(message: string): ScmConfirmSpec {
  return {
    title: t("Descartar “{message}”?", { message }),
    detail: `${t("O guardado sai da pilha e não aparece em lugar nenhum da interface.")} ${t(NO_UNDO)}`, // i18n-ok
    confirmLabel: t("Descartar"),
  };
}
