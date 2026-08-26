---
name: Yard
description: Agent orchestrator that looks like a premium desktop instrument — grey mini-windows and translucent materials on a flat black ground.
colors:
  bg: "#000000"
  bg-panel: "#191919"
  bg-raised: "#222222"
  bg-overlay: "#2c2c2c"
  terminal-well: "#000000"
  bg-hover: "rgb(255 255 255 / 6.5%)"
  bg-active: "rgb(255 255 255 / 11%)"
  material-thin: "rgb(47 47 47 / 36%)"
  material-menu: "rgb(51 51 51 / 62%)"
  material-sheet: "rgb(45 45 45 / 68%)"
  border-soft: "rgb(255 255 255 / 5%)"
  border: "rgb(255 255 255 / 9%)"
  border-strong: "rgb(255 255 255 / 18%)"
  text: "#e2e2e2"
  text-dim: "#a6a6a6"
  text-bright: "#f7f7f7"
  accent: "#0a84ff"
  accent-bright: "#409cff"
  accent-text: "#7ab8ff"
  accent-dim: "rgb(10 132 255 / 20%)"
  accent-soft: "rgb(10 132 255 / 18%)"
  accent-border: "rgb(94 160 255 / 55%)"
  on-accent: "#ffffff"
  accent-fill: "#0f6fd6"
  accent-grad: "linear-gradient(180deg, #1a6fd6, #0a5fc4)"
  accent-grad-hover: "linear-gradient(180deg, #1f72db, #0f66cc)"
  accent-grad-active: "linear-gradient(180deg, #1565c8, #0a5299)"
  red-fill: "#d13b32"
  green: "#40d16e"
  green-bg: "rgb(64 209 110 / 13%)"
  yellow: "#f0c33c"
  yellow-bg: "rgb(240 195 60 / 12%)"
  red: "#ff6961"
  red-bg: "rgb(255 105 97 / 13%)"
typography:
  screen-title:
    fontFamily: "Inter Variable, SF Pro Text, -apple-system, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    letterSpacing: "-0.01em"
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
  micro:
    fontFamily: "Inter Variable, SF Pro Text, -apple-system, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 400
  mono:
    fontFamily: "SF Mono, Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "11px"
  handwriting:
    fontFamily: "Segoe Print, Comic Sans MS, cursive"
    fontSize: "13px"
rounded:
  sm: "6px"
  md: "9px"
  track: "8px"
  tab: "10px"
  lg: "14px"
  xl: "20px"
  card: "18px"
  card-in: "17px"
  panel: "24px"
  panel-in: "23px"
  capsule: "999px"
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
    backgroundColor: "rgb(47 47 47 / 96%)"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.control}"
    padding: "4px 9px"
  sidebar-row-active:
    backgroundColor: "rgb(10 132 255 / 26%)"
    textColor: "{colors.text-bright}"
    rounded: "{rounded.md}"
  menu-item-hover:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
  pane:
    backgroundColor: "{colors.bg-panel}"
    rounded: "{rounded.lg}"
---

# Design System: Yard

> Direction pinned by the author on 2026-08-13: **"modern premium"** (translucent materials, mini-windows), with
> full freedom for the rest. The direction contract lives in the `<body>` comment of
> `index.html`; the entire implementation lives in `src/styles.css` (a single sheet).
> This file records the system **as it was built** — the code is the truth.

## Overview

**Creative North Star: "Instrument windows over the ambient ground"**

Yard looks like a premium desktop instrument, dark and translucent: terminal
mini-windows floating on a flat black "desktop". The ground carried a graphite
gradient and two cold, subliminal glows (blue and violet) behind the glass
until 2026-08-26; on black neither could stay subliminal, and the ground gave
up light altogether so that every bit of relief sits on the surfaces instead. The floating and lateral
surfaces are translucent materials with blur (vibrancy); the surfaces that hold
a live terminal are solid — xterm repaints constantly and glass would cost
frames. Relief comes from material and light — translucent white hairlines
along the top of raised surfaces, deep and soft offset shadows — never from
saturation. The world explicitly refuses the category's default arrangement:
the "flat grey chrome of a dark terminal" (the anti-reference recorded in the
direction contract).

The chrome recedes so the terminal content can take the lead. A single action
colour (the system blue `#0a84ff`) does all the work of selection, focus and
command; green/yellow/red exist only as semantics for process state and diffs.
Everything responds with short, precise physics (130/200 ms, short spring
easings), and `prefers-reduced-motion` switches the whole theatre off.

**Key Characteristics:**

- Dark by default (`color-scheme: dark`), on a flat, achromatic **#000000** ground with content wells at the same black; an elevation ladder graded ~4.5 CIE L\* points per step, so a surface can be told from the one under it without any of them leaving the black.
- Vibrancy (blur + saturate) only on transient or lateral surfaces; terminal panes solid.
- System blue as the single action colour; the remaining chroma strictly semantic.
- Hairlines of light (`inset 0 1px 0 rgb(255 255 255 / 12%)`) along the top of raised surfaces.
- Generous, continuous radii (6/8/9/14/20 px + 20px/999px capsules + the brand squircle).
- Instrument density: type 11–14 px, controls 25–33 px tall.
- UI in Brazilian Portuguese; everything bundled, no network at runtime.

## Colors

An achromatic world of neutral greys on black, where the system blue is the only voice
of command and the little chroma that remains is information, never decoration.

### Primary

- **System blue** (`--accent`, #0a84ff): the chrome's only action colour. Primary button, sidebar selection, pane focus, full menu highlight, resize rails, HUD bar, the open-panel toggles in the title bar, `::selection` (35%), focus ring (55%).
- **Light blue** (`--accent-bright`, #409cff): unread dots and details that need one more step of light.
- **Text blue** (`--accent-text`, #7ab8ff): readable blue text/icon over dark backgrounds — always paired with `--accent-dim` as a chip/pill (card roles, composer chips, restart button).
- **Blue veils** (`--accent-dim` 20%, `--accent-soft` 18%, `--accent-border` 55%): backgrounds and outlines in the same blue for selected/active states without shouting.
- **On blue** (`--on-accent`, #ffffff): text/icon over any full blue, green or red fill.
- **Fills that carry white text** (`--accent-fill` #0f6fd6, `--red-fill` #d13b32; gradients `--accent-grad` / `-hover` / `-active`): the system blue is a **surface** colour — white over `--accent` measures 3.65:1 and the product committed to 4.5:1. Same hue, one step deeper, for the primary button, menu highlight, dangerous item and count badges. Never use raw `--accent` or `--red` behind white text.

### Semantic

The only chroma besides blue — process state and diffs, each colour with its background veil:

- **Green — running / addition** (`--green`, #40d16e; `--green-bg` 13%): live-process dot (with `0 0 6px` glow), A badge, `+` diff lines, valid connection target on the canvas.
- **Yellow — starting / attention** (`--yellow`, #f0c33c; `--yellow-bg` 12%): pulsing starting dot, conflict badge, memory pressure at warning level.
- **Red — error / removal** (`--red`, #ff6961; `--red-bg` 13%): error dot (with glow), D badge, `−` diff lines, destructive actions (hover of `.icon-btn--danger`, `.menu-danger`), error toast.
- `exited`/`idle` states are **neutral** (grey dimmed to 50%) — absence of life earns no colour.

### Neutral

From the deepest surface to the highest (elevation is tonal as well as shadowed).

The ladder is graded in **CIE L\***, not in the contrast ratio the rest of this
document uses, because a ratio is a ratio of luminances and luminance is
crushed at the dark end: down where this whole world lives, a step the eye
reads and a step it does not both measure about 1.2:1. Adjacent surfaces sit
**five L\* points apart** — enough to be told apart at a glance, never enough
to leave the dark. `lib/contrast.ts` carries the measure and the
`dark elevation ladder` block of `src/styles.test.ts` refuses the collapse.

> Re-graded three times on 2026-08-26, each pass only legible once the one
> before it was done. The four steps were #131316 / #1a1a1e / #202025 /
> #26262c — L\* 6 → 9.4 → 12.4 → 15.4, three points apart, over an ambient
> whose darkest stop sat level with the terminal well. Every reading this
> world is built on is a difference between two surfaces, and at that spacing
> none arrived: the sidebar was the floor, the status bar was the floor,
> `--material-thin` composited to within half a point of the ambient behind
> it. The window read as one flat slab of near-black. **Opening** the steps to
> five points fixed that and exposed the complaint underneath — it was not
> black *enough* — so the ladder **dropped** in one piece to YouTube's depth,
> keeping the openness. Which exposed the last one: with the ground that dark
> the gradient and its blooms stopped being subliminal and became a visible
> wash of navy across the top of the sidebar. So the ground went **flat and
> black**, and the greys gave up the cold tilt they carried (`b ≈ r × 1.16`) —
> a good idea over an ambient with blue in it, a residue once there is none.

- **Ground** (`--bg` and `--ambient`, both #000000): the window's base colour, and one flat opaque black — no gradient, no bloom, no hue. `src/styles.test.ts` refuses a `gradient` in `--ambient` and refuses a chromatic value in any surface token, because a wash on the ground is exactly what creeps back.
- **Terminal well** (#000000): the floor, with nothing under it — background of `.xterm-host`, of the viewer body and of the diffs. It is this app's video player, and it went to pure black when the ladder dropped: every ANSI ratio only widened, and the one that had to stay off the bottom is the palette's own `black` (#1d1d22), so a CLI drawing in it is still visible against the background. `lib/termTheme.ts` opens the xterm palette on this exact colour — a seam no CSS token can cross, since xterm paints its background on a canvas, and one `termTheme.test.ts` now holds against the sheet's own declaration instead of against a sentence in a comment.
- **Panel** (`--bg-panel`, #191919): body of the mini-windows (panes) — solid, always. On the canvas the card uses the same paint at 92% (`rgb(26 26 26 / 92%)`, no blur): the dot grid shows faintly through the chrome, which says there is a table underneath, and the terminal body stays opaque.
- **Raised** (`--bg-raised`, #222222): pane/card headers, banners, search strips.
- **Overlay** (`--bg-overlay`, #2c2c2c): canvas notes and contrast supports.
- **Translucent materials**: `--material-thin` (36%), `--material-menu` (62%), `--material-sheet` (68%) — see Elevation & Depth. Their paint is lighter than the ground they sit on, which is the point: glass mixed from the same value as its backdrop is a no-op with a GPU cost.
- **Interaction veils** (`--bg-hover` white 6.5%, `--bg-active` white 11%): the universal hover/pressed of the neutral chrome.
- **Hairlines** (`--border-soft` 5%, `--border` 9%, `--border-strong` 18%): borders are always translucent white, as in a dark glass theme — never opaque grey. One point each above what they were: a white veil buys less separation as the surface under it climbs.
- **The three channels** (`--veil` white, `--well` black, `--shade` black): everything neutral in the app is one of three gestures — a surface *lifted* off its ground, a surface *sunk* into it, or a shadow a surface *throws*. Each is written as `rgb(var(--veil) / 9%)`, channel in the token and alpha at the call site, so the appearance re-values three lines instead of six hundred declarations. A veil on a **chromatic** fill (the inner light of the blue button, the glow of a status dot, a note in the colour its author chose) is not neutral and stays literal white in both appearances.
- **Floating surfaces** (`--material-panel` the bench 60%, `--material-doc` the editor and diff viewer 94%, `--material-notes` the notebook 86%, `--material-tip` balloons 96%, `--material-sticky` a header content slides under 96%, `--slab` the body of a board node at 92% and of the empty pane at 55%): each of these was a literal in one component sheet before it was a token.
- **Content wells** (`--well-code` and `--well-stage`, both #000000): where the app stops being chrome and shows code, a terminal or a picture. In the dark they *are* the ground — black has no step below it — so the sink that used to separate a well from its floor is gone and the frame pays for it instead: the pane draws a border and a hairline around whatever holds one. They stay two tokens because on paper they differ (#fafafc and #eef0f5).
- **Text** (`--text` #e2e2e2, `--text-dim` #a6a6a6, `--text-bright` #f7f7f7): all ≥ 4.5:1 over every surface of the ladder — and the one that decides it is the highest, the tooltip — at L\* 24 when the ladder was opened, where the dim ink measured 3.97:1 and had to move up with it, and at L\* 19 now that the ladder has dropped, where it reads 5.58:1. `--text-bright` marks what is active/focused; `--text-dim` is the resting default for icons and metadata.

### Light theme

The dark world above is the product's identity and the CSS that paints with
no help. **Configurações → Interface → Tema** offers *Escuro · Claro ·
Sistema*; light and system stamp `<html data-theme="light">` (`lib/theme.ts`,
`stores/themeStore.ts`), and `src/theme-light.css` — loaded on boot right
after `styles.css` — redefines the same tokens for paper. Dark is the
*absence* of the attribute: nothing changes for whoever never opens the
setting.

- **What stays:** the system blue (`--accent`, `--accent-fill`, the
  gradients), the radii, the materials' blur, the semantic hues' meaning.
- **Paper** (`--bg` #eceef3 → `--bg-panel` #f7f8fb → `--bg-raised`/`--bg-overlay`
  #ffffff), the ambient with the same three blooms over a light gradient.
- **Ink** (`--text` #1d1d22, `--text-dim` #5c5d66, `--text-bright` #0a0a0c):
  all ≥ 4.5:1 over every paper; `--accent-text` deepens to #0b5ec2 for the
  same reason.
- **The three channels flip, and the app follows** — `--veil` white → black
  (relief on paper is ink; white would vanish), `--well` black → slate
  `120 122 134` (the same alpha that dents a #202025 surface would punch a
  hole in a #f7f8fb one), `--shade` black → `46 50 62` (a shadow keeps its
  weight and loses its blackness). `--bg-hover` and `--border` are black on
  paper for the same reason. This is what makes the light appearance a
  re-valuation and not a rewrite: the first version of the sheet tried to
  patch the literals selector by selector, could only reach `styles.css`, and
  shipped with the bench dark under dark ink, every tooltip in the app black
  on black and some three hundred hover states painted white on paper.
- **Semantic inks deep enough for their own tint** (`--green` #146c2e,
  `--red` #b3261e, `--yellow` #7f5500): the floor a state colour has to clear
  is not the panel but the chip it sits in — every state in this app paints
  `--x-bg` behind `--x`. `--accent-bright` deepens to #0a4fa8: on the dark
  side "brighter" means lighter, on paper it means deeper.
- **The terminal well** has its own palette (`lib/termTheme.ts`,
  `LIGHT_TERM`: paper #fafafc, body text 7:1, every ANSI hue ≥ 3:1); the
  editor's `yardHighlight` reads `--syn-*` tokens with the dark values as
  fallbacks, and the canvas keeps its elevation steps with daylight values.
- A color-scheme extension still wins over both palettes: it is the user's
  explicit choice.

The ground is painted **before any sheet arrives**, by an inline `<style>` in
`index.html` that keys on `prefers-color-scheme` and on `data-theme`, plus a
three-line script that restores the last resolved appearance from
`localStorage` (`applyTheme` writes it). It used to be
`<body style="background: #131316">`, which never stopped winning: an inline
declaration outranks every author rule, so the light appearance composited
every one of its translucent materials over a black floor.

`src/theme-light.test.ts` locks the boot order, the contrast floors, the fact
that no sheet writes a neutral veil as a literal any more, and — the mirror of
the sweeper in `styles.test.ts` — that no rule paints text under 4.5:1 over
its own background once the light table is in hand. `lib/termTheme.test.ts`
does the same for the well.

### Named Rules

**The Semantic Chroma Rule.** Green, yellow and red mean process state
(running / starting / error) and diffs (addition / removal) — and nothing else.
No surface, illustration or decorative emphasis uses those colours.

**The Single Blue Rule.** The system blue #0a84ff is the only action colour.
Selection, focus, primary command and menu highlight are all the same blue; a
second accent does not exist in this world. The blue has two roles, not two
identities: `--accent` paints surface, border and veil; `--accent-fill` (and the
gradients) paint whatever has **white text on top**, because only the deeper
step reaches 4.5:1.

**The Receding Chrome Rule.** The chrome is neutral and the terminal is the
protagonist: depth comes from material, light and shadow — never from
saturation in the chrome.

## Typography

**UI font:** Inter Variable (bundled offline via `@fontsource-variable/inter`,
imported in `src/main.tsx`), falling back to SF Pro Text / Segoe UI Variable.
**Mono font:** SF Mono → Cascadia Mono → Consolas → ui-monospace (`--mono`) — terminal, paths, diffs, code and the prompt composer.

**Character:** an SF-like face, neutral and dense; tracking slightly open in
body text (0.005em) and slightly tight in titles (−0.01em). No display face —
the largest text in the app is 17 px (the welcome screen's h2).

### Hierarchy

- **Title** (600, 14px / `--fs-lg`, letter-spacing −0.01em): modal headers and the welcome screen (the latter at 17px, the app's ceiling).
- **Body** (400, 13px / `--fs-md`): the app's base size, set on `:root`.
- **Label** (400, 12px / `--fs-sm`): tabs, terminal rows in the tree, menus, breadcrumb, toasts — the size of dense chrome.
- **Caption** (400, 11px / `--fs-xs`): hints, metadata, tooltips, inline code. Section micro-labels (sidebar and list headers) use caption at **600, uppercase, letter-spacing 0.6–0.7px** — the only uppercase in the world.
- **Micro** (10px, literal): counters, role badges, file stats — always accompanied by a dimmed colour.
- **Mono** (11–12px): whenever the content is a path, code or diff; the body of the prompt composer is mono on purpose (the user is writing to a CLI).

### Named Rules

**The Still Numbers Rule.** Numbers that change on their own (RAM, counts,
diffs, zoom, routine clocks) use `font-variant-numeric: tabular-nums` —
numbers don't dance.

**The Restrained Weight Rule.** 400 is rest, 500 is light emphasis, 600 is title
and active state, 700 exists only in brand marks and tiny mono badges. Weights
above 700 do not exist in the world.

## Layout

The chassis is a column: title bar (44px, `--titlebar-h`) over a flex
`app-body` with three regions — sidebar (vibrancy, resizable), central
workspace and the files/git panel on the right (vibrancy, resizable) — and,
under it, the status bar (28px, `--statusbar-h`; hideable from Settings, and
`.app[data-statusbar]` tells whoever is anchored to the bottom edge how much
to climb). The workspace has 10px of breathing room, collapsing on the side
where an open lateral already provides the divider (`data-sidebar="open"`
zeroes `padding-left`).

- **Dividers**: invisible 7px strips (`.resizer`, `.resize-handle`); the blue rail (2px radius) only lights up on hover, drag or keyboard focus, at 60% opacity.
- **Instrument density**: icon-buttons 25px (20px inside rows), tree rows ≥ 27px, pane header 33px, canvas card header 34px, portal bar 28px, window controls 46px (the Windows metric). On the canvas the slots are round: 30px in the tool palette (the most targeted control on the board), 26px in the card header, in the camera and in the flyout.
- **Pane grid**: each pane is a complete mini-window; 7px gaps between panes.
- **Infinite canvas**: an origin point (`.cv-world`) translated and scaled by `transform` (`screen = (world − viewport.xy) × zoom`); a dot grid (`radial-gradient` white 5%, 1px) as the table — the board used to carry an ambient glow on top of it (`.cv-glow`, a white 3.5% ellipse out of the top) and gave it up with the shell's, for the same reason: it was light painted on the ground; hairline frame with radius 20 and an inner thread of light at 6%.
- **Fixed anchors**: tool palette in a vertical capsule on the left (centred), **camera** in the bottom-right corner (minimap and zoom in a single glass — see Canvas), the Fronts control next to it (offset 204px on the canvas, 230px when the minimap is open, 16px on the grid), canvas status at top-centre, composer in the bottom-right corner of the window (fixed, 22px), toast at bottom-centre (18px above the status bar when it shows — `--statusbar-gap`).
- **Sticky for orientation**: section titles of the git review and diff hunk headers stick to the top while scrolling, with a solid background so the content underneath doesn't bleed through.

There are no breakpoints: it is a desktop window (Tauri, `decorations: false`);
fluid widths use `min()` (`min(520px, 92vw)` etc.). Dragging the window
depends on `data-tauri-drag-region` on the empty areas of the title bar.

## Elevation & Depth

A hybrid system: tonal layers (bg → panel → raised → overlay) + soft offset
shadows + hairlines of light + translucent materials. The maximum elevation is
deep frosted glass, not glow.

### Material recipes (vibrancy)

Each material is a pair of translucent colour + `backdrop-filter`, always
accompanied by a white hairline border (10–12%) and the top hairline:

- **Thin** (`--material-thin` rgb(47 47 47 / 36%) + `--blur-thin` blur(30px) saturate(180%)): title bar, sidebar, changes panel — the permanent lateral surfaces over the static ambient ground.
- **Floating glass** (rgb(22 22 27 / 60%) + blur(72px) saturate(185%)): the bench. Denser and blurrier than thin because the surface **floats** — it has 10px of clearance on all four sides and the ground shows around it, so the edge needs weight of its own (10% hairline + `inset 0 1px 0` 14% + a two-layer shadow) instead of leaning against the window.
- **Menu** (`--material-menu` rgb(38 38 47 / 62%) + `--blur-menu` blur(40px) saturate(180%)): menus, popovers, toasts, diff peek, status capsule, Fronts button.
- **Canvas glass** (`--cv-glass` rgb(30 30 40 / 44%) + `--cv-glass-blur` blur(72px) saturate(190%), tokens declared on `.cv`): everything that floats over the board — tool palette, flyout, camera, selection bar, markup bar, flow HUD. Less paint and more blur than the menu because the board is the deepest surface in the app: what hovers over it hovers **higher** than a menu over the shell. It comes with a 14% border, `--cv-float` (`0 20px 48px` 44% + `0 2px 8px` 30%) and a two-faced `--cv-glass-edge` (white 22% on top, black 18% at the base) — glass only reads as glass with a light edge on top *and* a dark one underneath.
- **Sheet** (`--material-sheet` rgb(28 28 36 / 68%) + `--blur-sheet` blur(64px) saturate(180%)): modals and the prompt composer. The diff viewer uses near-opaque rgb(28 28 34 / 94%) — it has code inside.
- **Modal backdrop**: rgb(0 0 0 / 45%) + blur(6px).

### Shadow Vocabulary

Always vertical offset + soft blur, in layers; never a symmetric halo as elevation:

- **`--shadow-1`** (`0 1px 2px rgb(0 0 0 / 28%), 0 3px 10px rgb(0 0 0 / 22%)`): low-flying controls — status capsule, Fronts button.
- **`--shadow-2`** (`0 12px 32px rgb(0 0 0 / 42%), 0 2px 8px rgb(0 0 0 / 30%)`): menus, popovers, toasts.
- **Canvas elevation** (`.cv` tokens): `--cv-lift` (`0 24px 64px` 44% + `0 6px 18px` 30%) on cards, flow cards and notes; `--cv-lift-hi` (`0 32px 80px` 48% + `0 8px 24px` 32%) on the focused card; `--cv-float` on the floating chrome. All one step above the rest of the app — on the board the shadow is what separates the object from the table.
- **`--shadow-3`** (`0 32px 80px rgb(0 0 0 / 55%), 0 8px 24px rgb(0 0 0 / 35%)`): modals, viewer, composer — the top of the stack.
- **`--hairline`** (`inset 0 1px 0 rgb(255 255 255 / 12%)`): the thread of light along the top of every raised surface — relief without colour, composed together with the shadows (`box-shadow: var(--shadow-2), var(--hairline)`).
- Blue halos (`0 0 0 3px rgb(10 132 255 / 14%)` etc.) are **state** (focus, selection, drag-over), not elevation.

### Z scale (observed)

Side menus 40 · canvas overlays 30/40 · composer 60 · peek 90 · modal
100 · viewer 120 · toast 200 · tooltip 300 · popup menu 10000.

### Named Rules

**The Transient Glass Rule.** `backdrop-filter` only exists on transient
surfaces (menus, modals, toasts, peek) or lateral ones over the static ground
(title, sidebar, changes). Any surface that contains a live terminal is solid
(`--bg-panel`) — xterm repaints constantly and blur on top of it costs frames.

**The Offset Rule.** An elevation shadow always has a vertical offset and soft
blur. A symmetric halo never means height — a halo is the language of state
(focus/selection), and it is always blue.

## Shapes

Shape language: generous, continuous corners, capsules for everything that is
a count or a status, circles for everything that is a state light.

- **Radius scale**: 6px (`--r-sm`, micro-targets), **8px (literal, the radius of controls inside the chrome** — menu items, icon-buttons, tooltips — used in a dozen and a half places), 9px (`--r-md`, buttons, inputs, tree rows), 10px (pane tabs), 14px (`--r-lg`, panels, menus, canvas notes, palette flyout), 20px (`--r-xl`, modals, viewer, composer, canvas cards and frame), 16px (toast), 18px (the bench's grouped list card; and the canvas camera — 12px of the map plus 6px of clearance), 24px (floating bench panel). The segmented control is a capsule: track and segments at 999px.
- **Capsules** (border-radius 20px, or 999px when the height demands it): count pills, review chips, branch/role badges, the portal's URL field, status capsule, Fronts counters and — inside the bench — every control: tab track and segments, scope filter, new-task field, row buttons and the due-date/scope badges.
- **Circles**: state dots, colour swatches, unread/done badges, routine.
- **No radius**: only the window controls, which touch the corner and follow Windows.
- **Brand squircle** (border-radius 27%): the "Y" in a rounded square with a blue gradient (165deg, #55a9ff → #0a72e8 → #085ec4) and inner light coming from above — app icon at 18px (bar), 44px (welcome) and 48px (boot, breathing).
- **Dashed = provisional or locked**: empty pane (dashed border), locked note (dashed border + always-visible padlock), connection wire in progress, selection lasso, focused portal (dashed outline). **What is selected is not provisional**: on the canvas the selection is a *solid* 1.5px blue ring at −7px from the object, with a 4px halo at 8%, and four round 10px handles (white core, 90% blue rim) centred on the ring's corners — the grammar of a freeform whiteboard. Card, flow card and note use the same ring; free text uses only the ring, because it already mounts its four resize handles.
- **Borders**: translucent white hairline on everything; the bottom border of bars over content is translucent black (rgb(0 0 0 / 28–35%)) — a contact shadow, not a line.

## Components

### Title bar & window controls

Thin material with blur over the ground; black 35% bottom border + hairline.
Breadcrumb on the left: project (with the project's icon and colour) › group,
with a capsule branch badge when the group is an isolated front. In the centre,
the segmented layout control; on the right, the actions.

The right cluster reads in two families, split by a hairline
(`.titlebar-sep`): first the three **doors** — Arquivos e alterações
(`FileDiff`), Bancada (`PanelRight`, the outermost right drawer, pairing with
the sidebar's `PanelLeft` at the far left) and Anotações — then the two
**windows** (Extensões, Configurações). Doors are `.dock-toggle`s and show
**open** as the sidebar's blue pill (blue 26% + 18% inset ring + bright glyph,
driven by `aria-pressed`): the `.is-active` white veil sits 4.5% away from
hover and never read as a state. A door carries no count: 58 changed files is
the state of the tree, not a queue for the user, and a number pill in the
corner of the eye reads as unread mail — the count lives in the balloon
("Mostrar arquivos e alterações — 58 alterados"), in the accessible name, in
the status bar's branch chip and inside the panel. The one mark a door wears
is the 6px attention dot (`.dock-toggle-dot`, the footer's yellow) on the
bench, only while a task is due today or overdue. Balloons name the action by
state — *Mostrar…* closed, *Esconder…* open — so a lit button teaches both what
it opens and that it is open; the accessible name stays the panel's name, the
pressed state is the button's own. The rule is `TitleBar/dockToggle.ts`,
tested.

Window controls in the Windows pattern, glued to the top-right corner
(`TitleBar/index.tsx`): minimise, maximise/restore and close, each 46px wide by
the height of the bar, no radius. The glyphs are hand-drawn SVG (10×10, 1px
stroke, in the shape of Segoe Fluent Icons) — Lucide is too rounded and too
heavy next to the real system frame. Hover uses `--bg-hover`; close uses the
system red (#c42b1c, #b0271a when pressed) with a white glyph. It is the only
place in the app that obeys the OS instead of the style: obeying halfway would
read as a bug. Focus uses an inner ring (`outline-offset: -3px`) because the
button touches the window edge.

### Status bar

The footer (`StatusBar/index.tsx`, 28px): the title bar's thin material
mirrored — black 35% border on *top* (a contact shadow, because this bar sits
under content) with the hairline just inside it. Everything in it is caption
(11px) and tabular. Readouts and actions share one shape, the 22px chip with
the micro-target radius (6px): on the left, agents by state (a yellow pulsing
dot for *waiting on you* — the chip takes the yellow veil, the one time the
footer asks for attention — green for up, a hollow green ring for finished),
the project's branch with `+/−` in mono and the diff's colours, and any flow
still walking, in the action blue; on the right, the RAM meter (the sidebar
HUD's recipe at 44×3px, same three steps) and three 24×22 icon-buttons —
Busca, composer, shortcut map. Tooltips open upward (`data-tip-side="top"`).

### In-world tooltip (`[data-tip]`)

The primitive that replaces the native `title` (the Windows white box = foreign
material): a dark balloon rgb(46 46 52 / 96%), radius 8, hairline + shadow,
11px caption, appearing after a 500ms pause (transition-delay) below the
control. Variants by attribute: `data-tip-at="left|right"` anchors to the
control's side near the window edges; `data-tip-side="top"` goes up (controls
in the footer); `data-tip-side="right"` comes out sideways (the canvas's
vertical palette); `data-tip-wrap` wraps long texts at max. 240px. `aria-label`
is still what speaks to the screen reader — `data-tip` is only the visual.
Replaced elements (`<select>`) have no `::after`: the balloon goes on a wrapper.

### Buttons

- **Primary** (`.btn--primary`): a classic push button — gradient `linear-gradient(180deg, #3395ff, #0a78ef)`, white 600 text, inner light `inset 0 1px 0 rgb(255 255 255 / 42%)`; hover lightens the gradient, active darkens it. It is the only coloured button on screen.
- **Default** (`.btn`): white 7.5% surface with 9% border and thread of light; hover 11%, active 15%.
- **Ghost** (`.btn--ghost`): transparent with hairline border, no shadow. `--sm` variant (3px 9px, 12px).
- **Icon-button** (`.icon-btn`): 25px, radius 8, dimmed icon; hover = white veil + light text; intent variants only on hover: `--danger` (red veil and text), `--go` (green).
- **Disabled**: opacity 0.35–0.42, never a new colour.

### Segmented control

A recessed track (black 28%, inset shadow, 999px capsule) with a raised active
segment (white 14%, shadow + thread of light, 999px capsule) — used in the
title bar's layout switch and in the diff viewer. The same "deep track / raised
active" pattern repeats in modal tabs and in the changes panel.

### Sidebar (source list)

Thin vibrancy; uppercase caption header; rows with radius 9 and **selection as
a blue pill** (rgb(10 132 255 / 26%) + 18% inset ring) — not a full-width band.
Terminals nest at 38px; the focused one gets a veil + 30% blue ring (whoever
receives the keys announces itself). Row actions appear only on hover/focus.
System HUD in the footer: a 3px blue bar that turns yellow (warning) and red
(critical) — the only HUD reading that demands action is the only one with
chroma.

### Bench (floating panel)

The only lateral surface that does **not** touch the window: `.bench` is just
the vessel (it reserves the column and anchors the resizer), and `.bench-glass`
is the slab — radius 24, floating glass, 10px of clearance on all four sides.
Inside it only two shapes apply: a **capsule** for everything that gets pressed
and a **grouped card** (radius 18, white 6%, hairline) for everything that is a
list. The card's rows are divided by hairline, not by space — and the first and
the last carry the card's radius, because the panel cannot use
`overflow: hidden` (it would eat the `[data-tip]` balloons, which are the
control's own `::after`).

The header names the **open tab**, not the panel ("Tarefas" (Tasks), not
"Bancada" (Bench)), with a context line below — the plural and urgency rule
lives in `BenchPanel/heading.ts`, tested. Round close button, 28px.

Affordances that only exist on hover (drag handle, flag, kebab) reserve no
column: the handle is absolute inside the row's left padding, so that the
resting state is exactly the list and nothing more.

**One exception, in the "Controle" (Version control) tab:** the *hunk* buttons
(stage/discard a hunk) are always visible. The hover rule exists so that the
resting state is the list; here the list was opened on purpose, and the button
is the reason it was opened — hiding it would hide the only thing this panel
does that the one below doesn't. Row and group actions stay on hover, and bulk
destructive ones even more so: an always-visible "discard all" is a "discard
all" always within reach of the cursor.

The bar of the four Controle sections is **icon-only**, like the panel's own
tab strip: at 268px, four labels ("Alterações" (Changes), "Histórico"
(History), "Branches", "Guardado" (Stashed)) come out cut in the middle of the
word, and half a word informs less than an icon with a tooltip.

### Menus

Menu material with blur, radius 14, pill items (radius 8) with a **full blue
highlight** (`--accent` background, white text — icon and shortcut together).
Hairline separators; dangerous item in red that fills on hover; special rows
(colour swatches, `− value + ↺` stepper, sizes) become side-by-side chips.
Entry: `menu-in` (fade + translateY(−4px) + scale 0.98, 130ms).

### Fields & pop-up button

A text field is a recessed well (black 26%, hairline, inset shadow, radius 9);
focus swaps the border for 60% blue and gains a 3.5px halo (blue 22%) — no
system outline. The **pop-up button** (`components/Select`) has the same well,
with the truncated label and a dimmed `⌃⌄` caret on the right; open, it keeps
the focus ring, and the list is the menu material itself (check mark on the
left, full blue highlight, group headers in caption). Inside the segmented
control it becomes one more segment: no well, just label and caret.

This is not ornament: on Windows the WebView draws a `<select>`'s list in a
window of its own and paints it with the control's computed `background-color`
— ours is translucent, and the popup composited it over its own white
background, so the list came out **light** in a dark app (`color-scheme: dark`
doesn't reach that window). **Never use a native `<select>`**; for popups that
are still the system's (`<datalist>`), the field's `background-color` has to be
opaque.

### Panes & terminal cards (mini-windows)

The world's signature: each terminal lives in its own mini-window — solid
`--bg-panel` body, radius 14, hairline border, shadow + thread of light;
`--bg-raised` header (33px) with tabs, state dots and actions. **Focus = 55%
blue border + 14% halo** and a header one step lighter (#24242b) — never "a
grey one shade lighter". The terminal well is #121215 (deeper than the chrome),
matching the xterm theme. State dots: 6px — green with glow (running),
pulsing yellow (starting), red with glow (error), 50% grey
(idle/exited). Drag-over: blue border + halo; valid connection target: green.

On the canvas the same mini-window comes one step higher: radius 20, body at
92%, `--cv-lift` shadow, 34px header with a **top gradient** (white
6% → 1.5% over #1d1d22; on the focused card 8% → 2.5% over `--bg-raised`) —
a flat band reads as paint, a band lit from above reads as curved glass
catching the board's light. Focus rises to a 60% border + 3.5px halo and
`--cv-lift-hi`; the title gains weight 500. Role chip in a capsule with a 22%
blue inner rim, 7px dots with a thread of white on top, actions in round 26px
slots.

### Terminal (ANSI theme)

`THEME` in `XTermView/index.tsx`: background #121215, text #d9d9de, cursor #8ec2ff
over the well background, selection #2b446b. ANSI keeps its semantics, tuned for the
cold ground: red #ff6e64, green #5bd57f, yellow #eac95c, blue #5fa8ff, magenta
#c98bf2, cyan #5fd2d2, white #d9d9de, brights one step up (#8fc2ff,
#8ce3a4… up to brightWhite #f7f7f9). Colours inside the terminal are content, not
chrome — they don't follow the Single Blue Rule.

### Infinite canvas

A transparent table over the ground with a dot grid and an ambient glow
descending from the top; tool palette in a **true vertical capsule**
(999px, canvas glass, round 30px slots) on the left, with the tool in hand as a
**blue dome** (`--accent-grad` + 42% inner light + blue glow) and
short 18px fillets instead of edge-to-edge rules — inside a
capsule, a full rule would have to be clipped by the curve. The capsule
shows **one family per button** (pointer, drawing,
shapes, insert, connect) and not one tool per button — 12 icons in a
wall establish no hierarchy. Each button wears the last tool taken from
that family and, when clicked, hands over that tool _and_ opens the family in a
flyout on the right (same glass, radius 14, round 26px slots — one step
below the rail, which is where the hand goes first). A 4px fold in the
bottom-right corner says there is more behind the icon; colour and thickness live in
the same place, in a button that wears the current ink at the current gauge. It closes like a
native popover: click outside or Esc (captured before the canvas). Keyboard
shortcuts stay direct — the fast path gained no click, only
the browsing path did. **Camera** (`.cv-camera`, bottom-right corner): minimap and zoom in a single
glass, radius 18 — a capsule when the map is stowed. They used to be two floating
pieces stacked with a 4px gap, which read as two controls that happened to land
near each other; a single panel with an inner fillet says what is true — map and zoom
are the same instrument, and the map is the part that stows away. The map is a well
cut into the glass (radius 12, black 18%, inner shadow) — the only sunken surface
on the board, and it is what makes the little rectangles read as being
*inside* a map. The bottom row: zoom out · tabular percentage
(stretches, centred under the map) · zoom in │ fit · map; the fillet separates
"change the zoom" from "change the framing".

Notes: background with a **varnish** (white 14% → 0% at 42%) over the note's colour
(`--note-fill`, inline; the stylesheet composes the gradient on top — an inline
`background` wouldn't allow it), radius 14, `--cv-lift` + inner thread of light at 45%,
a 10px header strip in the note's colour, light markdown in reading mode; locked =
dashed border + always-visible padlock. The note body comes from a single token (`--note-fs`, default `--fs-sm`) and
everything inside it — headings, code — is sized in `em`: a number in the menu
("Fonte" (Font), 9–48px) scales the whole block without detaching the hierarchy. Opened
for writing, the note lights up a **formatting bar** docked at the **top
of the canvas** (`.cv-mdbar`): it is the left capsule laid flat — same glass,
same radius 20, same round 26px slots with a 14px icon, same dividing
fillets, same blue dome on what is active (two capsules on the same screen either
read as one instrument or read as an accident, there is no third option) —
but in **screen space**: a bar that scaled with the world would be
illegible at 40%, which is exactly when a small note needs it. It doesn't stick to the
note: the note is the biggest thing on the board, so anything that opened from a bar
glued to its edge would land on top of the text — and a still strip is what
lets you grab a button without looking. Headings (# ## ###), emphasis (bold,
italic, strikethrough, highlight, code), structure (lists, tasks, quote,
fenced block, link) and a ⋯ that opens a **second row inside the capsule
itself** — named chips, not more icons: paragraph, rule, complete,
indent, duplicate/move line, clear. The button of the block where the cursor sits
lights up in full blue. While it is up, the arrange bar disappears (the
two would fight over the same strip) and its rectangle goes to the `occludersStore`,
like every menu that floats over portals. Editing is still a raw
`<textarea>` — the user sees the same
markdown the agents read through the CLI. In reading mode only two things react: the
**task checkbox**, which toggles without opening the editor, and the **link**, which opens the
address as a portal (never `<a href>`: inside the webview that would navigate the
whole app away). Drawn
text uses **handwriting** ("Segoe Print", "Comic Sans MS", cursive) —
it matches the freehand shapes (roughjs/perfect-freehand) — and grows from
8 to 200px: it is a region label as much as a caption. Selected, it gets the
four **corners** (only the corners: scaling is uniform, a side handle
would promise a stretch that doesn't exist) and dragging a corner scales the font
anchoring the opposite corner.
Drawing palette (`CANVAS_COLORS` in `lib/canvas.ts`): #f5f5f5, #a3a3a3,
#6b6b6b + the same semantic/project families (#ff6961, #40d16e,
#f0c33c, #5fa8ff, #c98bf2). Connections: thicknesses in world units in the CSS
(2 → 2.6 hover → 3 selected, round cap; halo 12 at 14%), provisional
wire dashed and animated. Resize grips: `--cv-grab: min(30px, calc(11px / var(--cv-z)))` —
~11px of screen at any zoom; on portals the grips hang entirely
outside the card (the browser's native surface swallows pointer events).
Too far away to read (`.cv--far`), a scrim wakes over the cards and everything
becomes pan.

### Modals, viewer & composer

Sheets: material-sheet with deep blur, radius 14, 12% border, shadow-3 +
hairline, `modal-in` entry (fade + translateY(10px) + scale 0.97, 200ms,
ease-pop) over a darkened backdrop with blur. Footer with black 14% background.
Diff viewer: the same window in near-opaque (94%) with a lateral file rail
(selection as a blue pill). Composer: a sheet anchored in the bottom-right
corner, mono body, mentions menu that **rises**. Settings: the same sheet at
up to 960×680, in two panes — the category menu on the left over black 14%
(the footer's paint, "another region of the same sheet"), the 620px reading
column on the right; below 720px of sheet width the menu collapses to icons
with balloons.

### File editor (document header & formatting capsule)

A file is a tab in the pane's bar, and under that bar it used to wear two more
strips — raw path on the left with nine icons on the right, then a full-width
band of formatting icons — three hairlined bars in a row, the anatomy of every
markdown editor there is (and the category's "flat grey chrome"). Since
2026-08-26 the body opens with the **document header**: no fill, no rule, the
page's own top margin. The path is set like a title — folder chain in
`--text-dim`, file name in `--text` at 500, both mono — and it is a **pop-up
button** (the same dimmed caret as `components/Select`): pressing it drops the
file's menu (the tab's own entries — save, reload, copy path, show in folder,
close… — plus what this view adds: "Quebra de linha" as a checked item, or
"Abrir no aplicativo padrão" on a picture). Truncation cuts the *folder's
start*, never the name (`splitOsPath` + an LTR isolate inside an RTL box).
On the right only how to *look* at the text: the four markdown modes as the
app's segmented control at icon scale (recessed capsule track, raised active
segment), the outline toggle, search. **Salvar exists only while there is a
draft** (`chrome.ts`, tested) — the button *is* the state.

The **formatting capsule** (`.md-bar`) is the note's `.cv-mdbar` brought into
the page: centred in the top margin with air on every side, radius 20, round
26px slots with 14px icons, a blue dome on the block under the caret, short
fillets between families, the ⋯ opening a second row of named chips *inside*
the capsule. One step quieter than the canvas glass — white 5.5% paint, 10%
border, lit top edge (15%) and dark bottom edge (22%), `--shadow-1` — because
a page inside a pane is already close to the eye; no blur, since nothing
scrolls under it. Each family is one flex group: in a narrow pane the bar
breaks *between* families, never leaving an orphan slot on a line of its own.
It hides in *Ler*; read-only files keep it, greyed.

### Ao Vivo (Live — agent mission control)

A glass overlay (material-sheet + deep blur, radius 14, shadow-3 +
hairline) over the whole workspace, at z 110 — above the modals, below the
diff viewer. It is the only large surface with full vibrancy: it contains no
xterm. Opens from the `Activity` button in the pane header (only on agent
CLIs; with the process alive the glyph breathes green — process
semantics). Header: animated green EQ bars while the agent
works, status capsule (`trabalhando`/`pensando`/`ocioso` — working/thinking/idle), model/tokens/cost chips
in tabular-nums, session selector and close (Esc and
clicking the backdrop also close). Ticker with the agent's latest
utterance/reflection. Body in three columns: timeline (M/A badges like the diffs,
mono paths with an ellipsis that preserves the basename, `+n −n` green/red,
spinner on a pending tool, user prompt in a blue veil), touched files
(aggregated per file, click opens the diff viewer when there is a repo)
and the kanban board (the agent's plan in A fazer/Fazendo/Feito (To do/Doing/Done) with a green pulse
on the active card; sub-agents in Rodando/Concluídos (Running/Finished) with elapsed time).
New entries use `live-in` (fade + translateY 4px, 200ms ease-pop).
Data comes from the session tap in the backend (`agents/tail.rs`, the
`session://feed` event), reduced in `stores/liveStore.ts`.

### Toast

A capsule (radius 12) of menu material at bottom-centre, entering from below with a
short spring (240ms ease-pop). Error: 40% red border + pinkish text #ffb4ae.

### Diffs & badges

VS Code-style file badges: 14px squares, mono 700 — A green, D
red, M blue, conflict yellow, each over its veil. Diff lines:
9% veils (green/red) with sign and number in the colour at 90%; the changed core
(`.demph`) rises to 26%. Empty cell in side-by-side: subtle diagonal hatching.

### Scrollbars

Overlay scrollbars: thin, rounded, no track — 9px in the chrome (white thumb
18% → 32% hover), 6px inside the terminal (more discreet than the chrome's).

### Project identity

The user picks an icon (`PROJECT_ICONS` registry, Lucide, ~40 options) and a colour
(`PROJECT_COLORS` in `lib/projectStyle.ts`): null (neutral), #5fa8ff, #5fd2d2,
#40d16e, #f0c33c, #ffa35c, #ff6961, #ff7fa6, #c98bf2 — the system hues
tuned for the dark ground, the same chroma family as the semantic tokens
and the canvas. The project colour tints only the icon in the breadcrumb/tree
and card headers — identity belongs to the user's content, not to the chrome.

### Icons

Lucide everywhere, 10–14px in the chrome (12–13 typical), default stroke.
`aria-hidden` when decorative. Two hand-drawn exceptions: the window controls
(10×10, stroke 1, to match Segoe Fluent Icons) and the "Energético" (Energy
drink) can (`TitleBar/StatusChip.tsx`, 24×24 at Lucide's weight), because
Lucide has no energy drink and the control is named after it. The can is also the
general rule in one sentence: **a chrome icon reads by silhouette**. The first can had
a lightning bolt inside and turned into a battery at 13px; what saves it is a lid narrower than
the body. Inner detail dies below ~16px — and you only find that out by looking at
the real pixel, never at an enlarged preview.

**Product marks** (`components/BrandIcon`) are the only exception: wherever the
icon answers "which CLI is this?" — tab, tree row, card header,
the "Novo terminal" (New terminal) grid, session tabs, usage strip and the Ao Vivo header —
the real logo applies (Claude, Codex, OpenAI, Grok, Gemini, Copilot, Cursor,
opencode, Goose, Ollama, Qwen, DeepSeek, Bash, Zsh, fish, Nushell, Ubuntu,
Python, Node, Git; PowerShell and the Windows console drawn here). Always
filled, at the same size as the Lucide next to them, and **in the brand's real colour**
(`marks.ts`: Claude's coral #d97757, Bash's green #4eaa25, Git's orange #f05032…)
— at 12px the drawing alone doesn't tell two logos apart, the colour does. Marks that
really are monochrome (OpenAI/Codex, Grok, Copilot, Cursor, opencode, Goose,
Ollama) stay white, which is how they are drawn on dark; Gemini and Python
are gradients because the brand is a gradient. It is the **only** identity colour in the
chrome: outside here, action blue and semantic chroma. Whoever has no public mark
(Aider) gets the generic glyph, never someone else's logo.

**File icons** (`components/FileGlyph`) have the same decision shape:
every place that shows a file (tree, "Busca" (Search), file tab) asks
`FileGlyph`, which by default returns the neutral Lucide — the tree's colour is still
only the git state. The store's **icon themes** (`Ctrl+Shift+X`) are the
conscious opt-out of that contract, both official and vendored with their LICENSE
alongside: **Symbols** by Miguel Solorio (`FileGlyph/symbols/`, MIT, lazy
chunk) and **Material Icon Theme** by Philipp Kief (`FileGlyph/material/`
for the maps + `public/material-icons/` for the 1250 SVGs, MIT). They are a
category: turning one on turns the other off. Off — the default — none of this
exists on screen. The editor extensions (rainbow brackets, TODO highlight,
minimap, guides, colours in CSS) follow the same rule as the diff: colour in the _content_
is allowed, the chrome stays blue. The store's **colour themes** (Dracula, Nord,
Catppuccin… — `lib/colorSchemes.ts`, a category with one active at a time) take that
rule to the limit: they recolour the terminal well (xterm `theme`) and the editor's
syntax palette (`schemeSyntax.ts` swaps only the `HighlightStyle`), and **nothing**
of the chrome — app background, action blue and tokens stay intact.

## Do's and Don'ts

### Do:

- **Do** keep every live terminal on a solid surface (`--bg-panel` / #121215 well); blur is for menus, modals, toasts, laterals and transients.
- **Do** use #0a84ff for every action, selection and focus — and the three semantic colours only for process state and diffs, each with its `-bg` veil.
- **Do** use `data-tip` (+ the right anchoring variant) with `aria-label` for every hint — never the native `title`.
- **Do** compose elevation as `box-shadow: var(--shadow-N), var(--hairline)` — soft offset shadow + thread of light on top.
- **Do** use `tabular-nums` on any number that changes on its own.
- **Do** keep transitions on hot paths restricted to colour/border/opacity/shadow, at 130/200ms with `--ease`/`--ease-pop`.
- **Do** keep the focus ring visible (`outline: 3px solid rgb(10 132 255 / 55%)`) on everything clickable, and states visible without hover (focus, process, lock, active front).
- **Do** bundle every resource (fonts via @fontsource) — no network at runtime; chrome text ≥ 4.5:1.
- **Do** mark the draggable areas of the title bar with `data-tauri-drag-region` (undecorated window).

### Don't:

- **Don't** change the math of the canvas grips (`--cv-grab` / `--cv-z`, the outer offsets of the portal grips) or the `pointer-events` rules of the `.cv-*` layers — critical behaviour, not aesthetics.
- **Don't** leave a permanent `will-change: transform` on `.cv-world` — it exists only during the pan; permanent, it freezes the raster and every zoom comes out blurry.
- **Don't** remove or weaken the `@media (prefers-reduced-motion: reduce)` blocks.
- **Don't** introduce decorative chroma, a second accent, or green/yellow/red outside state and diff.
- **Don't** use a symmetric halo as an elevation shadow — a halo is state (focus/selection) and it is blue.
- **Don't** put `backdrop-filter` (or an expensive animation) over a pane that contains xterm.
- **Don't** signal pane focus with "a grey one shade lighter" — focus is a blue border + halo.
- **Don't** use uppercase outside the section micro-labels (11px/600/0.6–0.7px), or weights above 700.
- **Don't** swap the Lucide family or mix another icon family into the chrome — the exception is the product marks (`BrandIcon`), in the brand's own colour, only where they identify which CLI is running.
- **Don't** use a native `<select>` (or leave the `background-color` of a field with a `<datalist>` translucent): the list is drawn by the WebView in its own window and comes out light — use `components/Select`.
