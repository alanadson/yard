# Visão e stack

> Origem: blueprint de arranque do projeto (agosto/2026), revisado para
> publicação. O estado real de implementação está no
> [roadmap](./05-roadmap.md) e no [README](../../README.md).

## 1. O que estamos construindo

Um aplicativo desktop **local-first** para rodar, organizar e retomar
**múltiplos agentes de código** (Claude Code, Codex, OpenCode, Gemini CLI,
Cursor CLI etc.) e shells comuns **em paralelo**, cada um em seu próprio
terminal real (PTY), organizados em projetos, grupos e painéis divididos, com
histórico e layout persistidos em disco. O objetivo de longo prazo é chegar ao
patamar de um "ADE" (Agent Development Environment): um lugar único onde você
dispara tarefas para vários agentes, acompanha o andamento, revisa o resultado
e faz merge do vencedor.

A tese central: **o núcleo inteiro em Rust** (PTY, processos, git,
persistência, watchers, recursos) e a **UI como camada fina de renderização**
em WebView2 — porque não existe hoje um widget de terminal maduro em GUI
nativa Rust, e o xterm.js é o padrão de facto da indústria (é o terminal do
VS Code).

Dessa tese deriva a **regra de ouro** do app: a UI **nunca** é dona do estado
de processo — o backend é a fonte da verdade, e a UI reconstrói tudo via
"attach" (detalhada na [arquitetura](./02-architecture.md#4-contrato-ipc-comandos--eventos)).

## 2. Decisão de stack (e por quê)

### Escolha: Tauri 2 + Rust + WebView2 + React/TypeScript + xterm.js

Rust faz **100% do trabalho pesado**: spawn e gestão de PTYs (ConPTY via
`portable-pty`), árvore de processos e Job Objects, scrollback em disco,
SQLite, git/worktrees, watchers de arquivo, supervisor de recursos,
credenciais no Windows Credential Manager. O TypeScript fica restrito a
renderizar: xterm.js pinta os bytes, React organiza os painéis, Zustand guarda
o estado de UI. Motivos objetivos:

1. **O Rust vai onde importa.** Num app desses, o valor está no motor
   (processos, I/O, persistência, confiabilidade), não no CSS. Tauri coloca o
   Rust exatamente nesse lugar.
2. **Não existe widget de terminal maduro em GUI nativa Rust.** egui/iced/Slint
   exigiriam implementar um emulador VT (parser de escapes ANSI, grid, reflow,
   seleção, IME, ligaduras…) — meses de trabalho antes da primeira feature. O
   xterm.js resolve isso hoje, com qualidade VS Code.
3. **Peso e distribuição no Windows.** WebView2 já vem no Windows 10/11 →
   instalador de ~10 MB e menos RAM base que os ~150 MB típicos de um app
   Electron equivalente.
4. **Ecossistema pronto:** `tauri-plugin-updater` (auto-update assinado),
   `single-instance`, `notification`, `dialog` — tudo mantido oficialmente.

### Alternativas consideradas e descartadas

| Alternativa                             | Por que não (agora)                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron + Node**                     | Núcleo em Node, não Rust; binário e RAM ~10× maiores; seria preciso reescrever depois para cumprir o objetivo "em Rust".                                                     |
| **GUI nativa Rust** (egui, iced, Slint) | Sem widget de terminal; reimplementar VT100+renderização é um projeto em si.                                                                                                 |
| **GPUI (framework do Zed)**             | O mais bonito tecnicamente, mas ainda instável como framework independente e com suporte Windows em amadurecimento. Reavaliar em 1 ano.                                      |
| **wezterm-term/termwiz como emulador**  | Não é GUI, é a _biblioteca_ de emulação VT do WezTerm em Rust. Descartada para a F1, mas **anotada como F7**: é o caminho para ter o terminal headless no backend, 100% Rust. |

### Versões-alvo

Rust stable ≥ 1.80 (toolchain **MSVC**), Tauri 2.x, Node 20 LTS, React 18
(não 19 — casa melhor com `react-resizable-panels` e o restante do ecossistema
de UI), TypeScript 5.x, Vite 6, `@xterm/xterm` 5.5 estável com
`@xterm/addon-canvas` (o addon WebGL funciona no WebView2, mas o canvas é o
caminho comprovadamente estável — WebGL fica atrás de uma flag em
Preferências).

## Referências externas

- Tauri 2: `tauri.app` (guias de janela custom, updater, capabilities, bundling NSIS)
- `portable-pty` (crate do WezTerm): `docs.rs/portable-pty`
- `wezterm-term` / `termwiz` (horizonte F7): emulação VT em Rust
- xterm.js: `xtermjs.org` (addons fit/canvas/search/unicode11)
- ConPTY: doc "Windows Pseudo Console (ConPTY)" da Microsoft
- Job Objects: doc Win32 `CreateJobObjectW` / `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
- `react-resizable-panels`, `zustand`, `dnd-kit` — bases da UI
