/**
 * The Busca's rows come out of a dozen stores, and they used to be one
 * function over sixteen inputs: an agent writing files (the feed moves every
 * 250 ms) rebuilt every one of up to six thousand file rows, icon and all,
 * just to add one line at the top. These tests lock what the list says
 * (order, ids, text, weights, icons) on a workspace that has a bit of
 * everything, so the rows can be built per domain without a single row
 * changing.
 *
 * The em dash the rows join their parts with is printed as `<mdash>` below:
 * the character itself is kept out of the sources.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  // Every command answers "nothing": these tests read rows, they never run one.
  const ipc = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => (name === "then" ? undefined : vi.fn(async () => undefined)),
  });
  return { ...actual, ipc };
});

import { buildEntries, createEntryComposer, type World } from "./index";
import type { PaletteEntry } from "./model";
import type {
  AgentInfo,
  ChangedFile,
  GroupRow,
  ProjectRow,
  TerminalRow,
} from "../../lib/ipc";
import { useAgents } from "../../stores/agentsStore";
import { useBroadcast } from "../../stores/broadcastStore";
import { useChanges } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import { locale, setActiveLang } from "../../lib/i18n";

// ---------------------------------------------------------------------------
// the workspace
// ---------------------------------------------------------------------------

const VIEW = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} };
const BOX = { color: "#888", x: 0, y: 0, w: 200, h: 120 };

function layout(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ mode: "auto", panelCount: 2, activeBySlot: {}, ...extra });
}

const PROJECTS: ProjectRow[] = [
  { id: "p-api", name: "api", path: "C:/w/api", sort: 0, createdAt: 1 },
  { id: "p-web", name: "web", path: "C:/w/web", sort: 1, createdAt: 1 },
];

const GROUPS: GroupRow[] = [
  {
    id: "g-main",
    projectId: "p-api",
    name: "main",
    suspended: false,
    sort: 0,
    layoutJson: layout({
      canvas: {
        ...VIEW,
        items: [],
        roles: { "t-claude": { name: "revisora" } },
        routines: [
          { id: "r1", terminalId: "t-claude", text: "status", everyMin: 30, enabled: true, createdAt: 1 },
          { id: "r2", terminalId: "t-claude", text: "off", everyMin: 30, enabled: false, createdAt: 1 },
        ],
        triggers: [
          {
            id: "tr1",
            sourceId: "*",
            event: "finished",
            action: { kind: "notify", text: "ok" },
            enabled: true,
            createdAt: 1,
          },
        ],
      },
    }),
  },
  {
    id: "g-floor",
    projectId: "p-api",
    name: "feat-x",
    suspended: false,
    sort: 1,
    layoutJson: layout({
      floor: { kind: "isolated", branch: "feat/x", worktreePath: "C:/w/api-feat-x" },
    }),
  },
  { id: "g-web", projectId: "p-web", name: "ui", suspended: false, sort: 2, layoutJson: layout() },
  {
    id: "b-board",
    projectId: null,
    name: "Quadro",
    suspended: false,
    sort: 3,
    layoutJson: layout({
      canvas: {
        ...VIEW,
        items: [
          { ...BOX, type: "note", id: "n1", text: "# Deploy\nos passos", locked: true },
          { ...BOX, type: "note", id: "n2", text: "" },
          { ...BOX, type: "binder", id: "bd1", notes: ["n1", "n2"] },
          { ...BOX, type: "tree", id: "tr1", path: "", mode: "list" },
          { ...BOX, type: "tree", id: "tr2", path: "src/lib", mode: "list", root: "C:/w/api" },
          { ...BOX, type: "media", id: "m1", path: "assets/logo.png", root: "C:/w/web" },
          { ...BOX, type: "doc", id: "d1", path: "docs/guide.md" },
          { ...BOX, type: "group", id: "fr1", name: "Frontend" },
          { ...BOX, type: "portal", id: "po1", url: "http://localhost:5173/app", engine: "chrome" },
          { ...BOX, type: "rect", id: "x1", size: "m", seed: 1 },
        ],
      },
    }),
  },
];

function term(row: Partial<TerminalRow> & Pick<TerminalRow, "id" | "groupId" | "program">): TerminalRow {
  return {
    slot: 0,
    kind: "agent",
    args: [],
    cwd: "C:/w/api",
    sort: 0,
    alive: true,
    createdAt: 1,
    ...row,
  };
}

const TERMINALS: TerminalRow[] = [
  term({ id: "t-claude", groupId: "g-main", program: "claude", agentId: "claude", title: "Claude", args: ["--continue"] }),
  term({ id: "t-shell", groupId: "g-main", program: "pwsh.exe", kind: "shell", title: null }),
  term({ id: "t-codex", groupId: "g-web", program: "codex", agentId: "codex", title: "codex web", cwd: "C:/w/web" }),
  term({ id: "t-card", groupId: "b-board", program: "claude", agentId: "claude", title: "cartão" }),
];

/** Midnight of a local day: what `BenchTask.dueAt` holds. */
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

function fixture(): World {
  useProjects.setState({
    projects: PROJECTS,
    groups: GROUPS,
    terminals: TERMINALS,
    activeProjectId: "p-api",
    activeGroupId: "g-main",
    canvasSide: false,
  });
  return {
    projects: PROJECTS,
    groups: GROUPS,
    terminals: TERMINALS,
    activeGroupId: "g-main",
    activeProjectId: "p-api",
    runtimes: {
      "t-claude": { state: "running", finished: true, unread: false, blocked: false },
      "t-shell": { state: "exited", finished: false, unread: false, blocked: false },
      "t-codex": { state: "running", finished: false, unread: true, blocked: true },
    },
    gitByProject: {
      "p-api": {
        isRepo: true,
        branch: "main",
        additions: 3,
        deletions: 1,
        uncounted: 0,
        files: [
          changed("src/a.ts", "modified"),
          changed("src/b.ts", "added"),
        ],
      },
      "p-web": {
        isRepo: true,
        branch: "main",
        additions: 0,
        deletions: 0,
        uncounted: 0,
        files: [changed("web.ts", "modified")],
      },
    },
    liveByProject: {
      "p-api": [
        { path: "src/b.ts", kind: "modified", at: 3, count: 1 },
        { path: "gen/out.js", kind: "created", at: 2, count: 2 },
        { path: "src/c.ts", kind: "modified", at: 1, count: 1 },
      ],
    },
    dirs: {
      "": [dirEntry("src", "src", true), dirEntry("README.md", "README.md")],
      src: [dirEntry("a.ts", "src/a.ts"), dirEntry("c.ts", "src/c.ts"), dirEntry("d.ts", "src/d.ts")],
    },
    fileIndex: ["README.md", "src/a.ts", "src/d.ts", "src/e.ts", "docs/f.md"],
    prompts: [
      prompt("pr1", "Revisar PR", "Revise o diff\ncom cuidado", ["review"], true),
      prompt("pr2", "Resumo", "Resuma o dia", [], false),
    ],
    tasks: [
      task("k1", "feita", { done: true }),
      task("k2", "migrar banco", { priority: 2, dueAt: day(2020, 0, 1) }),
      task("k3", "tela nova", { projectId: "p-web", dueAt: day(2099, 5, 15) }),
      task("k4", "testes", { priority: 3, projectId: "p-api" }),
    ],
    served: {
      "t-shell": [{ origin: "http://localhost:5173", host: "localhost", port: 5173, kind: "loopback", at: 1 }],
      "t-codex": [
        { origin: "http://127.0.0.1:3000", host: "127.0.0.1", port: 3000, kind: "loopback", at: 1 },
        { origin: "http://192.168.0.2:8080", host: "192.168.0.2", port: 8080, kind: "private", at: 1 },
      ],
    },
    focusedTerminalId: "t-claude",
    memos: [
      memo("m-gone", "apagada", "x", { deletedAt: 5 }),
      memo("m1", "Ideias", "corpo da nota", { notebookId: "nb-child", status: "active", pinned: true }),
      memo("m2", "  ", "\n# Primeira linha\nresto", {}),
    ],
    memoBooks: [
      { id: "nb-root", name: "Trabalho", parentId: null, icon: null, sort: 0 },
      { id: "nb-child", name: "Yard", parentId: "nb-root", icon: null, sort: 0 },
    ],
  };
}

function changed(path: string, status: ChangedFile["status"]): ChangedFile {
  return {
    path,
    origPath: null,
    status,
    staged: false,
    additions: 1,
    deletions: 0,
    binary: false,
  } as ChangedFile;
}

function dirEntry(name: string, path: string, dir = false) {
  return { name, path, dir, size: 0, modifiedAt: 0, symlink: false };
}

function prompt(id: string, title: string, body: string, tags: string[], pinned: boolean) {
  return { id, title, body, tags, pinned, createdAt: 1, updatedAt: 1, uses: 0, lastUsedAt: null };
}

function task(id: string, text: string, extra: Partial<World["tasks"][number]>): World["tasks"][number] {
  return {
    id,
    text,
    done: false,
    priority: 0,
    createdAt: 1,
    doneAt: null,
    projectId: null,
    dueAt: null,
    ...extra,
  };
}

function memo(id: string, title: string, body: string, extra: Partial<World["memos"][number]>) {
  return {
    id,
    title,
    body,
    notebookId: null,
    tags: [],
    status: "none" as const,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// a row, as text
// ---------------------------------------------------------------------------

function iconOf(icon: ReactNode): string {
  if (icon === undefined) return "-";
  if (!isValidElement(icon)) return String(icon);
  const type = icon.type as string | { displayName?: string; name?: string };
  const name = typeof type === "string" ? type : (type.displayName ?? type.name);
  return `${name}${JSON.stringify(icon.props)}`;
}

/** Everything a row shows or is searched by, on one line. */
function line(e: PaletteEntry): string {
  return [
    e.id,
    e.kind,
    e.title,
    e.subtitle ?? "-",
    JSON.stringify(e.keywords ?? null),
    e.hint ?? "-",
    e.weight ?? "-",
    iconOf(e.icon),
    Object.keys(e).sort().join(","),
  ]
    .join(" | ")
    .replaceAll("\u2014", "<mdash>");
}

beforeEach(() => {
  useBroadcast.setState({ groupId: "g-main" });
  useAgents.setState({ byId: { claude: { sessionsKind: "claude" } as unknown as AgentInfo } });
});

describe("buildEntries", () => {
  it("lists every domain in the order, text, weight and icon the Busca has always shown", () => {
    expect(buildEntries(fixture()).map(line).join("\n")).toMatchInlineSnapshot(`
      "terminal:t-claude | terminal | Claude | api · main <mdash> revisora | ["claude","claude","C:/w/api","revisora","--continue"] | - | 780 | CircleDot{"size":14,"className":"busca-dot busca-dot--waiting"} | icon,id,keywords,kind,run,subtitle,title,weight
      terminal:t-shell | terminal | pwsh.exe | api · main | ["pwsh.exe","","C:/w/api",""] | - | 600 | CircleDot{"size":14,"className":"busca-dot"} | icon,id,keywords,kind,run,subtitle,title,weight
      terminal:t-codex | terminal | codex web | web · ui | ["codex","codex","C:/w/web",""] | - | 270 | CircleDot{"size":14,"className":"busca-dot busca-dot--waiting"} | icon,id,keywords,kind,run,subtitle,title,weight
      terminal:t-card | terminal | cartão | Quadro | ["claude","claude","C:/w/api",""] | - | 0 | CircleDot{"size":14,"className":"busca-dot"} | icon,id,keywords,kind,run,subtitle,title,weight
      group:g-main | group | main | api | ["grupo group",""] | - | 600 | - | id,keywords,kind,run,subtitle,title,weight
      group:g-floor | group | feat-x | api · frente · feat/x | ["frente front floor worktree","feat/x"] | - | 300 | - | id,keywords,kind,run,subtitle,title,weight
      group:g-web | group | ui | web | ["grupo group",""] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      group:b-board | group | Quadro |  | ["grupo group",""] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      project:p-api | project | api | C:/w/api | ["projeto project","C:/w/api"] | - | 300 | - | id,keywords,kind,run,subtitle,title,weight
      project:p-web | project | web | C:/w/web | ["projeto project","C:/w/web"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      url:t-shell:http://localhost:5173 | url | http://localhost:5173 | servido por pwsh.exe <mdash> api · main | ["porta","port","5173","localhost","servidor","server","portal"] | abrir portal | 660 | - | hint,id,keywords,kind,run,subtitle,title,weight
      url:t-codex:http://127.0.0.1:3000 | url | http://127.0.0.1:3000 | servido por codex web <mdash> web · ui | ["porta","port","3000","localhost","servidor","server","portal"] | abrir portal | 60 | - | hint,id,keywords,kind,run,subtitle,title,weight
      url:t-codex:http://192.168.0.2:8080 | url | http://192.168.0.2:8080 | servido por codex web <mdash> web · ui | ["porta","port","8080","localhost","servidor","server","portal"] | abrir portal | 60 | - | hint,id,keywords,kind,run,subtitle,title,weight
      note:n1 | note | Deploy | Quadro | ["# Deploy\\nos passos","travada locked"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      note:n2 | note | nota sem título | Quadro | ["",""] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      binder:bd1 | binder | Fichário | 2 nota(s) <mdash> Quadro | ["fichario abas notas binder tabs notes"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      tree:tr1 | tree | Arquivos | raiz <mdash> Quadro | ["","arvore arquivos explorador tree files explorer"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      tree:tr2 | tree | lib | src/lib <mdash> Quadro | ["src/lib","arvore arquivos explorador tree files explorer"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      media:m1 | media | logo.png | assets/logo.png <mdash> Quadro | ["assets/logo.png","C:/w/web","arquivo canvas midia file media"] | - | 0 | FileGlyph{"name":"logo.png","size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      doc:d1 | media | guide.md | docs/guide.md <mdash> Quadro | ["docs/guide.md","","arquivo canvas documento editor doc"] | - | 0 | FileGlyph{"name":"guide.md","size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      frame:fr1 | frame | Frontend | Quadro | ["grupo moldura canvas group frame"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      portal:po1 | portal | localhost | http://localhost:5173/app <mdash> Quadro | ["http://localhost:5173/app","chrome","portal navegador browser"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      file:src/a.ts | file | a.ts | src/a.ts | ["modified","alterado git changed"] | - | 600 | FileGlyph{"name":"a.ts","size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      file:src/b.ts | file | b.ts | src/b.ts | ["added","alterado git changed"] | - | 600 | FileGlyph{"name":"b.ts","size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      file:gen/out.js | file | out.js | gen/out.js | ["tocado recente feed touched recent"] | - | 300 | FileGlyph{"name":"out.js","size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      file:src/c.ts | file | c.ts | src/c.ts | ["tocado recente feed touched recent"] | - | 300 | FileGlyph{"name":"c.ts","size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      file:README.md | file | README.md | README.md | null | - | 0 | FileGlyph{"name":"README.md","size":14} | icon,id,kind,run,subtitle,title,weight
      file:src/d.ts | file | d.ts | src/d.ts | null | - | 0 | FileGlyph{"name":"d.ts","size":14} | icon,id,kind,run,subtitle,title,weight
      file:src/e.ts | file | e.ts | src/e.ts | null | - | 0 | FileGlyph{"name":"e.ts","size":14} | icon,id,kind,run,subtitle,title,weight
      file:docs/f.md | file | f.md | docs/f.md | null | - | 0 | FileGlyph{"name":"f.md","size":14} | icon,id,kind,run,subtitle,title,weight
      prompt:pr1 | prompt | Revisar PR | Revise o diff | ["review","Revise o diff\\ncom cuidado"] | compositor | 300 | - | hint,id,keywords,kind,run,subtitle,title,weight
      prompt:pr2 | prompt | Resumo | Resuma o dia | ["Resuma o dia"] | compositor | 0 | - | hint,id,keywords,kind,run,subtitle,title,weight
      task:k2 | task | migrar banco | !! · atrasada · global | ["tarefa bancada task bench","global"] | - | 300 | - | id,keywords,kind,run,subtitle,title,weight
      task:k3 | task | tela nova | 15/jun · web | ["tarefa bancada task bench","web"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      task:k4 | task | testes | !!! · api | ["tarefa bancada task bench","api"] | - | 300 | - | id,keywords,kind,run,subtitle,title,weight
      memo:m1 | memo | Ideias | Trabalho / Yard · ativa | ["corpo da nota","anotacao caderno note notebook"] | - | 300 | - | id,keywords,kind,run,subtitle,title,weight
      memo:m2 | memo | Primeira linha | sem caderno | ["\\n# Primeira linha\\nresto","anotacao caderno note notebook"] | - | 0 | - | id,keywords,kind,run,subtitle,title,weight
      action:new-terminal | action | Nova aba | CLI, shell ou navegador no grupo ativo | ["criar","cli","claude","codex","shell","terminal","navegador","new tab","browser"] | Ctrl+T | 40 | - | hint,id,keywords,kind,run,subtitle,title,weight
      action:new-portal | action | Novo portal | navegador no canvas | ["criar","browser","site","url","new portal","web"] | - | 20 | - | id,keywords,kind,run,subtitle,title,weight
      action:new-browser-tab | action | Novo navegador no painel | aba de browser ao lado das CLIs | ["criar","browser","navegador","aba","site","url","new browser tab"] | - | 20 | - | id,keywords,kind,run,subtitle,title,weight
      action:new-project | action | Adicionar projeto | abrir uma pasta como projeto | ["criar","pasta","repositorio","add project","folder","repository"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:new-floor | action | Nova frente | worktree isolado para uma tarefa | ["criar","floor","worktree","branch","git","new floor"] | - | 20 | - | id,keywords,kind,run,subtitle,title,weight
      action:new-task | action | Nova tarefa | mesmo pedido para N agentes, cada um na sua frente | ["fanout","fan-out","frota","paralelo","worktree","tarefa","new task","fleet","parallel"] | - | 25 | - | id,keywords,kind,run,subtitle,title,weight
      action:compare-floors | action | Comparar frentes | diffstat lado a lado e aterrissar o vencedor | ["merge","aterrissar","land","vencedor","diff","compare floors","winner"] | - | 24 | - | id,keywords,kind,run,subtitle,title,weight
      action:journal | action | Diário de hoje | commits, agentes e custo do dia numa nota nova | ["journal","diario","diário","resumo","dia","today","log"] | - | 12 | - | id,keywords,kind,run,subtitle,title,weight
      action:composer | action | Compositor de prompts | escrever um prompt longo fora do terminal | ["prompt","escrever","enviar","composer","write","send"] | Ctrl+Enter | 30 | - | hint,id,keywords,kind,run,subtitle,title,weight
      action:bench | action | Bancada | tarefas e biblioteca de prompts | ["painel","prompts","tarefas","bench","tasks","panel"] | Ctrl+Shift+B | - | - | hint,id,keywords,kind,run,subtitle,title
      action:files | action | Árvore de arquivos | explorador do projeto | ["explorer","pastas","editor","file tree","folders"] | Ctrl+Shift+E | - | - | hint,id,keywords,kind,run,subtitle,title
      action:search | action | Buscar no projeto | texto em todos os arquivos | ["grep","find","procurar","conteudo","search","search project","content"] | Ctrl+Shift+F | - | - | hint,id,keywords,kind,run,subtitle,title
      action:changes | action | Alterações | git status e diff por arquivo | ["git","diff","mudancas","painel","changes","status"] | Ctrl+Shift+D | - | - | hint,id,keywords,kind,run,subtitle,title
      action:memos | action | Anotações | o caderno de notas markdown <mdash> cadernos, etiquetas e status | ["nota","caderno","markdown","md","etiqueta","anotacao","notebook","notes","tags"] | Ctrl+Shift+N | 20 | - | hint,id,keywords,kind,run,subtitle,title,weight
      action:memo-new | action | Nova anotação | cria uma nota e já abre para escrever | ["nota","nova","criar","anotacao","markdown","new note"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:memo-dock | action | Anotações em aba | o caderno vira uma aba do painel em foco | ["nota","caderno","aba","painel","dock","anotacao","notes tab"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:memo-center | action | Anotações na área central | o caderno ocupa todo o espaço do workspace | ["nota","caderno","central","tela","expandir","anotacao","notes center","expand"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:sidebar | action | Barra lateral | projetos e grupos | ["esconder","mostrar","painel","sidebar","show","hide"] | Ctrl+B | - | - | hint,id,keywords,kind,run,subtitle,title
      action:statusbar | action | Barra de status | agentes, branch, fluxos e memória no rodapé | ["esconder","mostrar","rodape","rodapé","footer"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:routines | action | Rotinas… | prompts agendados do grupo | ["agendar","lembrete","repetir","routines","schedule","reminder","repeat"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:scores | action | Partituras… | salvar e reaplicar o arranjo do grupo | ["layout","arranjo","template","scores","arrangement"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:editor-features | action | Tema, ícones e recursos do editor… | tema de cor, tema de ícones, minimapa, Prettier, Mermaid | ["extensoes","extensions","loja","store","plugins","temas","themes","icones","icons","symbols","minimapa","minimap","prettier"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:preferences | action | Configurações | fonte, renderer, scrollback, avisos, atalhos, recursos | ["config","ajustes","opcoes","settings","preferencias","preferences","options"] | Ctrl+Shift+P | - | - | hint,id,keywords,kind,run,subtitle,title
      action:agentes | action | Agentes <mdash> como cada CLI abre | a linha de comando fixa de cada agente, e o “sem pedir permissão” | ["permissao","dangerously","skip","yolo","flags","argumentos","claude","codex"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:shortcuts | action | Atalhos de teclado | - | ["teclas","ajuda","keybindings","shortcuts","keys","help"] | Ctrl+Shift+H | - | - | hint,id,keywords,kind,run,title
      action:notifications | action | Histórico de notificações | - | ["avisos","erros","notifications","history","errors"] | - | - | - | id,keywords,kind,run,title
      action:broadcast | action | Parar de transmitir o teclado | o que você digita numa CLI vai para todas as CLIs vivas do grupo | ["broadcast","uníssono","todos","transmitir","teclado","keyboard","all"] | Ctrl+Shift+U | - | - | hint,id,keywords,kind,run,subtitle,title
      action:export-output | action | Salvar saída do terminal em foco… | Um .txt legível, ou .ansi com as cores <mdash> vale para uma CLI que já morreu | ["exportar","salvar","saída","scrollback","log","histórico","export","save output","history"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:theme-toggle | action | Alternar tema claro/escuro | Aparência do Yard <mdash> Escuro, Claro ou Sistema em Configurações | ["tema","aparência","claro","escuro","light","dark","theme","appearance"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:language | action | Idioma da interface… | Português (Brasil), English ou o do sistema <mdash> em Configurações → Interface | ["idioma","language","inglês","english","português","portuguese"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:quit | action | Sair do Yard | Salva o workspace e fecha <mdash> mesmo com "fechar para a bandeja" ligado | ["quit","exit","fechar","encerrar","close"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:onboarding | action | Boas-vindas <mdash> o tour do primeiro uso | As CLIs encontradas, o primeiro projeto e os seis atalhos | ["onboarding","tour","início","primeiro uso","ajuda","welcome","first run","help"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:support | action | Relatar um problema… | Pacote de suporte com os logs <mdash> em Configurações → Dados e backup | ["bug","suporte","issue","log","erro","support","report","problem","error"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:check-updates | action | Verificar atualizações | Procura uma versão nova do Yard no GitHub | ["update","atualizar","versão","release","novidades","check updates","version"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:autobackup-now | action | Fazer backup automático agora | Grava uma cópia .zip na pasta de backups e aplica a retenção | ["backup","cópia","zip","segurança","automático","backup now","copy","automatic"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:costs | action | Custos e uso | tokens e gasto estimado por dia, projeto, agente e modelo | ["custo","tokens","gasto","uso","dinheiro","preço","cost","usage","spend","money","price"] | Ctrl+Alt+U | - | - | hint,id,keywords,kind,run,subtitle,title
      action:shoulder | action | Ombro | o que cada agente do grupo fez, lido das sessões em disco | ["shoulder","resumo","digest","sessão","agentes","summary","session","agents"] | Ctrl+Shift+O | - | Eye{"size":14} | hint,icon,id,keywords,kind,run,subtitle,title
      action:triggers-focused | action | Rotinas e gatilhos da CLI em foco… | 1 rotina(s) · 1 gatilho(s) armados | ["gatilho","trigger","quando","evento","automação","routines","when","event","automation"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:mcp | action | Servidores MCP… | os servidores de ferramentas de cada CLI, num lugar só | ["mcp","model context protocol","servidor","ferramentas","tools","server"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:lsp | action | Servidores de linguagem… | quais o editor encontrou nesta máquina, e o interruptor do LSP | ["lsp","language server","autocomplete","definição","diagnóstico","definition","diagnostics"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:sessions | action | Sessões anteriores | retomar uma sessão de agente em api | ["resume","retomar","historico","claude","codex","sessions","history"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:surface-canvas | action | Ir para o canvas | cartões num quadro infinito, com as CLIs de lá | ["canvas","quadro","paineis","abas","superficie","board","panes","tabs","surface"] | - | 10 | - | id,keywords,kind,run,subtitle,title,weight
      action:layout-grid | action | Modo grade | número fixo de painéis | ["layout","modo","grupo","paineis","mode","group","panes","auto","grid","spotlight"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:layout-spotlight | action | Modo holofote | um grande, o resto pequeno | ["layout","modo","grupo","paineis","mode","group","panes","auto","grid","spotlight"] | - | - | - | id,keywords,kind,run,subtitle,title
      action:live | action | Ao Vivo | acompanhar Claude passo a passo | ["overlay","sessao","mission control","feed","live","session"] | - | 25 | Layers{"size":14} | icon,id,keywords,kind,run,subtitle,title,weight
      action:transcript | action | Transcrição da sessão | ler a conversa de Claude do começo | ["transcript","sessão","histórico","conversa","session","history","conversation"] | - | - | ScrollText{"size":14} | icon,id,keywords,kind,run,subtitle,title"
    `);
  });
});

// ---------------------------------------------------------------------------
// the composer: one cell per domain
// ---------------------------------------------------------------------------

const byId = (rows: PaletteEntry[]) => new Map(rows.map((row) => [row.id, row]));

describe("createEntryComposer", () => {
  it("rebuilds only the rows that read what moved: a terminal going idle leaves files, canvas and notes as they were", () => {
    const world = fixture();
    const compose = createEntryComposer();
    const before = byId(compose(world, "pt-BR"));

    const after = byId(
      compose(
        {
          ...world,
          runtimes: {
            ...world.runtimes,
            "t-claude": { state: "exited", finished: false, unread: false, blocked: false },
          },
        },
        "pt-BR",
      ),
    );

    expect(after.get("terminal:t-claude")).not.toBe(before.get("terminal:t-claude"));
    for (const id of [
      "group:g-main",
      "project:p-api",
      "url:t-shell:http://localhost:5173",
      "note:n1",
      "media:m1",
      "file:src/a.ts",
      "file:gen/out.js",
      "file:src/d.ts",
      "file:src/e.ts",
      "prompt:pr1",
      "memo:m1",
    ]) {
      expect(after.get(id), id).toBe(before.get(id));
    }
  });

  it("rebuilds the actions on every compose: they read stores the world does not carry, as the single builder did", () => {
    // The broadcast switch, the canvas side and the recorded sessions are read
    // straight from their stores, not subscribed: the list picked them up
    // whenever anything else moved, and it still has to.
    const world = fixture();
    const compose = createEntryComposer();
    expect(byId(compose(world, "pt-BR")).get("action:broadcast")?.title).toBe(
      "Parar de transmitir o teclado",
    );

    useBroadcast.setState({ groupId: null });
    const feed = [
      { path: "src/new.ts", kind: "created" as const, at: 9, count: 1 },
      ...world.liveByProject["p-api"],
    ];
    const next = byId(compose({ ...world, liveByProject: { "p-api": feed } }, "pt-BR"));

    expect(next.get("action:broadcast")?.title).toBe("Transmitir teclado para o grupo");
  });

  it("rebuilds the tasks on every compose: a deadline reads the clock, which no input carries", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2030, 2, 9, 23, 59));
      const world = fixture();
      const withDue = { ...world, tasks: [task("k9", "entregar", { dueAt: day(2030, 2, 10) })] };
      const compose = createEntryComposer();
      expect(byId(compose(withDue, "pt-BR")).get("task:k9")?.subtitle).toBe("amanhã · global");

      // Midnight passes with the box open; the next thing that moves is the feed.
      vi.setSystemTime(new Date(2030, 2, 10, 0, 1));
      const next = byId(compose({ ...withDue, liveByProject: { "p-api": [] } }, "pt-BR"));

      expect(next.get("task:k9")?.subtitle).toBe("hoje · global");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// the file rows: handed back across rebuilds
// ---------------------------------------------------------------------------

describe("the file rows", () => {
  it("survive a feed change: only the file the agent just touched is a new row", () => {
    const world = fixture();
    const compose = createEntryComposer();
    const before = byId(compose(world, "pt-BR"));

    const feed = [
      { path: "src/new.ts", kind: "created" as const, at: 9, count: 1 },
      ...world.liveByProject["p-api"],
    ];
    const after = byId(compose({ ...world, liveByProject: { "p-api": feed } }, "pt-BR"));

    expect(after.get("file:src/new.ts")?.keywords).toEqual(["tocado recente feed touched recent"]);
    for (const id of [
      "file:src/a.ts",
      "file:src/b.ts",
      "file:gen/out.js",
      "file:src/c.ts",
      "file:README.md",
      "file:src/d.ts",
      "file:src/e.ts",
      "file:docs/f.md",
    ]) {
      expect(after.get(id), id).toBe(before.get(id));
    }
  });

  it("come back with the new status when git reports one, and stay as they were when it reports the same", () => {
    const world = fixture();
    const compose = createEntryComposer();
    const before = byId(compose(world, "pt-BR"));

    // A fresh summary, as every `git status` refresh brings: new objects,
    // one status that really changed.
    const summary = world.gitByProject["p-api"]!;
    const refreshed = {
      ...summary,
      files: [changed("src/a.ts", "deleted"), changed("src/b.ts", "added")],
    };
    const after = byId(
      compose({ ...world, gitByProject: { ...world.gitByProject, "p-api": refreshed } }, "pt-BR"),
    );

    expect(after.get("file:src/a.ts")?.keywords).toEqual(["deleted", "alterado git changed"]);
    expect(after.get("file:src/b.ts")).toBe(before.get("file:src/b.ts"));
  });

  it("open in the project now active after a switch, even for a path both projects changed", () => {
    // A row is handed back only for the project it was made in: its `run`
    // holds the project whose diff it opens.
    const world = fixture();
    const summary = () => ({
      isRepo: true,
      branch: "main",
      additions: 0,
      deletions: 0,
      uncounted: 0,
      files: [changed("package.json", "modified")],
    });
    const git = { "p-api": summary(), "p-web": summary() };
    const compose = createEntryComposer();
    compose({ ...world, gitByProject: git }, "pt-BR");

    useProjects.setState({ activeProjectId: "p-web", activeGroupId: "g-web" });
    const after = byId(
      compose(
        { ...world, gitByProject: git, activeProjectId: "p-web", activeGroupId: "g-web" },
        "pt-BR",
      ),
    );
    after.get("file:package.json")!.run();

    expect(useChanges.getState().viewer).toEqual({ projectId: "p-web", path: "package.json" });
  });
});

describe("a composer that lived through a run of changes", () => {
  afterEach(() => setActiveLang("pt-BR"));

  it("answers exactly what a fresh build answers, change after change", () => {
    let world = fixture();
    const compose = createEntryComposer();
    const check = (label: string) => {
      expect(compose(world, locale()).map(line), label).toEqual(buildEntries(world).map(line));
    };
    check("first build");

    // The agent touches a new file and one that only the index knew.
    const feed = world.liveByProject["p-api"];
    world = {
      ...world,
      liveByProject: {
        "p-api": [
          { path: "src/e.ts", kind: "modified", at: 11, count: 1 },
          { path: "src/new.ts", kind: "created", at: 10, count: 1 },
          ...feed,
        ],
      },
    };
    check("feed");

    // git catches up: a status flips, a file joins, another leaves.
    world = {
      ...world,
      gitByProject: {
        ...world.gitByProject,
        "p-api": {
          ...world.gitByProject["p-api"]!,
          files: [changed("src/a.ts", "deleted"), changed("src/new.ts", "added")],
        },
      },
    };
    check("git");

    // The tree reads another folder and forgets a file, and one listing names
    // a file differently from its path.
    world = {
      ...world,
      dirs: {
        "": [dirEntry("src", "src", true)],
        src: [dirEntry("d.ts", "src/d.ts"), dirEntry("Leia-me", "README.md")],
        docs: [dirEntry("f.md", "docs/f.md")],
      },
    };
    check("dirs");

    // A monorepo's index, past the cap.
    world = {
      ...world,
      fileIndex: [...world.fileIndex!, ...Array.from({ length: 7000 }, (_, i) => `pkg/m${i}.ts`)],
    };
    check("index past the cap");

    // More than the sixty feed entries the rows take.
    world = {
      ...world,
      liveByProject: {
        "p-api": Array.from({ length: 70 }, (_, i) => ({
          path: `gen/g${i}.js`,
          kind: "created" as const,
          at: 100 - i,
          count: 1,
        })),
      },
    };
    check("long feed");

    world = {
      ...world,
      runtimes: {
        ...world.runtimes,
        "t-card": { state: "running", finished: false, unread: false, blocked: false },
      },
    };
    check("runtime tick");

    setActiveLang("en");
    check("language");
    setActiveLang("pt-BR");
    check("language back");

    useProjects.setState({ activeProjectId: "p-web", activeGroupId: "g-web" });
    world = { ...world, activeProjectId: "p-web", activeGroupId: "g-web" };
    check("switch to web");
    useProjects.setState({ activeProjectId: "p-api", activeGroupId: "g-main" });
    world = { ...world, activeProjectId: "p-api", activeGroupId: "g-main" };
    check("back to api");

    // A note on the board, a prompt and a memo edited.
    const groups = world.groups.map((g) =>
      g.id === "b-board"
        ? {
            ...g,
            layoutJson: layout({
              canvas: { ...VIEW, items: [{ ...BOX, type: "note", id: "n9", text: "nova" }] },
            }),
          }
        : g,
    );
    useProjects.setState({ groups });
    world = {
      ...world,
      groups,
      prompts: [prompt("pr3", "Outro", "corpo", [], false)],
      memos: [memo("m3", "Outra", "texto", {})],
    };
    check("canvas, prompts and memos");
  });
});
