/**
 * Yard's keyboard map, in a single place.
 *
 * It exists because the whole app is driven from the keyboard: without a
 * list, the shortcuts only live in some button's `title` — and the ones that
 * matter most (switching tab, switching group) have no button at all.
 *
 * The table used to live inside `ShortcutsModal`. It moved out when the
 * Shortcuts category of Settings started showing a summary of it: two
 * hand-written lists drift apart, and a help screen that lies is worse than
 * no screen. The full list stays on `Ctrl+Shift+H`; the screen asks for the
 * groups by title (`gruposChamados`), and `shortcuts.test.ts` locks in the
 * promise.
 */

export type Shortcut = [teclas: string[], descricao: string];

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Janela",
    items: [
      [["Ctrl", "P"], "Busca — agentes, arquivos, notas, portais e ações"],
      [["Ctrl", "T"], "Nova aba — CLI ou navegador"],
      [["Ctrl", "Enter"], "Compositor de prompts da CLI em foco"],
      [
        ["Ctrl", "Shift", "Enter"],
        "O mesmo compositor — e, dentro dele, deixa o texto na linha da CLI sem enviar",
      ],
      [["Ctrl", "B"], "Mostrar ou esconder a barra lateral"],
      [["Ctrl", "Shift", "B"], "Bancada — arquivos, busca, tarefas e prompts"],
      [["Ctrl", "Shift", "E"], "Árvore de arquivos do projeto"],
      [["Ctrl", "Shift", "R"], "Controle de versão — preparar, commitar, branches"],
      [
        ["Ctrl", "Shift", "F"],
        "Buscar no projeto inteiro (com um terminal em foco, busca no histórico dele)",
      ],
      [["Ctrl", "Shift", "D"], "Painel de arquivos e alterações"],
      [["Ctrl", "Shift", "N"], "Anotações — o caderno de notas markdown"],
      [["Ctrl", "Shift", "P"], "Configurações"],
      [["Ctrl", "Shift", "X"], "Extensões — a loja de recursos do Yard"],
      [["Ctrl", "Shift", "A"], "Ir para o próximo agente que está esperando você"],
      [["Ctrl", "Shift", "W"], "Fechar a aba em foco (CLI, arquivo, navegador ou notas)"],
      [["Ctrl", "Shift", "H"], "A lista completa de atalhos"],
    ],
  },
  {
    title: "Nas anotações (Ctrl+Shift+N)",
    items: [
      [["Ctrl", "N"], "Nova nota (nasce na coleção aberta)"],
      [["Ctrl", "Shift", "F"], "Ir para a busca — tag: caderno: status: e -termo filtram"],
      [["↑", "↓"], "Percorrer a lista de notas (Delete manda para a lixeira)"],
      [["Ctrl", "V"], "Colar imagem dentro da nota"],
      [["Esc"], "Fechar (tudo já está salvo — a nota grava enquanto você digita)"],
    ],
  },
  {
    title: "Navegação",
    items: [
      [["Ctrl", "Tab"], "Próxima aba do painel em foco (CLIs, arquivos, navegador e anotações)"],
      [["Ctrl", "Shift", "Tab"], "Aba anterior"],
      [["Ctrl", "1"], "Ir para a aba 1 (até Ctrl+9)"],
      [["Ctrl", "Shift", "1"], "Focar o painel 1 (até Ctrl+Shift+6)"],
      [["Ctrl", "Shift", "G"], "Próximo grupo do projeto"],
    ],
  },
  {
    title: "No editor de código",
    items: [
      [["Ctrl", "S"], "Salvar o arquivo"],
      [["Ctrl", "F"], "Buscar dentro do arquivo (com regex, se quiser)"],
      [["Ctrl", "H"], "Buscar e substituir (a mesma barra, já aberta embaixo)"],
      [["Ctrl", "G"], "Ir para a linha"],
      [["Ctrl", "D"], "Selecionar a próxima ocorrência (multi-cursor)"],
      [["Alt", "clique"], "Cursor extra onde clicar"],
      [["Ctrl", "/"], "Comentar ou descomentar a linha"],
      [["Alt", "↑"], "Mover a linha (Alt+↓ desce · Shift+Alt copia)"],
      [["Ctrl", "Shift", "K"], "Apagar a linha"],
      [["Ctrl", "Space"], "Completar a palavra"],
      [["Ctrl", "Tab"], "O arquivo é uma aba do painel: alterna com as CLIs"],
      [["Esc"], "No canvas, encosta o editor (os arquivos continuam abertos)"],
      [["F2"], "Renomear o item selecionado na árvore"],
    ],
  },
  {
    // Same keys as a note's bar: the same gesture means the same thing
    // whether the markdown is on the canvas or in a file.
    title: "Escrevendo markdown (.md)",
    items: [
      [["Ctrl", "1"], "Título 1 … Ctrl+6 o menor · Ctrl+0 volta a parágrafo"],
      [["Ctrl", "B"], "Negrito · Ctrl+I itálico · Ctrl+E código na linha"],
      [["Ctrl", "Shift", "X"], "Riscado · Ctrl+Shift+H marca-texto"],
      [["Ctrl", "K"], "Link · Ctrl+Shift+I imagem"],
      [["Ctrl", "Shift", "8"], "Lista · Ctrl+Shift+7 numerada · Ctrl+Shift+9 tarefas"],
      [["Ctrl", "Shift", "."], "Citação · Ctrl+Shift+C bloco de código"],
      [["Ctrl", "Shift", "T"], "Tabela · Ctrl+Shift+F nota de rodapé"],
      [["Ctrl", "Shift", "−"], "Linha divisória · Ctrl+\\ limpa a formatação"],
      [["Ctrl", "Enter"], "Concluir ou reabrir a tarefa da linha"],
      [["Ctrl", "Shift", "D"], "Duplicar a linha · Alt+↑ e Alt+↓ movem"],
      [["Enter"], "Continua a lista; numa linha vazia, sai dela"],
      [["Tab"], "Recuar o item (Shift+Tab tira o recuo)"],
    ],
  },
  {
    title: "No terminal",
    items: [
      [["Ctrl", "Shift", "F"], "Buscar no histórico do painel"],
      [["Ctrl", "C"], "Copiar quando há seleção; interromper quando não há"],
      [["Ctrl", "Shift", "C"], "Copiar a seleção"],
      [["Ctrl", "V"], "Colar (o botão direito abre o menu, não cola sozinho)"],
      [["Shift", "Insert"], "Colar"],
      [["Ctrl", "V"], "Colar imagem: vira arquivo e o agente recebe o caminho"],
    ],
  },
  {
    title: "No canvas — ferramentas",
    items: [
      [["V"], "Selecionar · H mão · P caneta · E borracha"],
      [["R"], "Retângulo · O elipse · L linha · A seta"],
      [["T"], "Texto · N nota · W portal · C conectar · F fluxo"],
      [["[", "]"], "Traço mais fino / mais grosso"],
      [["Ctrl", "Z"], "Desfazer (Ctrl+Y refaz)"],
    ],
  },
  {
    title: "No canvas — seleção",
    items: [
      [["arrastar"], "No fundo vazio: laço de seleção"],
      [["Shift", "clique"], "Somar ou tirar da seleção"],
      [["Ctrl", "A"], "Selecionar tudo"],
      [["Tab"], "Percorrer os elementos um a um (Shift volta)"],
      [["setas"], "Mover a seleção (Shift anda 10×)"],
      [["Alt", "arrastar"], "Duplicar arrastando"],
      [["Ctrl", "arrastar"], "Arrastar sem o ímã de alinhamento"],
      [["Ctrl", "D"], "Duplicar · Ctrl+C copia · Ctrl+X recorta · Ctrl+V cola"],
      [["Ctrl", "Shift", "T"], "Organizar em grade (de novo troca o layout)"],
      [["Delete"], "Apagar o que está selecionado (cartões não)"],
    ],
  },
  {
    title: "Escrevendo numa nota",
    items: [
      [["Ctrl", "1"], "Título 1 · Ctrl+2 e Ctrl+3 os menores · Ctrl+0 volta a parágrafo"],
      [["Ctrl", "B"], "Negrito · Ctrl+I itálico · Ctrl+E código na linha"],
      [["Ctrl", "Shift", "X"], "Riscado · Ctrl+Shift+H marca-texto"],
      [["Ctrl", "K"], "Link (vira um portal quando clicado na nota)"],
      [["Ctrl", "Shift", "8"], "Lista · Ctrl+Shift+7 numerada · Ctrl+Shift+9 tarefas"],
      [["Ctrl", "Shift", "."], "Citação · Ctrl+Shift+C bloco de código"],
      [["Ctrl", "Shift", "−"], "Linha divisória · Ctrl+\\ limpa a formatação"],
      [["Tab"], "Recuar o item (Shift+Tab tira o recuo)"],
      [["Enter"], "Continua a lista; numa linha vazia, sai dela"],
      [["Ctrl", "Enter"], "Concluir ou reabrir a tarefa da linha"],
      [["Ctrl", "Shift", "D"], "Duplicar a linha · Alt+↑ e Alt+↓ movem"],
      [["Esc"], "Fechar a nota (o markdown é renderizado)"],
    ],
  },
  {
    title: "No canvas — câmera",
    items: [
      [["Ctrl", "roda"], "Zoom no cursor (roda sozinha desloca a tela)"],
      [["Ctrl", "0"], "Zoom 100% (Ctrl+= aproxima, Ctrl+− afasta)"],
      [["Shift", "1"], "Enquadrar tudo · Shift+2 enquadra a seleção"],
      [["Ctrl", "Shift", "M"], "Mostrar ou esconder o minimapa"],
      [["Ctrl", "Alt", "→"], "Andar pelo fio até o próximo conectado (← volta)"],
      [["Espaço", "arrastar"], "Mover a tela com qualquer ferramenta"],
      [["2× clique"], "No cabeçalho de um cartão: centralizar em 100%"],
      [["arrastar"], "No corpo de uma nota: mover"],
      [["clique"], "Na nota: seleciona; clicar de novo (ou 2×) abre a edição"],
    ],
  },
];

/**
 * The groups the Shortcuts category of Settings shows — the three that apply
 * to the whole window. The rest (editor, markdown, canvas) is fine print for
 * whoever is already inside that surface, and the screen points to the full
 * list instead of repeating everything.
 */
export const SETTINGS_SHORTCUTS: readonly string[] = [
  "Janela",
  "Navegação",
  "No terminal",
];

/** The requested groups, in the requested order; an unknown title is left out. */
export function groupsNamed(names: readonly string[]): ShortcutGroup[] {
  const byTitle = new Map(SHORTCUT_GROUPS.map((g) => [g.title, g]));
  return names.flatMap((n) => {
    const g = byTitle.get(n);
    return g ? [g] : [];
  });
}
