/**
 * English lines of the zustand stores and the hooks (`src/stores`,
 * `src/hooks`): the toasts and confirms they raise, the labels they compute.
 * Split off `lib.ts` so two people can write at once. Key = the PT-BR
 * sentence as written.
 */
export default {
  // hooks/useGlobalEvents — the native balloon when an agent stops
  "{title} está esperando você em {project}: {ask}": "{title} is waiting for you in {project}: {ask}",
  "{title} está esperando você: {ask}": "{title} is waiting for you: {ask}",
  "{title} terminou em {project}.": "{title} finished in {project}.",
  "{title} terminou.": "{title} finished.",

  // hooks/useGrabMode
  "Não consegui armar o modo design: {reason}": "Couldn't arm design mode: {reason}",

  // hooks/useRoutines
  'A rotina [{id}] não chegou em "{target}": {reason}. Continua agendada.':
    'Routine [{id}] did not reach "{target}": {reason}. It stays scheduled.',

  // hooks/useTriggers
  "Yard — gatilho": "Yard — trigger",
  "(CLI removida)": "(CLI removed)",
  "a CLI alvo não existe mais": "the target CLI no longer exists",
  indisponível: "unavailable",
  "o fluxo não existe mais neste grupo": "the flow no longer exists in this group",
  "O gatilho [{id}] não completou: {reason}": "Trigger [{id}] did not complete: {reason}",

  // stores/autoBackupStore
  "Backup automático gravado ({kb} KB).": "Automatic backup written ({kb} KB).",
  "Backup automático falhou: {reason}": "Automatic backup failed: {reason}",

  // stores/benchStore — prompts and the due-date pill
  "Sem título": "Untitled",
  "{title} (cópia)": "{title} (copy)",
  jan: "Jan",
  fev: "Feb",
  mar: "Mar",
  abr: "Apr",
  mai: "May",
  jun: "Jun",
  jul: "Jul",
  ago: "Aug",
  set: "Sep",
  out: "Oct",
  nov: "Nov",
  dez: "Dec",
  janeiro: "January",
  fevereiro: "February",
  março: "March",
  abril: "April",
  maio: "May",
  junho: "June",
  julho: "July",
  agosto: "August",
  setembro: "September",
  outubro: "October",
  novembro: "November",
  dezembro: "December",
  dom: "Sun",
  seg: "Mon",
  ter: "Tue",
  qua: "Wed",
  qui: "Thu",
  sex: "Fri",
  sáb: "Sat",
  "{day} de {month} de {year}": "{month} {day}, {year}",
  "{day}/{month}": "{month} {day}",
  ontem: "yesterday",
  atrasada: "overdue",
  hoje: "today",
  amanhã: "tomorrow",
  "Venceu em {date}": "Was due on {date}",
  "Vence hoje, {date}": "Due today, {date}",
  "Vence amanhã, {date}": "Due tomorrow, {date}",
  "Vence em {date}": "Due on {date}",

  // stores/editorStore — the unsaved-files warning appended to confirms
  " e mais {n}": " and {n} more",
  "Atenção: {n} arquivo(s) aberto(s) com alterações não salvas vão junto ({names}). Salve antes se quiser manter o texto.":
    "Heads up: {n} open file(s) with unsaved changes go with it ({names}). Save first if you want to keep the text.",

  // stores/flowStore — INTERRUPTED (a persisted marker; rendered through t())
  "a interface foi recarregada no meio da esteira — as etapas seguintes não foram enviadas. A CLI continua com o que já recebeu; rode o fluxo de novo a partir daqui se ainda fizer sentido.":
    "the interface was reloaded midway through the pipeline — the following stages were not sent. The CLI keeps what it already received; run the flow again from here if it still makes sense.",

  // stores/lspStore
  "{program} encerrou (código {code})": "{program} exited (code {code})",
  'O servidor de linguagem {program} parou. Reabra o arquivo depois de "Procurar de novo" em Configurações → Editor.':
    'The language server {program} stopped. Reopen the file after "Search again" in Settings → Code editor.',
  "Não consegui iniciar {program}: {reason}": "Couldn't start {program}: {reason}",

  // stores/notesStore
  "Abra um grupo antes de pôr as anotações numa aba.": "Open a group before docking the notes in a tab.",
  "Este grupo está mostrando o canvas, que não tem barra de abas — volte para os painéis ou use a área central.":
    "This group is showing the canvas, which has no tab bar — go back to the panes or use the central area.",
  "Novo caderno": "New notebook",

  // stores/projectsStore
  "Outra instância do Yard gravou este workspace — recarreguei do disco, e o que estava só aqui na tela se perdeu.":
    "Another Yard instance wrote this workspace — it was reloaded from disk, and what lived only here on screen is gone.",
  "Grupo {n}": "Group {n}",

  // stores/reviewStore — REVIEW_FULL (a constant; the caller shows t(REVIEW_FULL))
  "A revisão já tem 400 anotações neste worktree — envie ou limpe antes de anotar mais.":
    "The review already holds 400 annotations in this worktree — send or clear it before adding more.",

  // stores/scmStore
  "Escreva a mensagem do commit": "Write the commit message",
  commitando: "committing",
} satisfies Record<string, string>;
