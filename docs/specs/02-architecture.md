# Arquitetura

> O código é a verdade final; este spec registra o desenho e os contratos que
> ele segue. Módulos e nomes abaixo existem em `src-tauri/src/` e `src/`.

## 1. Visão geral

```
┌─────────────────────────────  WebView2 (React/TS)  ─────────────────────────────┐
│  TitleBar · Sidebar (projetos/grupos) · WorkspaceGrid (splits) · Modais         │
│  XTermView (xterm.js + canvas)  ·  Zustand stores (projects/terminals/ui)       │
└───────────────▲───────────────────────────────────────────────▲─────────────────┘
        invoke() comandos                                eventos emit()
                │                                               │
┌───────────────┴───────────────────  Rust (Tauri)  ────────────┴─────────────────┐
│ events.rs (barramento)      state.rs (AppState: registries + db)                │
│ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ ┌─────────────────────────┐ │
│ │ pty/          │ │ agents/      │ │ git/          │ │ persistence/            │ │
│ │  spawn        │ │  resolver    │ │  status       │ │  db.rs (SQLite)         │ │
│ │  reader       │ │  sessions    │ │  worktrees    │ │  workspace.rs           │ │
│ │  scrollback   │ │  usage/custo │ │               │ │  prefs.rs · backup.rs   │ │
│ │  teardown     │ └──────────────┘ └───────────────┘ └─────────────────────────┘ │
│ │ process_tree  │  resources.rs (RAM/CPU, suspender)   watcher.rs (notify)      │
│ └──────────────┘  paths.rs · logging.rs · single_instance                       │
└──────┬──────────────────┬───────────────────┬──────────────────┬────────────────┘
       │ ConPTY           │ Job Objects       │ git CLI          │ %APPDATA%
   pwsh/cmd/agente    (kill de árvore)    (worktree add…)    app.db + scrollback/
```

## 2. Módulos Rust (`src-tauri/src/`)

| Módulo                               | Responsabilidade                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `main.rs` / `lib.rs`                 | Bootstrap do Tauri, registro de comandos, plugins, `AppState`                                    |
| `state.rs`                           | `PtyRegistry`, conexão SQLite, caches — tudo atrás de `Mutex`/`RwLock`                           |
| `pty/mod.rs`                         | API pública do motor: spawn, write, resize, attach, kill, suspend, restart                       |
| `pty/reader.rs`                      | Thread de leitura por PTY: fronteira UTF-8, coalescing, emissão de eventos                       |
| `pty/scrollback.rs`                  | Anel de 4 MB em memória + `.bin` append-only com compactação ([motor de PTY §2](./03-pty-engine.md#2-scrollback-anel-de-4-mb--append-only-em-disco)) |
| `pty/teardown.rs`                    | Estados de encerramento, exit watcher, limpeza do registry                                       |
| `process_tree.rs`                    | Mapa pai→filhos via `sysinfo` (cache 2 s, filtrando threads), Job Objects                        |
| `agents/resolver.rs`                 | Descobrir CLIs instaladas no Windows: `where`, shims `.cmd` do npm, registro                     |
| `agents/sessions.rs`                 | Ler sessões locais dos agentes (`~/.claude/projects/*.jsonl`, `~/.codex/sessions`…) p/ "retomar" |
| `agents/tail.rs`                     | Grampo da sessão ativa do agente → evento `session://feed` (alimenta o overlay Ao Vivo)          |
| `git.rs`                             | `git status --porcelain=v2` via subprocess, com cache; diff por arquivo                          |
| `persistence/db.rs`                  | SQLite (rusqlite bundled), migrações, guarda de escrita monotônica                               |
| `persistence/workspace.rs`           | Snapshot/restore de projetos, grupos, layouts e terminais                                        |
| `bridge.rs`                          | Pipe nomeado da CLI `yard` — transporte da ponte agente↔app                                      |
| `watcher.rs`                         | `notify` para arquivos de sessão dos agentes e arquivos abertos                                  |
| `resources.rs`                       | `sysinfo`: RAM/CPU por árvore de PTY, gate de spawn, suspensão de grupo                          |
| `paths.rs`                           | Resolução central de `%APPDATA%\Yard\…` (nunca espalhar caminhos)                                |
| `events.rs`                          | Nomes de tópicos e payloads tipados (um único lugar define o contrato)                           |

## 3. Frontend (`src/`)

```
src/
├── main.tsx · App.tsx
├── stores/            # Zustand — fatiados por domínio
│   ├── projectsStore.ts     # projetos, grupos, layout (persistido via backend)
│   ├── terminalsStore.ts    # id → status/título/atividade (espelho do backend)
│   ├── changesStore.ts      # git status/diffs do painel de alterações
│   ├── liveStore.ts         # redução do feed de sessão (overlay Ao Vivo)
│   └── uiStore.ts           # tema, modais, painel focado, zoom
├── components/
│   ├── TitleBar/            # barra custom (decorations: false), botões min/max/close
│   ├── ProjectSidebar/      # árvore projetos → grupos → terminais
│   ├── WorkspaceGrid/       # react-resizable-panels: layouts automático/grade/spotlight
│   ├── CanvasView/          # 4º modo de layout: canvas infinito (cartões, notas, desenho)
│   ├── TerminalPane/        # moldura: título, sub-tabs, ações (restart/suspender/kill)
│   ├── XTermView/           # o xterm em si (attach, resize, input)
│   └── modals/              # NovoTerminal, Preferências, Partituras, Rotinas…
├── hooks/                   # useGlobalEvents, useKeybindings, useRoutines…
└── lib/
    ├── ipc.ts               # wrappers tipados de invoke/listen (o contrato §4 em TS)
    └── bridge.ts            # a inteligência da ponte agente↔app (ver §4.1)
```

## 4. Contrato IPC (comandos + eventos)

Um único arquivo de verdade em cada lado (`events.rs` ↔ `lib/ipc.ts`).
Conjunto mínimo do núcleo:

**Comandos (`invoke`)**

| Comando                                    | Entrada                                        | Saída                                     | Nota                                                           |
| ------------------------------------------ | ---------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `spawn_pty`                                | `{ id, program, args, cwd, rows, cols, env? }` | `Result<()>`                              | Passa pelo gate de RAM ([motor §4](./03-pty-engine.md#4-gate-de-ram-no-spawn)) |
| `write_pty`                                | `{ id, data }`                                 | `Result<()>`                              | Input do teclado/paste                                         |
| `resize_pty`                               | `{ id, rows, cols }`                           | `Result<()>`                              | Debounced no front (~50 ms)                                    |
| `attach_pty`                               | `{ id }`                                       | `Result<Option<String>>`                  | Devolve o scrollback se o PTY existe; `None` = precisa spawnar |
| `kill_pty`                                 | `{ id }`                                       | `Result<()>`                              | Mata a **árvore** (Job Object)                                 |
| `suspend_pty`                              | `{ id }`                                       | `Result<()>`                              | Mata preservando scrollback + metadados de retomada            |
| `restart_pty`                              | `{ id }`                                       | `Result<()>`                              | kill + respawn com o mesmo comando/cwd                         |
| `list_ptys` / `pty_exists`                 | — / `{ id }`                                   | snapshot / `bool`                         | Reconciliação pós-reload da UI                                 |
| `get_pty_tree_info`                        | `{ id }`                                       | `{ pids, rssMb, cpu }`                    | Alimenta o HUD de recursos                                     |
| `save_workspace` / `load_workspace`        | snapshot JSON                                  | `Result`                                  | Com guarda de revisão monotônica                               |
| `detect_agents`                            | —                                              | `[{ id, name, bin, version, resumeCmd }]` | Detecção de CLIs                                               |
| `list_agent_sessions`                      | `{ agent, projectPath }`                       | sessões p/ retomar                        | Parsers de `~/.claude`, `~/.codex`…                            |
| `read_prefs` / `write_prefs`               | kv                                             | kv                                        | Tabela `kv` do SQLite                                          |

**Eventos (`listen`)**

| Tópico                | Payload                     | Quando                                                             |
| --------------------- | --------------------------- | ------------------------------------------------------------------ |
| `pty://output/{id}`   | `{ data: string }`          | Chunks de saída (coalescidos ~8–16 ms; 450 ms se painel invisível) |
| `pty://exit/{id}`     | `{ code?: number, reason }` | Processo raiz saiu (`reason`: normal/killed/suspended/restarted)   |
| `pty://activity/{id}` | `{ lastByteAt }`            | Batimento p/ detector de "agente terminou" (idle ≥ 4,5 s)          |
| `agents://changed`    | —                           | Watcher viu sessão nova/atualizada de um agente                    |
| `session://feed`      | entradas da sessão          | Grampo do JSONL do agente (overlay Ao Vivo)                        |
| `resources://tick`    | `{ totalRssMb, perPty }`    | A cada ~2 s, p/ HUD e supervisor                                   |
| `bridge://request`    | linha JSON da CLI `yard`    | Pedido de um agente pela ponte (respondido via `bridge_respond`)   |

**Regra de ouro:** a UI **nunca** assume que criar/destruir um componente
cria/destrói um processo. Montou um `XTermView` → chama `attach_pty`; se veio
scrollback, só repinta; se veio `None`, aí sim `spawn_pty`. Fechar painel ≠
matar processo (isso é ação explícita). É o que faz HMR, reload e restart da
UI serem indolores.

### 4.1 A ponte agente↔app

A CLI `yard` fala com o app por um pipe nomeado (uma linha JSON de ida, uma de
volta) → evento `bridge://request` → `src/lib/bridge.ts` responde por
`bridge_respond`. O Rust é transporte burro **de propósito**: todo o estado do
workspace vive no frontend, e duplicá-lo no backend criaria duas verdades. As
conexões desenhadas no canvas são o controle de acesso: um agente só alcança o
que está ligado a ele.

## 5. Persistência

```
%APPDATA%\Yard\
├── app.db                  # SQLite — estado estrutural
├── scrollback\{ptyId}.bin  # append-only, compactado a 8 MB
├── partituras\{nome}.json  # arranjos de grupo salvos e reaplicáveis
├── bin\                    # CLI yard + manual da ponte (YARD-BRIDGE.md)
├── logs\yard.log           # tracing + rotação diária
└── backups\                # export .zip (db + scrollbacks)
```

Esquema-base do `app.db` (migrações versionadas em `persistence/db.rs`):

```sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, layout_json TEXT NOT NULL DEFAULT '{}',
  suspended INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title TEXT, kind TEXT NOT NULL,            -- 'shell' | 'agent'
  program TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL, resume_json TEXT,       -- como retomar (ex.: claude --resume <id>)
  sort INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_sessions (   -- índice do que os agentes salvam localmente
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_path TEXT NOT NULL,
  external_id TEXT NOT NULL, title TEXT, updated_at INTEGER NOT NULL, cost_usd REAL
);
```

O canvas, os andares, as rotinas e os papéis moram dentro de `layout_json` do
grupo (`layoutJson.canvas`, `layout_json.floor`) — **sem migração de banco**;
foi o que permitiu o modo canvas inteiro caber sem tocar no schema.

Estratégia: estado quente vive em memória no Rust; snapshots vão pro SQLite
com um contador de revisão em `kv('workspace_rev')` — o backend **recusa**
salvar uma revisão menor que a atual (protege contra UI atrasada sobrescrever
estado novo). `tauri-plugin-single-instance` garante um só processo
escrevendo.
