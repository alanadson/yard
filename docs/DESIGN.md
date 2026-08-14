---
name: Yard
description: Orquestrador de agentes com cara de instrumento macOS premium — mini-janelas escuras e materiais translúcidos sobre um chão ambiente profundo.
colors:
  bg: "#131316"
  bg-panel: "#1a1a1e"
  bg-raised: "#202025"
  bg-overlay: "#26262c"
  terminal-well: "#121215"
  bg-hover: "rgb(255 255 255 / 6.5%)"
  bg-active: "rgb(255 255 255 / 11%)"
  material-thin: "rgb(22 22 27 / 46%)"
  material-menu: "rgb(38 38 45 / 80%)"
  material-sheet: "rgb(30 30 36 / 82%)"
  border-soft: "rgb(255 255 255 / 4%)"
  border: "rgb(255 255 255 / 8%)"
  border-strong: "rgb(255 255 255 / 16%)"
  text: "#e2e2e6"
  text-dim: "#9e9ea6"
  text-bright: "#f7f7f9"
  accent: "#0a84ff"
  accent-bright: "#409cff"
  accent-text: "#7ab8ff"
  accent-dim: "rgb(10 132 255 / 20%)"
  accent-soft: "rgb(10 132 255 / 18%)"
  accent-border: "rgb(94 160 255 / 55%)"
  on-accent: "#ffffff"
  green: "#40d16e"
  green-bg: "rgb(64 209 110 / 13%)"
  yellow: "#f0c33c"
  yellow-bg: "rgb(240 195 60 / 12%)"
  red: "#ff6961"
  red-bg: "rgb(255 105 97 / 13%)"
typography:
  title:
    fontFamily: "Inter Variable, SF Pro Text, -apple-system, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Variable, SF Pro Text, -apple-system, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.005em"
  label:
    fontFamily: "Inter Variable, SF Pro Text, -apple-system, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  caption:
    fontFamily: "Inter Variable, SF Pro Text, -apple-system, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "SF Mono, Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "11px"
rounded:
  sm: "5px"
  control: "6px"
  md: "7px"
  lg: "10px"
  xl: "14px"
  pill: "20px"
components:
  button-primary:
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
  button-secondary:
    backgroundColor: "rgb(255 255 255 / 7.5%)"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
  input:
    backgroundColor: "rgb(0 0 0 / 26%)"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.md}"
    padding: "6px 9px"
  tooltip:
    backgroundColor: "rgb(46 46 52 / 96%)"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.control}"
    padding: "4px 9px"
  sidebar-row-active:
    backgroundColor: "rgb(10 132 255 / 26%)"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.md}"
  menu-item-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
  pane:
    backgroundColor: "{colors.bg-panel}"
    rounded: "{rounded.lg}"
---

# Design System: Yard

> Direção cravada pelo usuário em 2026-08-13: **"premium moderno, estilo macOS"**, com
> liberdade total no resto. O contrato de direção vive no comentário do `<body>` de
> `index.html`; a implementação inteira vive em `src/styles.css` (uma folha só).
> Este arquivo registra o sistema **como foi construído** — o código é a verdade.

## Overview

**Creative North Star: "Janelas de instrumento sobre o chão ambiente"**

Yard parece um instrumento macOS premium, escuro, da era Sonoma: mini-janelas de
terminal flutuando sobre um "desktop" profundo de grafite com dois brilhos frios
quase subliminares (azul e violeta) atrás do vidro. As superfícies flutuantes e
laterais são materiais translúcidos com blur (vibrancy); as superfícies que
seguram um terminal vivo são sólidas — o xterm repinta constantemente e o vidro
custaria quadros. Relevo vem de material e luz — hairlines brancas translúcidas
no topo das superfícies altas, sombras offset profundas e macias — nunca de
saturação. O mundo recusa explicitamente o arranjo padrão da categoria: o
"cromo cinza chapado de terminal escuro" (anti-referência registrada no
contrato de direção).

O cromo recua para o conteúdo do terminal protagonizar. Uma única cor de ação
(o azul de sistema `#0a84ff`) faz todo o trabalho de seleção, foco e comando;
verde/amarelo/vermelho existem apenas como semântica de estado de processo e de
diffs. Tudo responde com física curta e precisa (130/200 ms, easings de mola
curta), e `prefers-reduced-motion` desliga o teatro inteiro.

**Key Characteristics:**

- Escuro sempre (`color-scheme: dark`); chão ambiente com blooms azul/violeta.
- Vibrancy (blur + saturate) só em superfícies transitórias ou laterais; painéis de terminal sólidos.
- Azul de sistema como única cor de ação; croma restante estritamente semântica.
- Hairlines de luz (`inset 0 1px 0 rgb(255 255 255 / 6%)`) no topo das superfícies altas.
- Raios generosos e contínuos (5/6/7/10/14 px + cápsulas 20px + squircle da marca).
- Densidade de instrumento: tipo 11–14 px, controles de 25–33 px de altura.
- UI em português brasileiro; tudo empacotado, nada de rede em runtime.

## Colors

Um mundo acromático de grafites frios onde o azul de sistema é a única voz de
comando e o pouco de croma restante é informação, nunca decoração.

### Primary

- **Azul de sistema** (`--accent`, #0a84ff): a única cor de ação do cromo. Botão primário, seleção na sidebar, foco de painel, realce pleno de menu, trilhos de resize, barra do HUD, badge de alterações, `::selection` (35%), anel de foco (55%).
- **Azul claro** (`--accent-bright`, #409cff): pontos de não-lido e detalhes que precisam de um degrau a mais de luz.
- **Azul de texto** (`--accent-text`, #7ab8ff): texto/ícone azul legível sobre fundos escuros — sempre pareado com `--accent-dim` como chip/pílula (papéis de cartão, chips do compositor, botão de reinício).
- **Véus de azul** (`--accent-dim` 20%, `--accent-soft` 18%, `--accent-border` 55%): fundos e contornos do mesmo azul para estados selecionados/ativos sem gritar.
- **Sobre o azul** (`--on-accent`, #ffffff): texto/ícone sobre qualquer preenchimento azul, verde ou vermelho pleno.

### Semantic

A única croma além do azul — estado de processo e diffs, cada cor com seu véu de fundo:

- **Verde — rodando / adição** (`--green`, #40d16e; `--green-bg` 13%): dot de processo vivo (com glow `0 0 6px`), badge A, linhas `+` de diff, alvo válido de conexão no canvas.
- **Amarelo — iniciando / atenção** (`--yellow`, #f0c33c; `--yellow-bg` 12%): dot pulsante de starting, badge de conflito, pressão de memória em aviso.
- **Vermelho — erro / remoção** (`--red`, #ff6961; `--red-bg` 13%): dot de erro (com glow), badge D, linhas `−` de diff, ações destrutivas (hover de `.icon-btn--danger`, `.menu-danger`), toast de erro.
- Estados `exited`/`idle` são **neutros** (cinza esmaecido a 50%) — ausência de vida não ganha cor.

### Neutral

Da superfície mais profunda à mais alta (a elevação é tonal, além de sombreada):

- **Chão** (`--bg`, #131316): a cor-base da janela; o `<body>` pinta por cima o gradiente ambiente (`linear-gradient(178deg, #1b1b21 → #121216 → #141419)`) com três blooms radiais — azul 14% no topo-esquerdo, azul 6% embaixo-esquerdo, violeta `rgb(191 90 242 / 9%)` no canto inferior-direito.
- **Poço do terminal** (#121215): o degrau mais fundo — fundo de `.xterm-host`, do corpo do viewer e dos diffs; casa com o `background` do tema xterm.
- **Painel** (`--bg-panel`, #1a1a1e): corpo das mini-janelas (panes e cartões do canvas) — sólido, sempre.
- **Elevado** (`--bg-raised`, #202025): cabeçalhos de painel/cartão, banners, faixas de busca.
- **Sobreposto** (`--bg-overlay`, #26262c): notas do canvas e apoios de contraste.
- **Materiais translúcidos**: `--material-thin` (46%), `--material-menu` (80%), `--material-sheet` (82%) — ver Elevation & Depth.
- **Véus de interação** (`--bg-hover` branco 6.5%, `--bg-active` branco 11%): hover/pressed universais do cromo neutro.
- **Hairlines** (`--border-soft` 4%, `--border` 8%, `--border-strong` 16%): bordas são sempre branco translúcido, como no macOS escuro — nunca cinza opaco.
- **Texto** (`--text` #e2e2e6, `--text-dim` #9e9ea6, `--text-bright` #f7f7f9): todos ≥ 4.5:1 sobre `--bg` e `--bg-raised`. `--text-bright` marca o que está ativo/focado; `--text-dim` é o padrão de repouso de ícones e metadados.

### Named Rules

**A Regra da Croma Semântica.** Verde, amarelo e vermelho significam estado de
processo (rodando / iniciando / erro) e diffs (adição / remoção) — e nada mais.
Nenhuma superfície, ilustração ou ênfase decorativa usa essas cores.

**A Regra do Único Azul.** O azul de sistema #0a84ff é a única cor de ação.
Seleção, foco, comando primário e realce de menu são todos o mesmo azul; um
segundo acento não existe neste mundo.

**A Regra do Cromo Recuado.** O cromo é neutro e o terminal é o protagonista:
profundidade vem de material, luz e sombra — nunca de saturação no cromo.

## Typography

**Fonte da UI:** Inter Variable (empacotada offline via `@fontsource-variable/inter`,
importada em `src/main.tsx`), com fallback para SF Pro Text / Segoe UI Variable.
**Fonte mono:** SF Mono → Cascadia Mono → Consolas → ui-monospace (`--mono`) — terminal, caminhos, diffs, código e o compositor de prompts.

**Character:** face SF-like, neutra e densa; tracking levemente aberto no corpo
(0.005em) e levemente fechado nos títulos (−0.01em). Nada de display face — o
maior texto do app tem 17 px (h2 da tela de boas-vindas).

### Hierarchy

- **Title** (600, 14px / `--fs-lg`, letter-spacing −0.01em): cabeçalhos de modal e da tela de boas-vindas (esta a 17px, o teto do app).
- **Body** (400, 13px / `--fs-md`): o tamanho-base do app, definido no `:root`.
- **Label** (400, 12px / `--fs-sm`): abas, linhas de terminal na árvore, menus, breadcrumb, toasts — o tamanho do cromo denso.
- **Caption** (400, 11px / `--fs-xs`): dicas, metadados, tooltips, código inline. Micro-rótulos de seção (cabeçalhos da sidebar e de listas) usam caption em **600, uppercase, letter-spacing 0.6–0.7px** — o único uppercase do mundo.
- **Micro** (10px, literal): contadores, badges de papel, estatísticas de arquivo — sempre acompanhado de cor esmaecida.
- **Mono** (11–12px): sempre que o conteúdo é caminho, código ou diff; o corpo do compositor de prompts é mono de propósito (o usuário escreve para uma CLI).

### Named Rules

**A Regra dos Números Parados.** Números que mudam sozinhos (RAM, contagens,
diffs, zoom, relógios de rotina) usam `font-variant-numeric: tabular-nums` —
números não dançam.

**A Regra do Peso Comedido.** 400 é o repouso, 500 é ênfase leve, 600 é título
e estado ativo, 700 existe só em marcas e badges mono minúsculos. Peso acima
de 700 não existe no mundo.

## Layout

O chassi é uma coluna: barra de título (40px, `--titlebar-h`) sobre um
`app-body` flex com três regiões — sidebar (vibrancy, redimensionável),
workspace central e painel de arquivos/git à direita (vibrancy,
redimensionável). O workspace tem 10px de respiro, colapsando o lado onde uma
lateral aberta já fornece o divisor (`data-sidebar="open"` zera
`padding-left`).

- **Divisores**: faixas invisíveis de 7px (`.resizer`, `.resize-handle`); o trilho azul (2px de raio) só acende em hover, arrasto ou foco de teclado, a 60% de opacidade.
- **Densidade de instrumento**: icon-buttons 25px (20px dentro de linhas), linhas de árvore ≥ 27px, cabeçalho de pane 33px, cabeçalho de cartão do canvas 30px, barra de portal 28px, semáforo 12px por luz.
- **Grade de painéis**: cada pane é uma mini-janela completa; vãos de 7px entre painéis.
- **Canvas infinito**: um ponto de origem (`.cv-world`) transladado e escalado por `transform` (`screen = (world − viewport.xy) × zoom`); malha de pontos (`radial-gradient` branco 6.5%, 1px) como mesa; moldura hairline com raio 10.
- **Ancoragens fixas**: paleta de ferramentas em cápsula vertical à esquerda (centro), controle de zoom no canto inferior-direito, controle de Andares ao lado dele (offset 196px no canvas, 16px na grade), status do canvas no topo-centro, compositor no canto inferior-direito da janela (fixed, 22px), toast no rodapé-centro.
- **Sticky para orientação**: títulos de seção da revisão git e cabeçalhos de hunk de diff grudam no topo ao rolar, com fundo sólido para não vazar o conteúdo por baixo.

Não há breakpoints: é uma janela de desktop (Tauri, `decorations: false`);
larguras fluidas usam `min()` (`min(520px, 92vw)` etc.). Arrastar a janela
depende de `data-tauri-drag-region` nas áreas vazias da barra de título.

## Elevation & Depth

Sistema híbrido: camadas tonais (bg → panel → raised → overlay) + sombras
offset macias + hairlines de luz + materiais translúcidos. A elevação máxima é
vidro fosco profundo, não brilho.

### Receitas de material (vibrancy)

Cada material é um par cor translúcida + `backdrop-filter`, sempre acompanhado
de borda hairline branca (10–12%) e da hairline de topo:

- **Fino** (`--material-thin` rgb(22 22 27 / 46%) + `--blur-thin` blur(28px) saturate(170%)): barra de título, sidebar, painel de alterações — as superfícies laterais permanentes sobre o chão ambiente estático.
- **Menu** (`--material-menu` rgb(38 38 45 / 80%) + `--blur-menu` blur(24px) saturate(160%)): menus, popovers, paleta do canvas, controle de zoom, toasts, peek de diff, cápsula de status, botão de Andares.
- **Sheet** (`--material-sheet` rgb(30 30 36 / 82%) + `--blur-sheet` blur(48px) saturate(160%)): modais e o compositor de prompts. O viewer de diff usa quase-opaco rgb(28 28 34 / 94%) — tem código dentro.
- **Backdrop de modal**: rgb(0 0 0 / 45%) + blur(6px).

### Shadow Vocabulary

Sempre offset vertical + blur macio, em camadas; nunca um halo simétrico como elevação:

- **`--shadow-1`** (`0 1px 2px rgb(0 0 0 / 28%), 0 3px 10px rgb(0 0 0 / 22%)`): controles rasantes — zoom, cápsula de status, botão de Andares.
- **`--shadow-2`** (`0 12px 32px rgb(0 0 0 / 42%), 0 2px 8px rgb(0 0 0 / 30%)`): menus, popovers, toasts, cartões e notas do canvas.
- **`--shadow-3`** (`0 32px 80px rgb(0 0 0 / 55%), 0 8px 24px rgb(0 0 0 / 35%)`): modais, viewer, compositor — o topo da pilha.
- **`--hairline`** (`inset 0 1px 0 rgb(255 255 255 / 6%)`): o fio de luz no topo de toda superfície alta — relevo sem cor, composto junto das sombras (`box-shadow: var(--shadow-2), var(--hairline)`).
- Halos azuis (`0 0 0 3px rgb(10 132 255 / 14%)` etc.) são **estado** (foco, seleção, drag-over), não elevação.

### Escala Z (observada)

Menus laterais 40 · overlays do canvas 30/40 · compositor 60 · peek 90 · modal
100 · viewer 120 · toast 200 · tooltip 300 · menu popup 10000.

### Named Rules

**A Regra do Vidro Transitório.** `backdrop-filter` só existe em superfícies
transitórias (menus, modais, toasts, peek) ou laterais sobre o chão estático
(título, sidebar, alterações). Qualquer superfície que contenha um terminal
vivo é sólida (`--bg-panel`) — o xterm repinta constantemente e blur em cima
dele custa quadros.

**A Regra do Offset.** Sombra de elevação tem sempre deslocamento vertical e
blur macio. Um halo simétrico nunca significa altura — halo é linguagem de
estado (foco/seleção), e é sempre azul.

## Shapes

Linguagem de forma macOS: cantos generosos e contínuos, cápsulas para tudo que
é contagem ou status, círculos para tudo que é luz de estado.

- **Escala de raio**: 5px (`--r-sm`, micro-alvos), **6px (literal, o raio dos controles dentro do cromo** — itens de menu, abas, icon-buttons, segmentos, tooltips — usado em dezena e meia de lugares), 7px (`--r-md`, botões, inputs, linhas de árvore, notas), 8px (trilho de controles segmentados), 10px (`--r-lg`, painéis, cartões, menus, moldura do canvas), 14px (`--r-xl`, modais, viewer, compositor, paleta do canvas), 12px (toast).
- **Cápsulas** (border-radius 20px): pills de contagem, chips de revisão, badges de branch/papel, campo de URL do portal, cápsula de status, contadores de Andares.
- **Círculos**: semáforo, dots de estado, swatches de cor, badges de não-lido/concluído, rotina.
- **Squircle da marca** (border-radius 27%): o "Y" num quadrado arredondado com gradiente azul (165deg, #55a9ff → #0a72e8 → #085ec4) e luz interna vinda de cima — ícone-de-app macOS em 18px (barra), 44px (boas-vindas) e 48px (boot, respirando).
- **Tracejado = provisório ou travado**: pane vazio (borda dashed), nota travada (borda dashed + cadeado sempre visível), seleção no canvas (outline dashed azul com offset), portal focado (outline dashed).
- **Bordas**: hairline branca translúcida em tudo; a borda inferior de barras sobre conteúdo é preta translúcida (rgb(0 0 0 / 28–35%)) — sombra de contato, não linha.

## Components

### Barra de título & semáforo

Material fino com blur sobre o chão; borda inferior preta 35% + hairline.
Semáforo macOS à esquerda (`TitleBar/index.tsx`): três luzes de 12px —
fechar #ff5f57, minimizar #febc2e, ampliar #28c840 — com borda preta 22%; os
glifos (Lucide 8px, stroke 3.5, preto 62%) ficam a opacity 0 e aparecem em
hover ou focus-within do **grupo**, como no original. Pressionar escurece a
luz (`brightness(0.8)`). Breadcrumb central: projeto (com ícone e cor do
projeto) › grupo, com badge-cápsula de branch quando o grupo é um andar
isolado. À direita, o controle segmentado de layout e ações.

### Tooltip in-world (`[data-tip]`)

O primitivo que substitui o `title` nativo (caixa branca do Windows = material
estrangeiro): balão escuro rgb(46 46 52 / 96%), raio 6, hairline + sombra,
caption 11px, surge após 500ms de pausa (transition-delay) abaixo do controle.
Variantes por atributo: `data-tip-at="left|right"` ancora no lado do controle
perto das bordas da janela; `data-tip-side="top"` sobe (controles no rodapé);
`data-tip-side="right"` sai lateralmente (paleta vertical do canvas);
`data-tip-wrap` quebra textos longos a máx. 240px. `aria-label` continua sendo
quem fala com o leitor de tela — `data-tip` é só o visual. Elementos
substituídos (`<select>`) não têm `::after`: o balão vai num wrapper.

### Botões

- **Primário** (`.btn--primary`): push button macOS — gradiente `linear-gradient(180deg, #3395ff, #0a78ef)`, texto branco 600, luz interna `inset 0 1px 0 rgb(255 255 255 / 28%)`; hover clareia o gradiente, active escurece. É o único botão colorido da tela.
- **Padrão** (`.btn`): superfície branca 7.5% com borda 9% e fio de luz; hover 11%, active 15%.
- **Fantasma** (`.btn--ghost`): transparente com borda hairline, sem sombra. Variante `--sm` (3px 9px, 12px).
- **Icon-button** (`.icon-btn`): 25px, raio 6, ícone esmaecido; hover = véu branco + texto claro; variantes de intenção só no hover: `--danger` (véu e texto vermelhos), `--go` (verdes).
- **Desabilitado**: opacity 0.35–0.42, nunca cor nova.

### Controle segmentado

Trilho rebaixado (preto 26%, inset shadow, raio 8) com segmento ativo elevado
(branco 14%, sombra + fio de luz, raio 6) — usado no switch de layout da barra
de título e no viewer de diff. O mesmo padrão "trilho fundo / ativo elevado"
repete em abas de modal e do painel de alterações.

### Sidebar (source list)

Vibrancy fina; cabeçalho caption uppercase; linhas com raio 7 e **seleção em
pílula azul** (rgb(10 132 255 / 26%) + inset ring 18%) — não em faixa.
Terminais aninham a 38px; o focado ganha véu + ring azul 30% (quem recebe as
teclas se anuncia). Ações de linha aparecem só em hover/foco. HUD de sistema no
rodapé: barra de 3px azul que vira amarela (aviso) e vermelha (crítico) — a
única leitura do HUD que exige ação é a única com croma.

### Menus

Material de menu com blur, raio 10, itens em pílula (raio 6) com **realce azul
pleno** (fundo `--accent`, texto branco — ícone e atalho juntos). Separadores
hairline; item perigoso em vermelho que preenche no hover; linhas especiais
(swatches de cor, stepper `− valor + ↺`, tamanhos) viram chips lado a lado.
Entrada: `menu-in` (fade + translateY(−4px) + scale 0.98, 130ms).

### Painéis & cartões de terminal (mini-janelas)

A assinatura do mundo: cada terminal vive numa mini-janela macOS — corpo
sólido `--bg-panel`, raio 10, borda hairline, sombra + fio de luz; cabeçalho
`--bg-raised` (33px na grade, 30px no canvas) com abas, dots de estado e
ações. **Foco = borda azul 55% + halo 14%** e cabeçalho um degrau mais claro
(#24242b) — nunca "um cinza um tom mais claro". O poço do terminal é #121215
(mais fundo que o cromo), casando com o tema xterm. Dots de estado: 6px —
verde com glow (rodando), amarelo pulsando (iniciando), vermelho com glow
(erro), cinza 50% (idle/exited). Drag-over: borda + halo azuis; alvo de
conexão válido: verde.

### Terminal (tema ANSI)

`THEME` em `XTermView/index.tsx`: fundo #121215, texto #d9d9de, cursor #8ec2ff
sobre fundo do poço, seleção #2b446b. ANSI mantém semântica, afinada para o
chão frio: red #ff6e64, green #5bd57f, yellow #eac95c, blue #5fa8ff, magenta
#c98bf2, cyan #5fd2d2, white #d9d9de, brights um degrau acima (#8fc2ff,
#8ce3a4… até brightWhite #f7f7f9). Cores dentro do terminal são conteúdo, não
cromo — não seguem a Regra do Único Azul.

### Canvas infinito

Mesa transparente sobre o chão com malha de pontos; paleta de ferramentas em
**cápsula vertical** (material de menu, raio 14) à esquerda com ferramenta
ativa em azul pleno; controle de zoom em cápsula no canto (percentual
tabular). Notas: `--bg-overlay`, raio 7, cabeçalho-faixa de 9px na cor da
nota, markdown leve na leitura; travada = borda dashed + cadeado sempre
visível. Texto desenhado usa **caligrafia** ("Segoe Print", "Comic Sans MS",
cursive) — combina com as formas à mão livre (roughjs/perfect-freehand).
Paleta de desenho (`CANVAS_COLORS` em `lib/canvas.ts`): #f5f5f5, #a3a3a3,
#6b6b6b + as mesmas famílias semânticas/de projeto (#ff6961, #40d16e,
#f0c33c, #5fa8ff, #c98bf2). Conexões: espessuras em unidades de mundo no CSS
(2 → 2.6 hover → 3 selecionada; halo 10 a 18%), fio provisório tracejado
animado. Grips de resize: `--cv-grab: min(30px, calc(11px / var(--cv-z)))` —
~11px de tela em qualquer zoom; nos portais os grips penduram inteiramente
fora do cartão (a superfície nativa do navegador engole pointer events).
Longe demais para ler (`.cv--far`), um scrim acorda sobre os cartões e tudo
vira pan.

### Modais, viewer & compositor

Sheets macOS: material-sheet com blur profundo, raio 14, borda 12%, shadow-3 +
hairline, entrada `modal-in` (fade + translateY(10px) + scale 0.97, 200ms,
ease-pop) sobre backdrop escurecido com blur. Rodapé com fundo preto 14%.
Viewer de diff: mesma janela em quase-opaco (94%) com rail lateral de
arquivos (seleção em pílula azul). Compositor: sheet ancorada no canto
inferior-direito, corpo em mono, menu de menções que **sobe**.

### Ao Vivo (mission control de agente)

Overlay de vidro (material-sheet + blur profundo, raio 14, shadow-3 +
hairline) sobre o workspace inteiro, em z 110 — acima dos modais, abaixo do
viewer de diff. É a única superfície grande com vibrancy total: não contém
xterm. Abre pelo botão `Activity` no cabeçalho do painel (só em CLIs de
agente; com o processo vivo o glifo respira em verde — semântica de
processo). Cabeçalho: barras de EQ verdes animadas enquanto o agente
trabalha, cápsula de status (`trabalhando`/`pensando`/`ocioso`), chips de
modelo/tokens/custo em tabular-nums, seletor de sessão e fechar (Esc e
clique no backdrop também fecham). Ticker com a última fala/reflexão do
agente. Corpo em três colunas: linha do tempo (badges M/A como os diffs,
caminhos mono com elipse que preserva o basename, `+n −n` verde/vermelho,
spinner em ferramenta pendente, prompt do usuário em véu azul), arquivos
tocados (agregado por arquivo, clique abre o viewer de diff quando há repo)
e o quadro kanban (plano do agente em A fazer/Fazendo/Feito com pulse verde
no card ativo; sub-agents em Rodando/Concluídos com tempo decorrido).
Entradas novas usam `live-in` (fade + translateY 4px, 200ms ease-pop).
Dados vêm do grampo da sessão no backend (`agents/tail.rs`, evento
`session://feed`), reduzidos em `stores/liveStore.ts`.

### Toast

Cápsula (raio 12) de material de menu no rodapé-centro, entra de baixo com
mola curta (240ms ease-pop). Erro: borda vermelha 40% + texto rosado #ffb4ae.

### Diffs & badges

Badges de arquivo estilo VS Code: quadradinhos 14px mono 700 — A verde, D
vermelho, M azul, conflito amarelo, cada um sobre seu véu. Linhas de diff:
véus de 9% (verde/vermelho) com sinal e número na cor a 90%; o núcleo mudado
(`.demph`) sobe para 26%. Célula vazia do lado-a-lado: hachura diagonal sutil.

### Scrollbars

Overlay macOS: finas, arredondadas, sem trilho — 9px no cromo (thumb branco
18% → 32% hover), 6px dentro do terminal (mais discreta que a do cromo).

### Identidade de projeto

O usuário escolhe ícone (registro `PROJECT_ICONS`, Lucide, ~40 opções) e cor
(`PROJECT_COLORS` em `lib/projectStyle.ts`): null (neutro), #5fa8ff, #5fd2d2,
#40d16e, #f0c33c, #ffa35c, #ff6961, #ff7fa6, #c98bf2 — os matizes de sistema
macOS afinados para o chão escuro, mesma família de croma dos tokens
semânticos e do canvas. A cor do projeto tinge só o ícone no breadcrumb/árvore
e cabeçalhos de cartão — identidade é do conteúdo do usuário, não do cromo.

### Ícones

Lucide em toda parte, 10–14px no cromo (12–13 típico), stroke padrão; 3.5 só
nos glifos minúsculos do semáforo. `aria-hidden` quando decorativos.

## Do's and Don'ts

### Do:

- **Do** manter todo terminal vivo sobre superfície sólida (`--bg-panel` / poço #121215); blur é para menus, modais, toasts, laterais e transitórios.
- **Do** usar #0a84ff para toda ação, seleção e foco — e as três cores semânticas apenas para estado de processo e diffs, cada uma com seu véu `-bg`.
- **Do** usar `data-tip` (+ variante de ancoragem certa) com `aria-label` para toda dica — nunca o `title` nativo.
- **Do** compor elevação como `box-shadow: var(--shadow-N), var(--hairline)` — sombra offset macia + fio de luz no topo.
- **Do** usar `tabular-nums` em qualquer número que muda sozinho.
- **Do** manter transições nos caminhos quentes restritas a cor/borda/opacidade/sombra, em 130/200ms com `--ease`/`--ease-pop`.
- **Do** manter o anel de foco visível (`outline: 3px solid rgb(10 132 255 / 55%)`) em tudo que é clicável, e estados visíveis sem hover (foco, processo, trava, andar ativo).
- **Do** empacotar todo recurso (fontes via @fontsource) — nada de rede em runtime; texto do cromo ≥ 4.5:1.
- **Do** marcar áreas arrastáveis da barra de título com `data-tauri-drag-region` (janela sem decoração).

### Don't:

- **Don't** alterar a matemática dos grips do canvas (`--cv-grab` / `--cv-z`, offsets externos dos grips de portal) nem as regras de `pointer-events` das camadas `.cv-*` — comportamento crítico, não estética.
- **Don't** deixar `will-change: transform` permanente no `.cv-world` — ele existe só durante o pan; permanente, congela o raster e todo zoom fica borrado.
- **Don't** remover ou enfraquecer os blocos `@media (prefers-reduced-motion: reduce)`.
- **Don't** introduzir croma decorativa, um segundo acento, ou verde/amarelo/vermelho fora de estado e diff.
- **Don't** usar halo simétrico como sombra de elevação — halo é estado (foco/seleção) e é azul.
- **Don't** pôr `backdrop-filter` (ou animação cara) sobre um painel que contém xterm.
- **Don't** sinalizar foco de painel com "cinza um tom mais claro" — foco é borda azul + halo.
- **Don't** usar uppercase fora dos micro-rótulos de seção (11px/600/0.6–0.7px), nem pesos acima de 700.
- **Don't** trocar a família Lucide ou misturar outra família de ícones no cromo.
