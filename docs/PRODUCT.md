# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Desktop: Tauri 2 + WebView2 no Windows. A linguagem visual é própria do app —
janela sem decoração com barra de título custom — não a do sistema.)

## Users

Desenvolvedores no Windows que rodam vários agentes de código (Claude Code,
Codex, OpenCode…) e shells em paralelo, em sessões longas, muitas vezes à noite.
O usuário primário hoje é o próprio autor. *(inferido do README e do histórico
do projeto; não confirmado em entrevista — o usuário concedeu liberdade total)*

## Product Purpose

Orquestrar agentes de código: cada agente/shell num terminal real (PTY),
organizados em projetos → grupos → terminais, com grade de painéis, modo
canvas infinito (cartões, notas, desenho, conexões), persistência do layout e
do scrollback, e uma ponte CLI (`yard`) pela qual os agentes conversam entre
si e com o app. Sucesso = o usuário acompanha e coordena N agentes sem perder
nada do que aconteceu em nenhum terminal.

## Positioning

As conexões desenhadas no canvas **regulam** quem fala com quem via CLI — o
desenho é a topologia real da colaboração entre agentes, não decoração.
Terminais sobrevivem a HMR/F5/troca de layout porque a UI nunca é dona do
processo.

## Operating Context

- Sessões longas com 2–6+ terminais visíveis; o conteúdo do terminal é o
  protagonista absoluto da tela.
- Fluxos: criar projeto/grupo, abrir CLIs, dividir painéis, canvas com notas e
  conexões, compositor de prompts (Ctrl+Enter), painel de arquivos/git à
  direita, andares (worktrees isolados), partituras (arranjos salvos).
- Atalhos de teclado por toda parte (Ctrl+T, Ctrl+B, Ctrl+1..6, V H P E R O L
  A T N C no canvas).

## Capabilities and Constraints

- xterm.js (canvas/WebGL) repinta constantemente: cromo pesado sobre o
  terminal custa quadros — efeitos caros só em superfícies transitórias.
- Cores ANSI dentro do xterm são semânticas e precisam de contraste.
- Estados de processo: running (verde), starting (amarelo), error (vermelho),
  exited/idle (neutro) — a única croma semântica do cromo.
- Zoom do canvas é `transform: scale`; grips de resize têm matemática própria
  (`--cv-grab`/`--cv-z`) que não pode mudar de comportamento.
- Janela `decorations: false`: arrastar depende de `data-tauri-drag-region`.
- App precisa funcionar offline (sem fontes/recursos de rede em runtime).

## Brand Commitments

- Nome: **Yard**; marca é um "Y" num quadrado arredondado.
- Direção visual **cravada pelo usuário em 2026-08-13**: "premium moderno,
  estilo macOS", com liberdade total concedida para o resto. Substitui o mundo
  anterior ("monocromo profundo", branco como cor de ação).
- Idioma da UI: português brasileiro.

## Evidence on Hand

- README.md descreve funcionalidades reais (F0–F4, canvas, ponte, andares,
  partituras) — nada precisa ser inventado.
- Preços/custos de tokens vêm de `agents/sessions.rs`; não fabricar números.

## Product Principles

1. O cromo nunca compete com o conteúdo do terminal — profundidade vem de
   material e luz, não de saturação.
2. Croma é semântica: estado de processo e diffs; o resto do cromo é neutro.
3. Estado visível sem hover: foco, processo vivo, nota travada, andar ativo.
4. Nada de rede em runtime; tudo empacotado.
5. Números que mudam sozinhos não dançam (tabular-nums).

## Accessibility & Inclusion

Contraste ≥ 4.5:1 no texto do cromo sobre as superfícies; foco visível por
teclado em tudo que é clicável; `prefers-reduced-motion` respeitado.
