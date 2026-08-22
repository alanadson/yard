/**
 * The copy of the irreversible warnings in the Source Control tab.
 *
 * "Are you sure?" teaches people to click "Yes" without reading. What still
 * gets read on the fifth use is the warning that says **what**, **how many**
 * and **what does not come back** — which is why these texts are tested code,
 * not literals scattered inside an `onClick`.
 */

export interface ScmConfirmSpec {
  title: string;
  detail: string;
  /** The verb on the red button. Never "OK": the button has to say what it does. */
  confirmLabel: string;
}

const NO_UNDO = "Isso não dá para desfazer.";

export function discardSpec(paths: string[], untracked: boolean): ScmConfirmSpec {
  const target =
    paths.length === 1 ? `“${paths[0]}”` : `${paths.length} arquivos`;
  if (untracked) {
    return {
      title: `Excluir ${target}?`,
      detail: `O arquivo é novo — não existe em nenhum commit, então será apagado do disco. ${NO_UNDO}`,
      confirmLabel: "Excluir",
    };
  }
  return {
    title: `Descartar as alterações de ${target}?`,
    detail: `O conteúdo volta ao do último commit. ${NO_UNDO}`,
    confirmLabel: "Descartar",
  };
}

export function discardAllSpec(counts: {
  tracked: number;
  untracked: number;
}): ScmConfirmSpec {
  const parts = [
    `${counts.tracked} ${counts.tracked === 1 ? "arquivo volta" : "arquivos voltam"} ao último commit`,
  ];
  if (counts.untracked > 0) {
    parts.push(
      counts.untracked === 1
        ? "1 arquivo novo será apagado do disco"
        : `${counts.untracked} arquivos novos serão apagados do disco`,
    );
  }
  return {
    title: "Descartar todas as alterações?",
    detail: `${parts.join("; ")}. ${NO_UNDO}`,
    confirmLabel: "Descartar tudo",
  };
}

export function branchDeleteSpec(name: string, force: boolean): ScmConfirmSpec {
  return {
    title: `Apagar a branch “${name}”?`,
    detail: force
      ? `Ela tem commits que não estão em nenhuma outra branch — esses commits ficam sem referência. ${NO_UNDO}`
      : "O trabalho dela já está em outra branch; só o ponteiro vai embora.",
    confirmLabel: "Apagar",
  };
}

export function remoteDeleteSpec(name: string, remote: string): ScmConfirmSpec {
  return {
    title: `Apagar “${name}” no servidor?`,
    detail: `A branch some de ${remote}, para você e para outras pessoas. A cópia local continua aqui. ${NO_UNDO}`,
    confirmLabel: "Apagar no servidor",
  };
}

export function resetSpec(hash: string, mode: "soft" | "mixed" | "hard"): ScmConfirmSpec {
  const theTitle = `Voltar a branch até ${hash}?`;
  if (mode === "soft") {
    return {
      title: theTitle,
      detail:
        "Os commits depois dele são desfeitos, mas tudo o que eles mudaram fica preparado, pronto para virar outro commit.",
      confirmLabel: "Voltar",
    };
  }
  if (mode === "mixed") {
    return {
      title: theTitle,
      detail:
        "Os commits depois dele são desfeitos e as mudanças ficam nos arquivos, fora da área preparada.",
      confirmLabel: "Voltar",
    };
  }
  return {
    title: theTitle,
    detail: `Tudo o que veio depois dele se perde — commits, arquivos preparados e alterações no disco. ${NO_UNDO}`,
    confirmLabel: "Voltar jogando fora",
  };
}

export function stashDropSpec(message: string): ScmConfirmSpec {
  return {
    title: `Descartar “${message}”?`,
    detail: `O guardado sai da pilha e não aparece em lugar nenhum da interface. ${NO_UNDO}`,
    confirmLabel: "Descartar",
  };
}
