# Roadmap por fases

Cada fase termina com um critério de aceitação verificável. Não avance com
critério pendente — é a diferença entre um app e uma demo.

> **Estado em 2026-08-13.** F0–F4 estão entregues. Em cima delas nasceram duas
> coisas que este plano não previa e que hoje definem o produto — o **modo
> canvas** e a **ponte agente↔app** (a CLI `yard`) — documentadas na §8.1.
> Da F5 saíram o `git status` (painel de alterações com diff por arquivo) e os
> **andares** (worktree por tarefa); o "aterrissar" (merge de volta no chão) e
> o fan-out automático continuam abertos. F6 (produto: updater, CI de release,
> assinatura, CSP) segue inteira aberta.

## F0 — Bootstrap

- [x] Projeto criado (`create tauri-app`), roda `npm run tauri dev`
- [x] Janela sem decoração + `TitleBar` custom com min/max/close
      (`getCurrentWindow().minimize()` etc.) e região de arraste
      (`data-tauri-drag-region`)
- [x] Tema escuro base, layout casca (sidebar + área central vazia)
- [x] `logging.rs` com `tracing` gravando em `%APPDATA%\Yard\logs`

**Aceite:** app abre, arrasta, minimiza, fecha; log aparece no disco.

## F1 — Terminal vertical slice ← o coração

- [x] Motor de PTY (`src-tauri/src/pty/`) com spawn/write/resize/attach/kill
      funcionando com `pwsh.exe`
- [x] `XTermView` com input, resize (debounced), cores ANSI, unicode
- [x] Regra attach-antes-de-spawn; view fecha sem matar processo
- [x] Scrollback completo (anel 4 MB + `.bin` append-only + compactação)
- [x] Coalescing de saída e `pty://activity`
- [x] Job Object no spawn + `kill_pty` matando a árvore inteira
- [x] `restart_pty` e exit banner com motivo

**Aceite:** rodar `claude` dentro; sobreviver a reload da UI; `kill` não deixa
`node.exe` órfão no Gerenciador de Tarefas; `type arquivo_grande.txt` não
trava a UI.

## F2 — Workspace

- [x] Projetos (pasta raiz) → grupos → terminais; sidebar navegável
- [x] **Padrão em abas:** criar terminal nunca divide a tela — cada CLI ocupa
      o painel inteiro e a nova entra como aba na barra de cima
- [x] `WorkspaceGrid` com `react-resizable-panels`: divisão continua possível,
      mas só de propósito (arrastar a aba para outro painel) — layouts
      automático (1/2/4), grade custom, spotlight (1 grande + resto mini)
- [x] Modal "Novo terminal": shell ou agente
- [x] Atalhos: novo terminal, alternar aba (Ctrl+1..9, Ctrl+Tab), fechar view,
      buscar (addon search)
- [x] Drag & drop de terminal entre slots (dnd-kit)

**Aceite:** 6 terminais em 2 grupos, reorganizáveis, cada um com estado
independente.

## F3 — Persistência e retomada

- [x] `persistence/db.rs` com o schema da
      [arquitetura §5](./02-architecture.md#5-persistência) + migrações
      versionadas
- [x] `save_workspace` com guarda de revisão monotônica; autosave debounced
- [x] Ao abrir o app: restaurar projetos/grupos/layout; terminais mortos
      mostram scrollback do `.bin` + botão "retomar"
- [x] `suspend_pty` / suspender grupo com indicador visual
- [x] Export/import de backup `.zip` (db + scrollbacks)
- [x] Confirmação ao sair com agentes vivos ("fechar e manter rodando" não
      existe no Tauri — matar limpo via Job Objects)

**Aceite:** fechar o app com 4 terminais, reabrir, ver tudo no lugar e retomar
um por clique.

## F4 — Integração com agentes

- [x] `agents/resolver.rs`: detectar Claude Code, Codex, OpenCode, Gemini CLI,
      Cursor CLI via `which` + shims `.cmd`/`.ps1` do npm (ver
      [armadilhas do Windows, item 3](./04-windows-pitfalls.md)) + versão
      (`--version`)
- [x] `agents/sessions.rs`: listar sessões locais por projeto (ex.:
      `%USERPROFILE%\.claude\projects\<slug>\*.jsonl`) → alimenta "retomar
      sessão" com `claude --resume <id>` / `codex resume`
- [x] Custo/tokens agregados por sessão (parse dos mesmos arquivos), HUD
      discreto por painel
- [x] Detector "agente terminou" + notificação nativa + badge não-lido
- [x] `watcher.rs` (`notify`) observando os diretórios de sessão → evento
      `agents://changed`

**Aceite:** abrir projeto → ver sessões antigas do Claude Code → retomar uma
em novo painel → ao terminar a resposta, notificação do Windows dispara.

## F5 — Git e worktrees paralelos

- [x] `git status --porcelain=v2` (subprocess com cache): branch + dirty count
      por projeto — entregue no painel de arquivos/alterações, com diff por
      arquivo
- [x] Worktree por tarefa — entregue como **andares** (§8.1): cada andar é um
      `git worktree` em `<projeto>\.yard\floors\<slug>` com grupo e canvas
      próprios
- [ ] **Aterrissar** — merge do andar de volta no chão, com preview de
      conflito (hoje é manual: `git merge yard/<slug>` no chão)
- [ ] Fluxo "nova tarefa": nome → worktree → grupo novo → N agentes no mesmo
      prompt (fan-out)
- [ ] Visão de comparação simples: diffstat por worktree lado a lado (diff
      completo pode abrir no editor externo por enquanto)

**Aceite:** disparar a mesma tarefa p/ 2 agentes em 2 worktrees, comparar
diffstat, apagar o perdedor com um clique.

## F6 — Produto

- [ ] `tauri-plugin-updater` com chave de assinatura própria + endpoint em
      GitHub Releases
- [ ] Instalador NSIS + ícones + `webviewInstallMode: downloadBootstrapper`
- [ ] CI de release (ver [development](../development.md#cicd--build-e-release-por-tag))
      gerando release por tag
- [ ] Endurecer CSP; revisar `capabilities` do Tauri (mínimo necessário)
- [ ] Assinatura de código Windows (ver
      [armadilhas do Windows, item 7](./04-windows-pitfalls.md)) — ou
      documentar o aviso do SmartScreen
- [ ] Onboarding mínimo: primeira execução detecta agentes e sugere criar o
      primeiro projeto

## F7 — Horizonte (depois do 1.0)

Terminal headless em Rust puro (`wezterm-term`) espelhando estado — habilita
reconexão perfeita e um companion mobile via WebSocket + criptografia NaCl;
anotação de diffs devolvida ao agente; MCP manager.

> A "CLI própria" que este item previa acabou nascendo antes e com outra
> forma: não é um lançador (`yard run`), é a **ponte** que os agentes usam de
> dentro dos terminais (§8.1).

## 8.1 — Canvas e ponte (fora do roadmap original)

Nenhuma das duas estava no plano; as duas mudaram o que o app é. Ficam
registradas aqui como fase entregue, com o que sobrou pendente.

**Modo canvas** (4º modo de layout do grupo). Canvas infinito com pan/zoom
(ímã em 100%), terminais como cartões arrastáveis/redimensionáveis, caneta e
formas à mão (roughjs + perfect-freehand), setas, texto, notas adesivas com
markdown leve, conexões curvas, borracha, undo/redo, atalhos de uma tecla.
Persistido em `layoutJson.canvas` — **sem migração de banco**, o que é o
motivo de tudo isso ter cabido sem tocar no schema. Zoom é
`transform: scale`: o ConPTY só é redimensionado quando o cartão muda de
tamanho.

**Ponte agente↔app — a CLI `yard`.** Pipe nomeado (uma linha JSON de ida, uma
de volta) → evento `bridge://request` → `src/lib/bridge.ts` responde por
`bridge_respond`. O Rust é transporte burro de propósito: **todo** o estado do
workspace vive no frontend, e duplicá-lo no backend criaria duas verdades. As
conexões desenhadas no canvas são o controle de acesso: um agente só alcança o
que está ligado a ele. Comandos: `list`, `ask`
(`--file`/`--stdin`/`--raw`/`--batch`), `check`, `note` (com trava do
usuário), `connect`, `recruit` (`--replace`, `--floor`), `dismiss`, `role`
(+ presets), `routine`, `score`, `floor`, `portal`, `notify`, `debug`.
Descoberta: skill em `~/.claude/skills/yard/` para o Claude Code e
`<data>\bin\YARD-BRIDGE.md` + `YARD_BRIDGE_HELP` para os demais.

**Também entregue:** compositor de prompts flutuante (`Ctrl+Enter`,
`@menções`, rascunho por terminal), rotinas (prompts agendados, só com o alvo
ocioso), partituras (arranjo do grupo salvo em `<data>\partituras\*.json` e
reaplicável), andares (worktree por tarefa com canvas próprio) e o overlay
**Ao Vivo** (mission control do agente a partir do grampo da sessão,
`agents/tail.rs` → `session://feed`).

**Pendente nesta linha:**

- [ ] **Aterrissar** — merge do andar de volta no chão com preview de
      conflito (ver F5).
- [ ] **Portais** — cartão de navegador no canvas (webview filha do Tauri
      posicionada sobre o retângulo do cartão) que o agente dirige por
      `yard portal open/goto/snapshot/click/fill`.
- [ ] **Ombro** — digest por grupo do que cada agente fez, a partir dos JSONL
      que `agents/sessions.rs` já lê (parse em `spawn_blocking`).
- [ ] Screenshots inline no compositor — **não** planejado: as CLIs esperam
      caminho de arquivo e não há caminho bom para colar imagem num PTY.
