# Yard

Orquestrador de agentes de código para Windows — roda vários agentes (Claude Code,
Codex, OpenCode…) e shells em paralelo, cada um no seu próprio terminal real (PTY),
organizados em projetos, grupos e painéis divididos, com histórico e layout
persistidos em disco.

**Tauri 2 + Rust no núcleo, React/TypeScript + xterm.js na superfície.** As
especificações de arquitetura, motor de PTY e roadmap vivem em
[`docs/`](./docs/README.md). Fases F0–F4 do roadmap estão implementadas, mais o
**modo canvas** e a **ponte agente↔app** (CLI `yard`) construídos em cima delas.

---

## Rodando

Pré-requisitos: Rust stable (toolchain MSVC), Build Tools do Visual Studio com a
workload C++, Node 20+.

```powershell
npm install
npm run tauri dev          # desenvolvimento, com HMR
npm run tauri build        # instalador NSIS em src-tauri/target/release/bundle
```

Variáveis de ambiente úteis:

| Variável            | Para quê |
| ------------------- | -------- |
| `YARD_DATA_DIR`  | Redireciona o diretório de dados (padrão `%APPDATA%\Yard`). Também **desliga a trava de instância única** — duas builds com diretórios próprios não corrompem uma à outra. |
| `YARD_LOG`       | Filtro do `tracing`, ex.: `yard_lib=debug,ui=debug,warn`. |

Dentro de cada terminal que o Yard abre, o app injeta `YARD=1`,
`YARD_PTY_ID`, `YARD_PIPE`, `YARD_CLI` e — nos terminais de agente —
`YARD_BRIDGE_HELP` (caminho do manual da ponte).

> Rodar a build de desenvolvimento ao lado de uma instalada sem `YARD_DATA_DIR`
> faz as duas dividirem o mesmo `app.db` e a mesma pasta de scrollback.

## O que está feito

**F0 — Bootstrap.** Janela sem decoração com barra de título própria (arrastar,
minimizar, maximizar, fechar), tema escuro, `tracing` gravando em
`%APPDATA%\Yard\logs` com rotação diária, instância única.

**F1 — Motor de PTY** (`src-tauri/src/pty/`). O coração:

- Spawn via ConPTY (`portable-pty`), com `drop(slave)` imediato — sem isso o EOF
  nunca chega quando o processo morre.
- **Fronteira UTF-8** costurada entre `read()`s: a cauda de 0–3 bytes de um
  caractere partido é guardada para a leitura seguinte.
- **Scrollback**: anel de 4 MB em memória + `.bin` append-only que recebe só o
  delta a cada 250 ms, compactado para a cauda de 4 MB quando passa de 8 MB.
- **Coalescing**: ~16 ms/32 KB com o painel visível, 450 ms quando invisível;
  payloads fatiados em 256 KB; teto de 2 MB no buffer de emissão com aviso
  visível quando a saída é rápida demais para exibir.
- **Job Objects** (`KILL_ON_JOB_CLOSE`) associados no spawn — `kill` derruba a
  árvore inteira, e um crash do Yard faz o SO derrubar por ele. Fallback por
  árvore de processos e `taskkill` se o job não puder ser criado.
- Gate de RAM antes de bootar agente (400 MB livres, espera até 45 s).
- Estados explícitos de encerramento: `normal` / `killed` / `suspended` /
  `restarted` / `failed`.
- Detector de "agente terminou" (idle ≥ 4,5 s depois de atividade) → notificação
  nativa do Windows.

**F2 — Workspace.** Projetos → grupos → terminais na sidebar; grade com
`react-resizable-panels` em três modos (automático, grade fixa de 1–6 painéis,
holofote); sub-tabs por painel; drag & drop de terminal entre painéis; busca no
scrollback; atalhos (`Ctrl+T`, `Ctrl+B`, `Ctrl+1..6`, `Ctrl+Shift+P`,
`Ctrl+Shift+G`).

**F3 — Persistência.** SQLite com WAL e migrações versionadas; `save_workspace`
com **guarda de revisão monotônica** (uma UI atrasada não sobrescreve estado novo);
autosave debounced; restauração de projetos/grupos/layout na abertura; suspender
terminal ou grupo inteiro preservando scrollback; export/import de backup `.zip`;
confirmação ao sair com terminais vivos.

**F4 — Agentes.** Detecção de 8 CLIs resolvendo os shims `.cmd`/`.ps1` do npm
(`CreateProcess` não executa `.cmd` — o resolver reescreve para `cmd.exe /c`);
listagem das sessões locais de Claude Code e Codex por projeto, com retomada em um
clique; contagem de tokens e estimativa de custo; watcher (`notify`) dos diretórios
de sessão.

**Canvas.** Quarto modo de layout do grupo (ao lado de automático/grade/holofote):
canvas infinito com pan/zoom (ímã em 100%), terminais como cartões arrastáveis e
redimensionáveis, caneta e formas à mão livre (roughjs + perfect-freehand), setas,
texto, notas adesivas com markdown leve, conexões curvas, borracha, undo/redo e
atalhos de uma tecla (`V H P E R O L A T N C`). Tudo persiste em
`layoutJson.canvas` — sem migração de banco. Zoom é `transform: scale`; só o
resize do cartão toca em linhas/colunas do ConPTY.

**Ponte agente↔app — a CLI `yard`.** Todo terminal aberto pelo Yard tem a
CLI `yard` no PATH. Ela fala com o app por um pipe nomeado (uma linha JSON de
ida, uma de volta): o Rust é só transporte, e toda a inteligência mora em
`src/lib/bridge.ts`. **As conexões desenhadas no canvas regulam quem fala com
quem** — um agente só alcança o que está ligado a ele.

- `list` / `ask` / `check` — conversar com agentes conectados (`--file`/`--stdin`
  para prompt multi-linha, já que `%*` do `cmd.exe` come quebras de linha).
- `note create|read|write|edit|delete` — notas do canvas como memória
  compartilhada; correntes de notas funcionam. Nota **travada** pelo usuário
  recusa escrita da CLI.
- `connect` / `recruit` / `dismiss` — montar o time do próprio canvas.
  `recruit --replace "Antigo"` troca o processo de um cartão preservando
  posição, conexões e papel. `recruit --floor "Andar"` faz o recruta nascer
  no canvas do andar, com o worktree dele como cwd.
- `floor list` / `floor create` — andares por CLI. A criação é silenciosa:
  a tela do usuário não troca de grupo.
- `role` — papel por cartão e presets reutilizáveis (`--scope global|current`).
- `routine` — prompts agendados, entregues só com o alvo rodando e ocioso.
- `score` — salvar e reaplicar o arranjo inteiro do grupo (partituras).
- `notify` / `debug` / `help`.

O Claude Code descobre a CLI sozinho: o app instala
`~/.claude/skills/yard/SKILL.md`. Os outros agentes recebem o mesmo manual em
`<data>\bin\YARD-BRIDGE.md`, apontado por `YARD_BRIDGE_HELP` no ambiente.
Para o Codex, o `~/.codex/AGENTS.md` é arquivo do usuário e o app **não** o
toca — se quiser descoberta automática lá, acrescente à mão:

```md
- Rode `yard help` (o caminho completo do manual está em `$YARD_BRIDGE_HELP`)
  para colaborar com os outros agentes do canvas.
```

**Compositor de prompts** (`Ctrl+Enter`). Caixa flutuante para escrever prompt
longo fora do terminal — dentro da CLI, Enter envia, e dez linhas viram dez
submits. O texto sai pela mesma injeção do `yard ask` (bracketed paste + Enter
separado), então chega inteiro. `@Nome` autocompleta entre os agentes conectados
ao alvo e manda o mesmo prompt para eles também. Rascunho guardado por terminal
enquanto o app está aberto. *Fora de escopo:* colar screenshot inline — não há
caminho bom para enfiar imagem num PTY.

**Partituras.** O arranjo do grupo (CLIs, posições, papéis, notas, conexões,
desenhos, rotinas) salvo como JSON em `<data>\partituras\<nome>.json` e
reaplicável em outro projeto com ids novos. A pasta de trabalho **não** vai junto:
vem do projeto de destino. Menu do grupo ou do projeto → “Partituras…”.

**Andares.** Cópia isolada do trabalho por tarefa: cada andar é um
`git worktree` em `<projeto>\.yard\floors\<slug>` (branch `yard/<slug>` por
padrão), com grupo e canvas próprios — o chão continua intocado. Botão “camadas”
no canto inferior direito do workspace: criar (com opção de clonar o layout do
chão — terminais nascem parados, cwd do worktree), descarregar (suspende os PTYs
preservando sessão) e encerrar (recusado com trabalho não commitado; opção de
apagar a branch). Hooks opcionais de setup/run/teardown rodam no worktree com
`YARD_FLOOR_*` no ambiente. O painel de arquivos e o `git status` seguem o grupo
ativo: num andar, mostram o worktree, não o chão. Os metadados moram em
`layout_json.floor`; projeto sem git ainda ganha “andar” (`kind: plain`), só sem
isolamento. Aterrissar (merge no chão) ainda não existe.

## Regra de ouro

A UI **nunca** é dona do estado de processo. Montar um `XTermView` chama
`attach_pty` primeiro; se veio scrollback, só repinta; só spawna se não houver
nada. Fechar um painel não mata processo — matar é ação explícita. É isso que faz
HMR, F5 e troca de layout serem indolores para um agente no meio de uma tarefa.

## Testes

```powershell
npm test                   # vitest: núcleo da ponte, canvas, markdown das notas
cd src-tauri
cargo test --lib           # motor de PTY, agentes, persistência, shims da ponte
```

40 testes no Rust. Os de `pty::engine_tests` sobem PowerShell de verdade e
verificam os critérios de aceite da F1: saída chega ao scrollback e à UI, `write`
executa, `kill` não deixa órfão nenhum na árvore, `suspend` preserva histórico,
`restart` reusa o id, e 6 MB de saída não estouram o anel. `bridge::tests` trava o
nome do pipe (ele vai no ambiente de todo PTY — mudar quebraria terminais já
abertos) e garante os três shims + a ausência de sintaxe de PowerShell 7 no
`.ps1`.

Testes no vitest, sobre as promessas que a CLI faz aos agentes: dedup de nomes
(`claude (2)`), corrente de notas, o portão das conexões, o nome de nota derivado
da primeira linha, `normalizeCanvas` preservando os campos novos (rotinas,
presets, nota travada), `normalizeFloor` validando os metadados de andar e o
markdown das notas.

### O `ESC[6n` do ConPTY

Descoberta ao escrever esses testes, e vale saber: no handshake o conhost emite
`ESC[6n` (DSR-CPR) e **segura toda a saída do aplicativo até receber a resposta**.
Quem responde é o emulador do outro lado — o xterm.js faz isso sozinho, e é por
isso que o app funciona. Um leitor headless trava: o processo fica vivo, mudo e
parado, sem erro. Os testes incluem um terminal mínimo que responde `ESC[1;1R`.
Se algum dia o horizonte F7 do [roadmap](./docs/specs/05-roadmap.md) trouxer um
emulador em Rust, ele precisa fazer o mesmo.

## O que não está feito

- **Aterrissar andar.** Criar/listar/encerrar andares existe (worktree +
  canvas próprio + CLI), mas o merge do andar de volta no chão — com preview
  de conflito — ainda é manual (`git merge yard/<slug>` no chão). Também não
  há fan-out automático de uma tarefa para N agentes.
- **Portais** — cartão de navegador no canvas (ferramenta **W**). O motor
  nativo é WebView2; Chrome, Edge, Brave, Chromium e Firefox só ficam
  clicáveis se estiverem instalados (o mesmo critério das CLIs). O agente
  dirige com `yard portal snapshot/click/fill/…`.
- **Ombro** — painel que resume o que cada agente fez e sugere o próximo passo a
  partir dos JSONL de sessão que `agents/sessions.rs` já lê.
- **Screenshots inline no compositor** — decisão consciente: as CLIs esperam
  caminho de arquivo, e não há caminho bom para colar imagem num PTY.
- **F6 — Produto.** Sem updater assinado, sem CI de release, sem assinatura de
  código; a CSP ainda está em `null` e as capabilities do Tauri não foram
  auditadas para o mínimo necessário.

Validado de ponta a ponta com o app real: boot → restaurar workspace do SQLite →
attach → spawn → PTY vivo → scrollback em disco → crash do app não deixa órfão.
A interação com a UI (clicar, arrastar, redimensionar) não foi exercitada
automaticamente — só a lógica por trás dela.

## Estimativas de custo

Os preços por milhão de tokens estão em `agents/sessions.rs` e foram conferidos
em 2026-08-12 (Opus 5: US$ 5/25; Sonnet 5: 3/15; Haiku 4.5: 1/5; escrita de cache
1,25× a entrada, leitura 0,1×). Modelo fora da tabela não recebe estimativa
nenhuma — melhor nenhum número que um número inventado. **Confira a tabela quando
os preços mudarem.**

## Documentação

- [`docs/README.md`](./docs/README.md) — índice da documentação.
- [`docs/specs/`](./docs/specs) — visão e stack, arquitetura, motor de PTY,
  armadilhas do Windows, roadmap.
- [`docs/development.md`](./docs/development.md) — setup do ambiente, testes,
  CI/CD de release.
- [`docs/PRODUCT.md`](./docs/PRODUCT.md) e [`docs/DESIGN.md`](./docs/DESIGN.md)
  — contratos de produto e de design.

## Licença

Ainda não definida — decidir antes do primeiro commit público. MIT ou
Apache-2.0 são as candidatas (ver a
[nota em docs/development.md](./docs/development.md#licença)).
#   y a r d  
 