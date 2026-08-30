/**
 * English lines of everything that is not a component: toasts, confirms and
 * menus built in `src/lib` (lifecycle, menus, sendability, backups, updates,
 * broadcast, MCP, the terminal's links and export, relative dates…). The
 * `yard` CLI's own output (`bridge*.ts`) is out of scope on purpose: it is
 * read by agents, not by the user. Key = the PT-BR sentence as written.
 */
export default {
  // --- lib/destination: where a CLI is born inside a project
  "Sem nome": "Unnamed",
  "Chão": "Ground",
  "Worktrees do disco": "Worktrees on the disk",
  // --- lifecycle: the confirms behind delete / restart / kill / clear -------
  "Excluir “{name}”? O processo será encerrado e o histórico desta CLI, junto com o cartão e as conexões dela no canvas, vai embora.":
    "Delete “{name}”? The process will be terminated and this CLI's history, together with its card and its connections on the canvas, goes away.",
  "Excluir “{name}”? O histórico desta CLI, o cartão e as conexões dela no canvas e as rotinas dela vão embora. Fechar a aba não apaga nada — só excluir.":
    "Delete “{name}”? This CLI's history, its card, its connections on the canvas and its routines go away. Closing the tab deletes nothing — only deleting does.",
  "Excluir CLI": "Delete CLI",
  "{name} está trabalhando agora. {verb} interrompe a tarefa em andamento — o que já foi feito no disco fica, o turno não volta.":
    "{name} is working right now. {verb} interrupts the task in progress — what already reached the disk stays, the turn does not come back.",
  "{name} está parado esperando uma resposta sua. {verb} descarta a pergunta que está na tela.":
    "{name} is stopped, waiting for your answer. {verb} discards the question on screen.",
  "Reiniciar CLI": "Restart CLI",
  Reiniciar: "Restart",
  "Matar processo": "Kill process",
  "Matar o processo": "Killing the process",
  "este terminal": "this terminal",
  "Limpar o histórico de “{name}”? Tudo o que já foi escrito nele some daqui e do disco — não dá para desfazer. O processo continua rodando.":
    "Clear the history of “{name}”? Everything written to it disappears from here and from the disk — there is no undo. The process keeps running.",
  "Limpar terminal": "Clear terminal",

  // --- the terminal's menu ----------------------------------------------------
  Renomear: "Rename",
  "Mover para cima": "Move up",
  "Mover para baixo": "Move down",
  Suspender: "Suspend",
  "falha ao reiniciar": "failed to restart",
  "falha ao suspender": "failed to suspend",
  "falha ao matar": "failed to kill",
  "Salvar saída…": "Save output…",
  "Passar o bastão…": "Pass the baton…",
  "Abra um projeto antes de escrever o diário.": "Open a project before writing the journal.",
  "Diário de {day} criado nas Anotações.": "Journal for {day} created in Anotações.",
  "Bastão montado a partir de {name}, escolha quem assume e revise antes de enviar.":
    "Baton assembled from {name}, pick who takes over and read it before sending.",
  "Nenhuma aba fechada para reabrir.": "No closed tab to reopen.",
  "O painel dessa aba de navegador não existe mais.":
    "The pane that browser tab lived in is gone.",
  "Orçamento do dia estourado: US$ {spent} de US$ {limit}.":
    "The day's budget is blown: US$ {spent} of US$ {limit}.",
  "Orçamento do dia em {pct}%: US$ {spent} de US$ {limit}.":
    "The day's budget is at {pct}%: US$ {spent} of US$ {limit}.",
  "Yard, orçamento": "Yard, budget",
  "Limpar a fila ({n})": "Clear the queue ({n})",
  'A fila não conseguiu escrever em "{target}": {reason}.':
    'The queue could not write to "{target}": {reason}.',
  "Transcrição da sessão…": "Session transcript…",

  // --- the text menu (cut / copy / paste over any field) ----------------------
  Recortar: "Cut",
  Copiar: "Copy",
  Colar: "Paste",
  "Selecionar tudo": "Select all",
  "Copiar endereço do link": "Copy link address",
  "Buscar no projeto": "Search the project",
  "Paleta de comandos": "Command palette",
  Preferências: "Preferences",
  "Não consegui copiar.": "Could not copy.",
  "Endereço copiado.": "Address copied.",
  "Não consegui recortar.": "Could not cut.",
  "sem acesso à área de transferência — use Ctrl+V": "no access to the clipboard — use Ctrl+V",
  "não há texto na área de transferência": "no text on the clipboard",
  "Buscar “{term}” no projeto": "Search the project for “{term}”",

  // --- pane and title-bar menus -----------------------------------------------
  "Nova CLI aqui": "New CLI here",
  "Novo navegador aqui": "New browser here",
  "Anotações aqui": "Notes here",
  "Layout dos painéis": "Pane layout",
  Grade: "Grid",
  Holofote: "Spotlight",
  "Barra lateral": "Sidebar",
  "Arquivos e alterações": "Files and changes",
  Bancada: "Bench",
  Anotações: "Notes",
  "Preferências…": "Preferences…",
  "Extensões…": "Extensions…",
  Atalhos: "Shortcuts",
  Restaurar: "Restore",
  Maximizar: "Maximize",
  Minimizar: "Minimize",

  // --- backup restore flow ----------------------------------------------------
  "O Yard vai fechar e abrir de novo para carregar o backup. Os terminais em execução são encerrados e o que você fez desde a importação é descartado junto com o workspace atual.":
    "Yard will close and open again to load the backup. Running terminals are terminated, and what you did since the import is discarded along with the current workspace.",
  "Reiniciar o Yard?": "Restart Yard?",
  "Não consegui reiniciar: {e}. Feche e abra o Yard.": "Could not restart: {e}. Close and open Yard.",
  "Descartar o backup preparado? O workspace atual continua valendo e o arquivo .zip original não é apagado — dá para importar de novo.":
    "Discard the staged backup? The current workspace stays as it is and the original .zip is not deleted — it can be imported again.",
  "Cancelar restauração?": "Cancel the restore?",
  "Restauração cancelada — o workspace atual continua.": "Restore cancelled — the current workspace stays.",
  "Não consegui cancelar a restauração: {e}": "Could not cancel the restore: {e}",

  // --- updates ----------------------------------------------------------------
  "Instalar a atualização vai fechar e reabrir o Yard. {n} CLI em execução será encerrada — o histórico de cada uma fica no disco. Continuar?":
    "Installing the update will close and reopen Yard. {n} running CLI will be terminated — its history stays on disk. Continue?",
  "Instalar a atualização vai fechar e reabrir o Yard. {n} CLIs em execução serão encerradas — o histórico de cada uma fica no disco. Continuar?":
    "Installing the update will close and reopen Yard. {n} running CLIs will be terminated — each one's history stays on disk. Continue?",
  "O Yard já está na versão mais nova.": "Yard is already on the latest version.",
  "Versão {version} disponível — instale em Configurações → Dados e backup.":
    "Version {version} available — install it in Settings → Data & backup.",
  nova: "new",
  "erro desconhecido": "unknown error",
  "Não consegui verificar atualizações: {error}": "I could not check for updates: {error}",
  "Instalar a atualização?": "Install the update?",
  "Não consegui instalar a atualização: {error}": "Could not install the update: {error}",
  "Versão {version} disponível": "Version {version} available",
  "Instalando… o Yard vai reabrir sozinho.": "Installing… Yard will reopen on its own.",
  "Baixando… {pct}%": "Downloading… {pct}%",
  "Baixando… {kb} KB": "Downloading… {kb} KB",

  // --- saving a terminal's output ---------------------------------------------
  "Salvar saída do terminal": "Save terminal output",
  Texto: "Plain text",
  "Registro ANSI (com cores)": "ANSI log (with colors)",
  "Saída salva ({kb} KB).": "Output saved ({kb} KB).",
  "Não consegui salvar a saída: {e}": "Could not save the output: {e}",

  // --- sendability (composer, routines, triggers, the review bar) -------------
  "Esse terminal não existe mais.": "That terminal no longer exists.",
  "{name} não está rodando — inicie antes de enviar.": "{name} is not running — start it before sending.",
  "{name} está travado esperando o usuário ({ask}) — o texto viraria a resposta dessa pergunta. Responda na CLI antes.":
    "{name} is stuck waiting for the user ({ask}) — the text would become the answer to that question. Answer in the CLI first.",
  "{name} está travado esperando o usuário — o texto viraria a resposta dessa pergunta. Responda na CLI antes.":
    "{name} is stuck waiting for the user — the text would become the answer to that question. Answer in the CLI first.",
  "{name} está trabalhando agora — um prompt no meio da tarefa chega partido.":
    "{name} is working right now — a prompt in the middle of a task arrives broken.",

  // --- creating a project -----------------------------------------------------
  "Escolha uma pasta.": "Choose a folder.",
  "Essa pasta já está no workspace como “{name}”.": "That folder is already in the workspace as “{name}”.",
  "Esse caminho não existe ou não é uma pasta.": "That path does not exist or is not a folder.",
  "Essa pasta já está no workspace.": "That folder is already in the workspace.",

  // --- links in the terminal's output -----------------------------------------
  "Não consegui abrir {what}: {e}": "Could not open {what}: {e}",
  "Não sei onde fica {text} nesta máquina.": "I don't know where {text} is on this machine.",
  "o portal": "the portal",

  // --- small helpers ----------------------------------------------------------
  "{font} (não encontrada)": "{font} (not found)",
  "falha desconhecida": "unknown failure",
  "tarefa #{id}": "task #{id}",
  agora: "now",
  "{n} dia": "{n} day",
  "{n} dias": "{n} days",
  nunca: "never",
  "há {s}": "{s} ago",
  "em {s}": "on {s}",

  // --- design mode: the element handed to the agent ---------------------------
  "Ligue este portal a um agente no canvas — ou foque um terminal — para mandar o elemento.":
    "Wire this portal to an agent on the canvas — or focus a terminal — to send the element.",
  "{what} → {target}. Diga o que muda e envie.": "{what} → {target}. Say what changes and send.",
  "Elemento apontado no portal — {label}": "Element pointed at in the portal — {label}",
  "**Página:** {url}": "**Page:** {url}",
  "**Recorte da tela:** {shot} — abra esta imagem para ver o elemento.":
    "**Screen crop:** {shot} — open this image to see the element.",
  "**Seletor:** {selector}": "**Selector:** {selector}",
  "**Dentro de:** {parent}": "**Inside:** {parent}",
  "**Texto:** “{text}”": "**Text:** “{text}”",
  "**Atributos:** {attrs}": "**Attributes:** {attrs}",
  "**Caixa:** {w}×{h} em ({x}, {y})": "**Box:** {w}×{h} at ({x}, {y})",
  "**Estilo calculado:**": "**Computed style:**",
  "O que muda aqui: ": "What changes here: ",

  // --- keyboard broadcast -----------------------------------------------------
  "⇶ Transmitindo — nenhuma outra CLI viva no grupo · {key} desliga":
    "⇶ Broadcasting — no other live CLI in the group · {key} turns it off",
  "⇶ Transmitindo para {clis} · {key} desliga": "⇶ Broadcasting to {clis} · {key} turns it off",
  "Transmissão desligada.": "Broadcast off.",
  "Transmissão ligada — nenhuma outra CLI viva no grupo por enquanto.":
    "Broadcast on — no other live CLI in the group for now.",
  "Transmitindo o teclado para {clis} do grupo.": "Broadcasting the keyboard to {clis} of the group.",
  "Nenhum grupo ativo para transmitir.": "No active group to broadcast to.",

  // --- MCP servers ------------------------------------------------------------
  'linha {n}: "{raw}" não tem o formato CHAVE=valor': 'line {n}: "{raw}" is not in the KEY=value form',
  'linha {n}: "{key}" não é um nome de variável': 'line {n}: "{key}" is not a variable name',
  "Só letras, dígitos, ponto, hífen e sublinhado — e começando com letra ou dígito.":
    "Only letters, digits, dot, hyphen and underscore — starting with a letter or a digit.",
  "Um servidor stdio precisa do comando que o inicia.": "A stdio server needs the command that starts it.",
  "Um servidor remoto precisa de um endereço http(s)://.": "A remote server needs an http(s):// address.",
  projeto: "project",
  usuário: "user",
  "só neste projeto, só para você (fica em ~/.claude.json)":
    "only in this project, only for you (kept in ~/.claude.json)",
  "no arquivo do projeto — vai junto no repositório": "in the project's file — travels with the repository",
  "em todos os projetos, só nesta máquina": "in every project, only on this machine",
  "{cli} ainda não é suportada aqui.": "{cli} is not supported here yet.",
  "Só o Claude Code fala WebSocket; esse servidor não tem forma na CLI de destino.":
    "Only Claude Code speaks WebSocket; that server has no shape in the target CLI.",
  "O Codex não distingue SSE de HTTP: o endereço vai como url e a CLI decide.":
    "Codex does not tell SSE from HTTP: the address goes in as url and the CLI decides.",
  "O Cursor não distingue SSE de HTTP: o endereço vai como url e a CLI decide.":
    "Cursor does not tell SSE from HTTP: the address goes in as url and the CLI decides.",

  // --- costs ------------------------------------------------------------------
  "(modelo desconhecido)": "(unknown model)",
  "(sem projeto)": "(no project)",

  // --- the support bundle's issue skeleton ------------------------------------
  "gerado em Configurações → Dados e backup": "generated in Settings → Data & backup",
  "Versão: {version}": "Version: {version}",
  "O que aconteceu:": "What happened:",
  "Passos:": "Steps:",
  "Anexe o pacote de suporte ({bundle}).": "Attach the support bundle ({bundle}).",
  // --- tables translated where they are rendered: shortcuts, extension catalog,
  // cache choices and skip hints, first-run gestures, cost windows (tables.test.ts) ---
  "Janela": "Window",
  "Busca — agentes, arquivos, notas, portais e ações": "Search — agents, files, notes, portals and actions",
  "Nova aba — CLI ou navegador": "New tab — CLI or browser",
  "Compositor de prompts da CLI em foco": "Prompt composer for the focused CLI",
  "O mesmo compositor — e, dentro dele, deixa o texto na linha da CLI sem enviar": "The same composer — and, inside it, leaves the text on the CLI's line without sending",
  "Bancada — arquivos, busca, tarefas e prompts": "Bench — files, search, tasks and prompts",
  "Árvore de arquivos do projeto": "Project file tree",
  "Controle de versão — preparar, commitar, branches": "Source control — stage, commit, branches",
  "Buscar no projeto inteiro (com um terminal em foco, busca no histórico dele)": "Search the whole project (with a terminal focused, searches its scrollback)",
  "Painel de arquivos e alterações": "Files and changes panel",
  "Extensões — a loja de recursos do Yard": "Extensions — Yard's feature store",
  "Ir para o próximo agente que está esperando você": "Go to the next agent waiting for you",
  "Fechar a aba em foco (CLI, arquivo, navegador ou notas)": "Close the focused tab (CLI, file, browser or notes)",
  "Reabrir a última aba de arquivo ou navegador que você fechou":
    "Reopen the last file or browser tab you closed",
  "A lista completa de atalhos": "The full list of shortcuts",
  "Transmitir o teclado para todas as CLIs do grupo (liga/desliga)": "Broadcast the keyboard to every CLI of the group (toggle)",
  "Trazer ou esconder a janela do Yard — de qualquer lugar do Windows (configurável)": "Bring or hide the Yard window — from anywhere in Windows (configurable)",
  "Custos e uso — tokens e gasto estimado por dia, projeto, agente e modelo": "Costs and usage — tokens and estimated spend by day, project, agent and model",
  "Ombro — o que cada agente do grupo fez, lido das sessões em disco": "Shoulder — what each agent of the group did, read from the sessions on disk",
  "Nas anotações (Ctrl+Shift+N)": "In the notes (Ctrl+Shift+N)",
  "Nova nota (nasce na coleção aberta)": "New note (born in the open collection)",
  "Ir para a busca — tag: caderno: status: e -termo filtram": "Go to search — tag: caderno: status: and -term filter",
  "Percorrer a lista de notas (Delete manda para a lixeira)": "Walk the note list (Delete sends to the trash)",
  "Colar imagem dentro da nota": "Paste an image into the note",
  "Fechar (tudo já está salvo — a nota grava enquanto você digita)": "Close (everything is already saved — the note writes as you type)",
  "Navegação": "Navigation",
  "Próxima aba do painel em foco (CLIs, arquivos, navegador e anotações)": "Next tab of the focused pane (CLIs, files, browser and notes)",
  "Aba anterior": "Previous tab",
  "Ir para a aba 1 (até Ctrl+9)": "Go to tab 1 (up to Ctrl+9)",
  "Focar o painel 1 (até Ctrl+Shift+6)": "Focus pane 1 (up to Ctrl+Shift+6)",
  "Próximo grupo do projeto": "Next group of the project",
  "No editor de código": "In the code editor",
  "Salvar o arquivo": "Save the file",
  "Buscar dentro do arquivo (com regex, se quiser)": "Search inside the file (with regex, if you like)",
  "Buscar e substituir (a mesma barra, já aberta embaixo)": "Find and replace (the same bar, already open below)",
  "Ir para a linha": "Go to line",
  "Voltar para onde você estava (Alt+→ avança de novo)":
    "Back to where you were (Alt+→ goes forward again)",
  "Marcar ou desmarcar a linha": "Mark the line, or take the mark back",
  "Correções rápidas para o problema sob o cursor (LSP)":
    "Quick fixes for the problem under the caret (LSP)",
  "Próxima marca do arquivo (Shift+Alt+F2 a anterior)":
    "Next mark in the file (Shift+Alt+F2 for the previous one)",
  "Selecionar a próxima ocorrência (multi-cursor)": "Select the next occurrence (multi-cursor)",
  "clique": "click",
  "Cursor extra onde clicar": "Extra cursor where you click",
  "Comentar ou descomentar a linha": "Comment or uncomment the line",
  "Mover a linha (Alt+↓ desce · Shift+Alt copia)": "Move the line (Alt+↓ moves down · Shift+Alt copies)",
  "Apagar a linha": "Delete the line",
  "Completar a palavra": "Complete the word",
  "Ir para a definição do símbolo (com um servidor de linguagem)": "Go to the symbol's definition (with a language server)",
  "Referências do símbolo (LSP); Esc fecha o painel": "References of the symbol (LSP); Esc closes the panel",
  "Renomear o símbolo sob o cursor (LSP) — na árvore, renomeia o item": "Rename the symbol under the cursor (LSP) — in the tree, renames the item",
  "Formatar o documento pelo servidor de linguagem": "Format the document through the language server",
  "Ajuda de assinatura (LSP; Ctrl+Shift+↑/↓ troca a assinatura)": "Signature help (LSP; Ctrl+Shift+↑/↓ switches the signature)",
  "O arquivo é uma aba do painel: alterna com as CLIs": "The file is a tab of the pane: cycles with the CLIs",
  "No canvas, encosta o editor (os arquivos continuam abertos)": "On the canvas, tucks the editor away (the files stay open)",
  "Renomear o item selecionado na árvore": "Rename the item selected in the tree",
  "Escrevendo markdown (.md)": "Writing markdown (.md)",
  "Título 1 … Ctrl+6 o menor · Ctrl+0 volta a parágrafo": "Heading 1 … Ctrl+6 the smallest · Ctrl+0 back to paragraph",
  "Negrito · Ctrl+I itálico · Ctrl+E código na linha": "Bold · Ctrl+I italic · Ctrl+E inline code",
  "Riscado · Ctrl+Shift+H marca-texto": "Strikethrough · Ctrl+Shift+H highlight",
  "Link · Ctrl+Shift+I imagem": "Link · Ctrl+Shift+I image",
  "Lista · Ctrl+Shift+7 numerada · Ctrl+Shift+9 tarefas": "List · Ctrl+Shift+7 numbered · Ctrl+Shift+9 tasks",
  "Citação · Ctrl+Shift+C bloco de código": "Quote · Ctrl+Shift+C code block",
  "Tabela · Ctrl+Shift+F nota de rodapé": "Table · Ctrl+Shift+F footnote",
  "Linha divisória · Ctrl+\\ limpa a formatação": "Horizontal rule · Ctrl+\\ clears formatting",
  "Concluir ou reabrir a tarefa da linha": "Complete or reopen the line's task",
  "Duplicar a linha · Alt+↑ e Alt+↓ movem": "Duplicate the line · Alt+↑ and Alt+↓ move it",
  "Continua a lista; numa linha vazia, sai dela": "Continues the list; on an empty line, leaves it",
  "Recuar o item (Shift+Tab tira o recuo)": "Indent the item (Shift+Tab outdents)",
  "No terminal": "In the terminal",
  "Buscar no histórico do painel": "Search the pane's scrollback",
  "Copiar quando há seleção; interromper quando não há": "Copy when there is a selection; interrupt when there is none",
  "Copiar a seleção": "Copy the selection",
  "Colar (o botão direito abre o menu, não cola sozinho)": "Paste (the right button opens the menu, it does not paste by itself)",
  "Colar imagem: vira arquivo e o agente recebe o caminho": "Paste an image: it becomes a file and the agent gets the path",
  "Abrir o link, ou o arquivo na linha apontada, que a saída mostra": "Open the link, or the file at the line pointed to, that the output shows",
  "No canvas — ferramentas": "On the canvas — tools",
  "Selecionar · H mão · P caneta · E borracha": "Select · H hand · P pen · E eraser",
  "Retângulo · O elipse · L linha · A seta": "Rectangle · O ellipse · L line · A arrow",
  "Texto · N nota · W portal · C conectar · F fluxo": "Text · N note · W portal · C connect · F flow",
  "Traço mais fino / mais grosso": "Thinner / thicker stroke",
  "Desfazer (Ctrl+Y refaz)": "Undo (Ctrl+Y redoes)",
  "No canvas — seleção": "On the canvas — selection",
  "arrastar": "drag",
  "No fundo vazio: laço de seleção": "On the empty background: lasso selection",
  "Somar ou tirar da seleção": "Add to or remove from the selection",
  "Percorrer os elementos um a um (Shift volta)": "Walk the elements one by one (Shift goes back)",
  "setas": "arrows",
  "Mover a seleção (Shift anda 10×)": "Move the selection (Shift moves 10×)",
  "Duplicar arrastando": "Duplicate by dragging",
  "Arrastar sem o ímã de alinhamento": "Drag without the alignment magnet",
  "Duplicar · Ctrl+C copia · Ctrl+X recorta · Ctrl+V cola": "Duplicate · Ctrl+C copies · Ctrl+X cuts · Ctrl+V pastes",
  "Organizar em grade (de novo troca o layout)": "Arrange in a grid (again switches the layout)",
  "Apagar o que está selecionado (cartões não)": "Delete what is selected (not cards)",
  "Escrevendo numa nota": "Writing in a note",
  "Título 1 · Ctrl+2 e Ctrl+3 os menores · Ctrl+0 volta a parágrafo": "Heading 1 · Ctrl+2 and Ctrl+3 the smaller ones · Ctrl+0 back to paragraph",
  "Link (vira um portal quando clicado na nota)": "Link (becomes a portal when clicked in the note)",
  "Fechar a nota (o markdown é renderizado)": "Close the note (the markdown is rendered)",
  "No canvas — câmera": "On the canvas — camera",
  "roda": "wheel",
  "Zoom no cursor (roda sozinha desloca a tela)": "Zoom at the cursor (the wheel alone pans the view)",
  "Zoom 100% (Ctrl+= aproxima, Ctrl+− afasta)": "Zoom 100% (Ctrl+= zooms in, Ctrl+− zooms out)",
  "Enquadrar tudo · Shift+2 enquadra a seleção": "Frame everything · Shift+2 frames the selection",
  "Mostrar ou esconder o minimapa": "Show or hide the minimap",
  "Andar pelo fio até o próximo conectado (← volta)": "Walk the wire to the next connected one (← goes back)",
  "Espaço": "Space",
  "Mover a tela com qualquer ferramenta": "Pan the view with any tool",
  "2× clique": "double-click",
  "No cabeçalho de um cartão: centralizar em 100%": "On a card's header: center at 100%",
  "No corpo de uma nota: mover": "On a note's body: move",
  "Na nota: seleciona; clicar de novo (ou 2×) abre a edição": "On the note: selects; clicking again (or double-clicking) opens editing",
  "Automático": "Automatic",
  "1 h na assinatura, 5 min na chave de API — o que a própria CLI escolhe": "1 h on the subscription, 5 min on the API key — whatever the CLI itself picks",
  "1 hora": "1 hour",
  "ENABLE_PROMPT_CACHING_1H — a retomada depois de uma pausa longa continua barata; escrever no cache custa mais": "ENABLE_PROMPT_CACHING_1H — resuming after a long pause stays cheap; writing to the cache costs more",
  "5 minutos": "5 minutes",
  "FORCE_PROMPT_CACHING_5M — o TTL curto e mais barato de escrever, mesmo na assinatura": "FORCE_PROMPT_CACHING_5M — the short TTL, cheaper to write, even on the subscription",
  "DISABLE_PROMPT_CACHING — reprocessa a conversa inteira a cada turno; serve para depurar, e sai caro": "DISABLE_PROMPT_CACHING — reprocesses the whole conversation every turn; good for debugging, and expensive",
  "não pergunta antes de editar arquivos nem de rodar comandos": "does not ask before editing files or running commands",
  "o Codex faz cache sozinho, automático a partir de ~1.024 tokens, e não expõe ajuste de duração": "Codex caches on its own, automatically from ~1,024 tokens, and exposes no lifetime setting",
  "sem sandbox e sem confirmação, só em ambiente isolado": "no sandbox and no confirmation — only in an isolated environment",
  "não achamos um ajuste de cache documentado nesta CLI — se ela ganhar um, ele aparece aqui": "we found no documented cache setting in this CLI — if it gets one, it shows up here",
  "aprova todas as ferramentas automaticamente": "approves every tool automatically",
  "aplica as mudanças nos arquivos sem confirmar": "applies the changes to the files without confirming",
  "o aider não usa cache a não ser que você peça — este é o padrão dele": "aider uses no cache unless you ask — that is its default",
  "--cache-prompts --cache-keepalive-pings 12 — doze pings de 5 min mantêm o prefixo quente por ~1 h": "--cache-prompts --cache-keepalive-pings 12 — twelve 5-min pings keep the prefix warm for ~1 h",
  "--cache-prompts — liga o cache e deixa expirar nos 5 min do provedor": "--cache-prompts — turns the cache on and lets it expire at the provider's 5 min",
  "sem --cache-prompts: cada turno reprocessa a conversa inteira": "without --cache-prompts: every turn reprocesses the whole conversation",
  "responde sim a todas as perguntas": "answers yes to every question",
  "libera todas as ferramentas sem perguntar": "unlocks every tool without asking",
  "Nova aba — uma CLI, um shell ou um navegador": "New tab — a CLI, a shell or a browser",
  "Busca — agentes, arquivos, notas e ações, tudo num campo só": "Search — agents, files, notes and actions, all in one field",
  "Compositor — escrever um prompt longo fora do terminal": "Composer — write a long prompt outside the terminal",
  "Ir para o agente que parou e está esperando você": "Go to the agent that stopped and is waiting for you",
  "Bancada — arquivos, tarefas, prompts e controle de versão": "Bench — files, tasks, prompts and source control",
  "Anotações — o caderno markdown fora de qualquer projeto": "Notes — the markdown notebook outside any project",
  "7 dias": "7 days",
  "30 dias": "30 days",
  "Próxima mudança contra o HEAD (Shift+Alt+F5 a anterior)": "Next change against HEAD (Shift+Alt+F5 for the previous one)",
  "Reabrir a última aba de arquivo fechada": "Reopen the last file tab you closed",
  "Fechar as salvas": "Close the saved ones",
  "Fixar": "Pin",
  "Desafixar": "Unpin",
  "Revelar na árvore": "Reveal in the tree",
  "Renomear…": "Rename…",
  "Excluir…": "Delete…",
  "Excluir do disco": "Delete from disk",

  // -- the provisioning catalogue (`lib/provision/errors.ts`) ---------------
  // Every way opening a front can be refused. The code is the contract; these
  // are the sentences beside it.
  "O repositório mudou depois que este plano foi montado. Revalide antes de criar.":
    "The repository changed after this plan was built. Validate it again before creating.",
  "Cancelado antes de terminar.": "Cancelled before it finished.",
  "Não consegui desfazer tudo: {detail}": "I could not undo everything: {detail}",
  "Esta pasta não é um repositório git: a frente vai dividir o diretório do chão, sem isolamento.":
    "This folder is not a git repository: the front will share the ground's directory, with no isolation.",
  "O repositório ainda não tem nenhum commit — faça o primeiro antes de abrir uma frente.":
    "The repository has no commit yet — make the first one before opening a front.",
  "A branch {branch} já existe. Escolha outro nome, ou abra a frente sobre ela como branch existente.":
    "Branch {branch} already exists. Pick another name, or open the front on it as an existing branch.",
  "A branch {branch} já está aberta em {path}. O git só dá um worktree por branch.":
    "Branch {branch} is already open at {path}. Git gives out one worktree per branch.",
  "A branch {branch} não existe mais neste repositório.":
    "Branch {branch} does not exist in this repository any more.",
  "Não consegui resolver {base} para um commit.": "I could not resolve {base} to a commit.",
  "Já existe alguma coisa em {path}.": "There is already something at {path}.",
  "O git não lista mais um worktree em {path}.":
    "Git no longer lists a worktree at {path}.",
  "Esse worktree está travado (`git worktree lock`): {reason}":
    "That worktree is locked (`git worktree lock`): {reason}",
  "Esse worktree tem alterações não commitadas. O agente começa em cima delas.":
    "That worktree has uncommitted changes. The agent starts on top of them.",
  "Já há agente trabalhando neste destino. Dois processos no mesmo diretório se atropelam: o git não isola um do outro.":
    "There is already an agent working at this destination. Two processes in one directory trample each other: git isolates neither.",
  "O chão é a cópia que você tem aberta. O agente vai editar os mesmos arquivos que você.":
    "The ground is the copy you have open. The agent will edit the same files you are editing.",
  'Dois agentes desta leva pedem o nome "{name}".':
    'Two agents in this batch ask for the name "{name}".',
  "Dois agentes desta leva pedem a branch {branch}.":
    "Two agents in this batch ask for branch {branch}.",
  "Dois agentes desta leva pedem a pasta {path}.":
    "Two agents in this batch ask for folder {path}.",
  "{agent} não está instalado nesta máquina.": "{agent} is not installed on this machine.",
  "A frente existe, mas o agente não subiu: {detail}":
    "The front exists, but the agent did not come up: {detail}",
  "O setup da frente falhou: {detail}": "The front's setup failed: {detail}",
  "sem motivo": "no reason given",
} satisfies Record<string, string>;
