/**
 * English lines of Configurações (`components/Settings/`): the category menu,
 * every section (Interface, Terminal, Editor, Agentes, Comportamento,
 * Atalhos, Dados e backup, Extensões, Servidores MCP) and the row
 * primitives. Key = the PT-BR sentence as written in the component.
 * Sentences that read the same in English ("Interface", "Terminal", "Logs",
 * "WebGL (experimental)") are left out on purpose.
 *
 * The tables the sections render but do not own — the shortcut groups
 * (`lib/shortcuts.ts`), the extension catalog (`lib/extensions.ts`), the
 * cache choices and skip-flag hints (`lib/agentDefaults.ts`,
 * `lib/termArgs.ts`), the role launch hint (`lib/roles.ts`) and the MCP
 * scope/transport labels (`lib/mcp.ts`) — carry their English in `lib.ts`,
 * next to the table.
 */
export default {
  // -- the window and the menu (Settings/index.tsx, categories.ts) ---------
  Configurações: "Settings",
  Categorias: "Categories",
  Fechar: "Close",
  "Fechar (Esc)": "Close (Esc)",
  "Yard · dados em %APPDATA%\\Yard": "Yard · data in %APPDATA%\\Yard",
  "Fonte e aparência do aplicativo": "Font and appearance of the app",
  "Fonte, renderização e histórico dos terminais": "Font, rendering and scrollback of the terminals",
  "Editor de código": "Code editor",
  "Como o editor de arquivos desenha e indenta o código": "How the file editor draws and indents code",
  Agentes: "Agents",
  "Como cada CLI de código abre, e o que avisa quando ela para":
    "How each coding CLI opens, and what warns you when it stops",
  Comportamento: "Behavior",
  "Confirmações e padrões do aplicativo": "Confirmations and defaults of the app",
  Atalhos: "Shortcuts",
  "O mapa de teclado do Yard": "Yard's keyboard map",
  "Dados e backup": "Data & backup",
  "Onde o Yard guarda o workspace, e como levá-lo junto":
    "Where Yard keeps the workspace, and how to take it along",
  Extensões: "Extensions",
  "Recursos que já vêm com o Yard — ligar é instalar":
    "Features that ship with Yard — turning one on is installing it",
  "Servidores MCP": "MCP servers",
  "Os servidores de ferramentas de cada CLI, num lugar só": "Each CLI's tool servers, in one place",

  // -- Interface -------------------------------------------------------------
  Aparência: "Appearance",
  Tema: "Theme",
  Escuro: "Dark",
  Claro: "Light",
  Sistema: "System",
  "Escuro é a cara do Yard; Claro troca o papel, não a linguagem — o azul, os raios e a semântica das cores ficam. Sistema segue o Windows. As extensões de tema de cor continuam mandando no terminal e no editor.":
    "Dark is Yard's face; Light swaps the paper, not the language — the blue, the radii and the meaning of the colors stay. System follows Windows. The color-scheme extensions still rule the terminal and the editor.",
  Idioma: "Language",
  "Idioma da interface": "Interface language",
  "Muda só a interface do Yard: os terminais e as CLIs falam a língua delas.":
    "Changes only Yard's interface: the terminals and the CLIs speak their own language.",
  Fontes: "Fonts",
  "Fonte da interface": "Interface font",
  "Procurando fontes…": "Looking for fonts…",
  "Padrão do Yard": "Yard default",
  "Não consegui ler as fontes instaladas nesta máquina: {reason}. Os seletores de fonte desta tela mostram só as que vêm com o Yard.":
    "I could not read the fonts installed on this machine: {reason}. The font pickers on this screen only show the ones that ship with Yard.",
  "Procurar de novo": "Search again",
  "A lista vem das fontes instaladas na máquina; as famílias que vêm com o Yard entram quando a":
    "The list comes from the fonts installed on this machine; the families that ship with Yard join it when the",
  "está ligada.": "is on.",
  "Barra de título": "Title bar",
  "Medidor de limites de uso": "Usage-limit meter",
  "Quanto resta das janelas do Claude, do Codex e do Grok, na barra de título":
    "How much is left of the Claude, Codex and Grok windows, in the title bar",

  // -- Terminal --------------------------------------------------------------
  "Canvas (estável)": "Canvas (stable)",
  "Fonte do terminal": "Terminal font",
  "Tamanho da fonte": "Font size",
  Renderizador: "Renderer",
  "Linhas de histórico": "Scrollback lines",
  "Aparência do terminal": "Terminal appearance",
  "Cursor piscante": "Blinking cursor",
  "O cursor do terminal pisca quando o painel está em foco":
    "The terminal cursor blinks while the pane has focus",
  "Ligaduras no terminal": "Ligatures in the terminal",
  "Desenha => e != como um símbolo só; o que os programas recebem não muda":
    "Draws => and != as one glyph; what the programs receive does not change",
  "O renderizador WebGL é mais rápido em telas grandes, mas depende do driver de vídeo; se o terminal piscar ou ficar em branco, volte para canvas.":
    "The WebGL renderer is faster on large screens but depends on the video driver; if the terminal flickers or goes blank, switch back to canvas.",

  // -- Editor de código ------------------------------------------------------
  "Fonte do código": "Code font",
  "Altura da linha": "Line height",
  "Largura da tabulação": "Tab width",
  "Como o código é desenhado": "How the code is drawn",
  "Ligaduras no código": "Ligatures in code",
  "A opção vale quando a fonte escolhida as tem": "Applies when the chosen font has them",
  "Indentar com tabulação em vez de espaços": "Indent with tabs instead of spaces",
  "O Tab escreve um caractere de tabulação de verdade": "Tab writes a real tab character",
  "Números de linha": "Line numbers",
  "Calha de números no editor de arquivos": "Number gutter in the file editor",
  "Guias de coluna": "Column guides",
  "Linhas verticais nas colunas escolhidas, separadas por vírgula. Vazio, nenhuma":
    "Vertical lines at the columns you name, separated by commas. Empty, none",
  "Quebrar linhas longas": "Wrap long lines",
  // Interface — the status bar rows
  "Barra de status": "Status bar",
  "Mostrar a barra de status": "Show the status bar",
  "No rodapé da janela: agentes esperando você, a branch do projeto, fluxos em andamento e a memória — e atalhos para a Busca, o compositor e o mapa de teclas":
    "In the window's footer: agents waiting for you, the project's branch, flows in progress and memory — plus shortcuts to Search, the composer and the key map",
  "Linhas mais largas que o painel continuam na linha de baixo":
    "Lines wider than the pane continue on the line below",
  "Servidores de linguagem": "Language servers",
  "Servidores de linguagem (LSP)": "Language servers (LSP)",
  "Completar, erros, ir para a definição, referências, renomear e formatar no editor de arquivos — com o servidor de cada linguagem instalado nesta máquina":
    "Completion, errors, go to definition, references, rename and format in the file editor — with each language's server installed on this machine",
  "O editor liga ao servidor da linguagem do arquivo aberto (um por projeto) e o desliga quando o último arquivo daquele projeto fecha. Sem servidor, o editor completa palavras do próprio arquivo, como antes. F12 vai para a definição, Shift+F12 lista as referências, F2 renomeia o símbolo, Shift+Alt+F formata.":
    "The editor connects to the server of the open file's language (one per project) and disconnects it when the last file of that project closes. Without a server, the editor completes words from the file itself, as before. F12 goes to the definition, Shift+F12 lists the references, F2 renames the symbol, Shift+Alt+F formats.",
  "A fonte vale para o editor de arquivos, diffs e trechos de código; tamanho, altura da linha, tabulação e numeração valem para o editor de arquivos, e a amostra acima mostra o resultado. A largura da tabulação é quantas colunas um recuo ocupa — e, com a indentação por tabulação desligada, quantos espaços o Tab escreve. Ligaduras juntam símbolos num desenho só (=> vira uma seta, != vira ≠) sem mudar os caracteres do arquivo.":
    "The font applies to the file editor, diffs and code snippets; size, line height, tabs and numbering apply to the file editor, and the sample above shows the result. The tab width is how many columns an indent takes — and, with tab indentation off, how many spaces Tab writes. Ligatures join symbols into one glyph (=> becomes an arrow, != becomes ≠) without changing the file's characters.",
  // the language-server catalog (LspServers.tsx)
  "parou: {failure}": "stopped: {failure}",
  "não encontrado — instale com: {hint}": "not found — install with: {hint}",
  "instalado (versão desconhecida)": "installed (unknown version)",
  "Servidores nesta máquina": "Servers on this machine",
  "Um por linguagem; o editor usa o que estiver instalado e ignora o resto.":
    "One per language; the editor uses what is installed and ignores the rest.",
  "Procurando…": "Searching…",
  "Não consegui ler o catálogo de servidores: {error}": "I could not read the server catalog: {error}",

  // -- Agentes ---------------------------------------------------------------
  "Sem pedir permissão": "Without asking permission",
  "Sem pedir permissão — {name}": "Without asking permission — {name}",
  "esta CLI não tem uma flag de permissão que a gente tenha conferido — o que ela precisar vai na linha abaixo":
    "this CLI has no permission flag we have verified — whatever it needs goes on the line below",
  "sem flag": "no flag",
  "Nome da aba": "Tab name",
  "Como a aba e o cartão vão se chamar. Vazio = o nome da CLI.":
    "What the tab and the card will be called. Empty = the CLI's own name.",
  "Abre sempre com": "Always opens with",
  "opcional — ex.: --model opus --add-dir ../api": "optional — e.g. --model opus --add-dir ../api",
  "Roda em": "Runs on",
  "no WSL a CLI é a que estiver instalada dentro da distribuição, e a pasta do projeto entra traduzida":
    "on WSL the CLI is the one installed inside the distribution, and the project folder goes in translated",
  "por SSH o processo nasce na outra máquina: a CLI é a que estiver instalada lá, e a pasta é a remota":
    "over SSH the process is born on the other machine: the CLI is the one installed there, and the folder is the remote one",
  "o processo nasce no Windows, com a CLI que o Yard detectou aqui":
    "the process is born on Windows, with the CLI Yard detected here",
  "Onde {name} roda": "Where {name} runs",
  "Distribuição de {name}": "Distribution for {name}",
  "A padrão do WSL": "WSL's default",
  "host — alias do ~/.ssh/config ou user@host": "host — an alias from ~/.ssh/config or user@host",
  "Host SSH de {name}": "SSH host for {name}",
  "pasta remota — vazio = a home": "remote folder — empty = the home",
  "Pasta remota de {name}": "Remote folder for {name}",
  "Cache da conversa": "Conversation cache",
  "Cache de {name}": "{name} cache",
  "sem ajuste": "no setting",
  "Aparecer em “Nova aba”": "Show in “New tab”",
  "Desligado, continua instalado e configurado aqui — só sai da grade de marcas e da lista de uma tarefa nova":
    "Off, it stays installed and configured here — it only leaves the grid of marks and the list of a new task",
  "Aparecer em Nova aba — {name}": "Show in New tab — {name}",
  Papel: "Role",
  "Toda aba nova desta CLI nasce com esse papel — e os recrutados no canvas sem":
    "Every new tab of this CLI is born with this role — and so are the ones recruited on the canvas without",
  "também. Dá para trocar depois no menu do cartão, sem mexer aqui.":
    "as well. It can be changed later from the card's menu, without touching this.",
  "o WSL não está disponível": "WSL is not available",
  "— este agente vai tentar abrir assim mesmo até você trocar para Windows.":
    "— this agent will try to open anyway until you switch to Windows.",
  "A CLI tem de estar instalada no host, e a chave SSH tem de entrar sem senha — se pedir senha, ela aparece no terminal e funciona, mas o papel e o cache não chegam antes dela. O":
    "The CLI has to be installed on the host, and the SSH key has to log in without a password — if it asks for one, the prompt shows in the terminal and works, but the role and the cache do not reach the CLI before it. The",
  "não atravessa o SSH: a CLI remota não fala com as outras do canvas.":
    "does not cross SSH: the remote CLI cannot talk to the others on the canvas.",
  "o SSH não está disponível": "SSH is not available",
  "Sem host não há para onde ir: a CLI não abre até você preencher o campo acima.":
    "With no host there is nowhere to go: the CLI will not open until you fill in the field above.",
  "Esta CLI não foi encontrada nesta máquina. O que você configurar aqui fica guardado e passa a valer assim que ela aparecer.":
    "This CLI was not found on this machine. What you set here is kept and takes effect as soon as it shows up.",
  "não consegui perguntar pelo ssh": "I could not ask about ssh",
  "não consegui perguntar ao WSL": "I could not ask WSL",
  "Como cada CLI abre": "How each CLI opens",
  "Nenhuma CLI de agente por aqui": "No agent CLI around here",
  "Instale uma (Claude Code, Codex, Gemini…) e ela aparece nesta lista na próxima vez que o Yard abrir.":
    "Install one (Claude Code, Codex, Gemini…) and it shows up in this list the next time Yard opens.",
  "não instalado": "not installed",
  "É daqui que sai tudo o que uma aba nova daquela CLI recebe — em “Nova aba” um clique já abre, sem formulário — e também o que vai para os agentes que nascem sem diálogo nenhum: os recrutados no canvas":
    "This is where everything a new tab of that CLI receives comes from — in “New tab” one click opens it, no form — and also what goes to the agents born with no dialog at all: the ones recruited on the canvas",
  "), os de uma tarefa em frentes e as conversas retomadas. Quem já está aberto não muda: vale a partir do próximo início.":
    "), the ones of a task on fronts and the resumed conversations. Whoever is already open does not change: it applies from the next start.",
  O: "The",
  "só aparece como escolha nas CLIs que documentam um ajuste — hoje o Claude Code (variáveis de ambiente) e o aider (flags). O Codex faz cache sozinho e não expõe duração; nas outras a gente não achou nada documentado, e é isso que a linha delas diz, em vez de um controle que não faria nada.":
    "only appears as a choice in the CLIs that document a setting — today Claude Code (environment variables) and aider (flags). Codex caches on its own and exposes no lifetime; in the others we found nothing documented, and that is what their line says, instead of a control that would do nothing.",
  Notificações: "Notifications",
  Custos: "Costs",
  "levar o yard": "carry yard over",
  "“Levar o yard” abre um túnel reverso e escreve um shim em ~/.yard/bin da máquina remota, para o agente de lá poder usar `yard ask`, notas, portais e avisar que terminou. Precisa de python3 no host. O túnel deixa este workspace alcançável pelo loopback daquela máquina, protegido por um token da sessão que vive no ambiente do processo remoto: ligue só em hosts em que você já confia o código.":
    "“Carry yard over” opens a reverse tunnel and writes a shim into ~/.yard/bin on the remote machine, so the agent there can use `yard ask`, notes, portals and say it has finished. It needs python3 on the host. The tunnel makes this workspace reachable from that machine's loopback, guarded by a session token that lives in the remote process's environment: turn it on only for hosts you already trust with your code.",
  "Avisar também fora da máquina": "Also notify off this machine",
  "Um POST com o mesmo aviso para o endereço que você colar (ntfy, Discord, Slack, o seu). Vai o título e a frase, que pode conter a pergunta em que o agente parou. Vazio desliga.":
    "A POST with the same notice to the address you paste in (ntfy, Discord, Slack, your own). The title and the sentence go out, and the sentence can carry the question the agent stopped on. Empty turns it off.",
  "ex.: https://ntfy.sh/meu-topico": "e.g. https://ntfy.sh/my-topic",
  "O endereço precisa ser https (ou http em localhost): o texto pode conter o que o agente escreveu, e isso não sai em claro.":
    "The address has to be https (or http on localhost): the text can carry what the agent wrote, and that does not go out in the clear.",
  "Teto de gasto por dia (US$)": "Daily spend ceiling (US$)",
  "Zero desliga. Com um teto, o Yard avisa uma vez ao passar de 80% e uma vez ao estourar, no rodapé, num balão e na borda de gatilho “estourar o orçamento do dia”. A conta é a mesma de Custos e uso (Ctrl+Alt+U): uma estimativa lida dos arquivos de sessão das CLIs, e um dia com modelo fora da tabela de preços é um piso, não um total.":
    "Zero turns it off. With a ceiling, Yard says so once at 80% and once past the line, in the footer, in a balloon, and on the “blows the day's budget” trigger edge. The sum is the one from Custos e uso (Ctrl+Alt+U): an estimate read from the CLIs' own session files, and a day with a model outside the price table is a floor, not a total.",
  "Notificar quando um agente terminar": "Notify when an agent finishes",
  "Notificação nativa do Windows quando a saída fica quieta":
    "A native Windows notification when the output goes quiet",
  "Avisar quando um agente travar": "Warn when an agent gets stuck",
  "Uma pergunta, um (y/N) ou uma senha na última linha viram notificação com a pergunta dentro — o badge amarelo no cartão aparece de qualquer jeito":
    "A question, a (y/N) or a password on the last line become a notification with the question inside — the yellow badge on the card shows up regardless",
  "Um agente conta como “parou” depois de ~4,5 s de silêncio seguindo atividade. O silêncio diz que parou; a cauda da saída diz por quê — um menu com cursor, um (y/N) ou um Password: na última linha viram “travado” em vez de “terminou”. O balão só sai quando o painel não está à vista: o que você acabou de ver acontecer não vira notificação.":
    "An agent counts as “stopped” after ~4.5 s of silence following activity. The silence says it stopped; the tail of the output says why — a menu with a cursor, a (y/N) or a Password: on the last line become “stuck” instead of “finished”. The balloon only fires when the pane is out of sight: what you just watched happen never becomes a notification.",

  // -- Comportamento ---------------------------------------------------------
  "Confirmar ao sair com terminais vivos": "Confirm before quitting with live terminals",
  "Um aviso antes de fechar a janela quando ainda há processos rodando":
    "A warning before closing the window while processes are still running",
  "Fechar para a bandeja": "Close to the tray",
  "O X esconde a janela; as CLIs continuam. Sair fica no menu do ícone da bandeja (e na busca).":
    "The X hides the window; the CLIs keep going. Quit lives in the tray icon's menu (and in Search).",
  Restaurar: "Restore",
  "Restaurar padrões": "Restore defaults",
  "Fontes, métricas do editor, renderizador, histórico e larguras dos painéis voltam como vieram. Projetos, terminais e extensões não são tocados.":
    "Fonts, editor metrics, renderer, scrollback and panel widths go back to how they came. Projects, terminals and extensions are not touched.",
  "Restaurar as preferências ao padrão do Yard? Fontes, tamanho e altura da linha do editor, tabulação, numeração, renderizador, linhas de histórico e larguras dos painéis voltam como vieram. Projetos, terminais e extensões não são tocados.":
    "Restore the preferences to Yard's defaults? Fonts, the editor's size and line height, tabs, line numbers, renderer, scrollback lines and panel widths go back to how they came. Projects, terminals and extensions are not touched.",
  "Preferências restauradas.": "Preferences restored.",

  // -- Atalhos ---------------------------------------------------------------
  "Fora da janela": "Outside the window",
  "Atalho global para trazer o Yard": "Global hotkey to summon Yard",
  "Funciona de qualquer aplicativo: traz a janela (ou a esconde, se já está na frente). Vazio desliga.":
    "Works from any application: brings the window (or hides it, if it is already in front). Empty turns it off.",
  "ex.: Ctrl+Alt+Y": "e.g. Ctrl+Alt+Y",
  "Um atalho global precisa de pelo menos um modificador (Ctrl, Alt, Shift ou Win) e uma tecla — por exemplo":
    "A global hotkey needs at least one modifier (Ctrl, Alt, Shift or Win) and a key — for example",
  ou: "or",
  "Fora essas, tudo que você digita vai direto para a CLI — o Yard não intercepta teclas que o terminal precisa. Os atalhos do editor, do markdown e do canvas aparecem na lista completa (Ctrl+Shift+H).":
    "Beyond these, everything you type goes straight to the CLI — Yard does not intercept keys the terminal needs. The editor, markdown and canvas shortcuts appear in the full list (Ctrl+Shift+H).",

  // -- Dados e backup --------------------------------------------------------
  "Próximo: na próxima verificação (o Yard confere a cada hora).":
    "Next: at the next check (Yard looks every hour).",
  "Próximo: hoje às {when} (o Yard confere a cada hora).": "Next: today at {when} (Yard looks every hour).",
  "Próximo: {when} (o Yard confere a cada hora).": "Next: {when} (Yard looks every hour).",
  "Versão instalada: {version} · última verificação: {when}":
    "Installed version: {version} · last check: {when}",
  "Versão instalada: {version} · ainda não verificado": "Installed version: {version} · not checked yet",
  "Pacote de suporte": "Support bundle",
  "Pacote gerado ({kb} KB).": "Bundle written ({kb} KB).",
  "Link e roteiro copiados. Cole na issue e anexe o .zip.":
    "Link and outline copied. Paste them into the issue and attach the .zip.",
  "Não consegui copiar para a área de transferência.": "I could not copy to the clipboard.",
  "Backup do Yard": "Yard backup",
  "Backup exportado.": "Backup exported.",
  "Falha ao exportar: {error}": "Export failed: {error}",
  "Backup preparado. Ele entra no lugar quando o Yard reabrir.":
    "Backup staged. It takes over when Yard reopens.",
  "Falha ao importar: {error}": "Import failed: {error}",
  "Há um backup restaurado esperando. Ele substitui o workspace atual quando o Yard reabrir — até lá, tudo o que você fizer vai para o estado que será descartado.":
    "A restored backup is waiting. It replaces the current workspace when Yard reopens — until then, everything you do goes into the state that will be discarded.",
  Atualizações: "Updates",
  "Verificando…": "Checking…",
  "Verificar agora": "Check now",
  "Versão {version} disponível": "Version {version} available",
  "Assinada e pronta para instalar.": "Signed and ready to install.",
  "Instalar e reiniciar": "Install and restart",
  "Ignorar esta versão": "Skip this version",
  "Não consegui verificar atualizações: {error}": "I could not check for updates: {error}",
  "Não consegui instalar: {error}": "I could not install: {error}",
  "Verificar automaticamente": "Check automatically",
  "A cada seis horas, em silêncio quando não há nada novo.":
    "Every six hours, silently when there is nothing new.",
  "Backup do workspace": "Workspace backup",
  "Um .zip com projetos, grupos, layout e histórico. O backup importado entra no lugar quando o Yard reabrir.":
    "A .zip with projects, groups, layout and scrollback. An imported backup takes over when Yard reopens.",
  Exportar: "Export",
  Importar: "Import",
  "Backup restaurado esperando": "Restored backup waiting",
  "O Yard reabre já com ele no lugar; cancelar descarta o que foi importado.":
    "Yard reopens with it already in place; cancelling discards what was imported.",
  "Reiniciar agora": "Restart now",
  Cancelar: "Cancel",
  "Relatar um problema": "Report a problem",
  "Gera um .zip com os logs dos últimos dois dias e a lista de CLIs desta máquina — sem banco, sem histórico dos terminais, sem anotações.":
    "Writes a .zip with the last two days of logs and the list of CLIs on this machine — no database, no terminal history, no notes.",
  "Gerar pacote…": "Write bundle…",
  "Copiar link do rastreador": "Copy the tracker link",
  "Pacote gerado": "Bundle written",
  "{n} itens: {list}": "{n} items: {list}",
  "Mostrar na pasta": "Show in folder",
  "Não consegui gerar o pacote: {error}": "I could not write the bundle: {error}",
  "Backup automático": "Automatic backup",
  Desligado: "Off",
  Diário: "Daily",
  Semanal: "Weekly",
  "Guardar as últimas cópias": "Keep the last copies",
  "Pasta dos backups": "Backups folder",
  "{dir} (padrão)": "{dir} (default)",
  "A pasta backups dentro dos dados do Yard (padrão)": "The backups folder inside Yard's data (default)",
  "Escolher…": "Choose…",
  Padrão: "Default",
  "Último backup automático: {when}": "Last automatic backup: {when}",
  "Ligue acima para o Yard copiar sozinho. Fazer agora grava uma cópia mesmo desligado.":
    "Turn it on above for Yard to copy on its own. Do it now writes a copy even while off.",
  "Gravando…": "Writing…",
  "Fazer agora": "Do it now",
  "O último backup automático falhou: {error}": "The last automatic backup failed: {error}",
  "Pasta de dados": "Data folder",
  "Banco, scrollback e logs, com rotação diária.": "Database, scrollback and logs, rotated daily.",
  "Abrir pasta": "Open folder",
  "Não consegui descobrir onde ficam os dados do Yard: {reason}.":
    "I could not find where Yard's data lives: {reason}.",
  Caminhos: "Paths",
  Banco: "Database",

  // -- Extensões -------------------------------------------------------------
  "Tudo já vem com o Yard — ligar é instalar, e vale na hora, sem reiniciar.":
    "Everything ships with Yard — turning it on is installing it, and it applies at once, no restart.",
  "A loja completa": "The full store",
  ", com prévias ao vivo e os temas de cor, abre com Ctrl+Shift+X.":
    ", with live previews and the color themes, opens with Ctrl+Shift+X.",

  // -- Servidores MCP --------------------------------------------------------
  "Não consegui ler o servidor: {error}": "I could not read the server: {error}",
  "Remover o servidor “{name}” da configuração de {cli} ({scope})? O arquivo {file} é reescrito sem ele.":
    "Remove the server “{name}” from the {cli} configuration ({scope})? The file {file} is rewritten without it.",
  "Remover servidor MCP": "Remove MCP server",
  "Servidor “{name}” removido.": "Server “{name}” removed.",
  "Não consegui ler o servidor para ligá-lo/desligá-lo.": "I could not read the server to turn it on or off.",
  "“{name}” desligado.": "“{name}” turned off.",
  "“{name}” ligado.": "“{name}” turned on.",
  "Não consegui ler o servidor para copiá-lo.": "I could not read the server to copy it.",
  "“{name}” copiado para {cli} (usuário).": "“{name}” copied to {cli} (user).",
  "“{name}” atualizado.": "“{name}” updated.",
  "“{name}” adicionado.": "“{name}” added.",
  "Não consegui ler {file}": "I could not read {file}",
  "Cada CLI guarda seus servidores MCP num arquivo próprio; aqui eles aparecem juntos e editáveis, e o que não é do Yard no arquivo fica como estava.":
    "Each CLI keeps its MCP servers in a file of its own; here they appear together and editable, and whatever in the file is not Yard's stays as it was.",
  "Os escopos": "The scopes",
  e: "and",
  projeto: "project",
  "são do projeto ativo,": "belong to the active project,",
  "Sem projeto ativo, só o escopo de usuário aparece.": "With no active project, only the user scope shows.",
  "Lendo…": "Reading…",
  "não instalada nesta máquina": "not installed on this machine",
  "Esta CLI ainda não é suportada aqui.": "This CLI is not supported here yet.",
  "Nenhum servidor configurado.": "No server configured.",
  "Removendo…": "Removing…",
  "Ligando…": "Turning on…",
  "Desligando…": "Turning off…",
  "Copiando…": "Copying…",
  "Adicionar servidor": "Add server",
  desligado: "off",
  "{n} valor guardado": "{n} stored value",
  "{n} valores guardados": "{n} stored values",
  "Copiar para…": "Copy to…",
  "Grava o mesmo servidor no escopo de usuário da outra CLI":
    "Writes the same server into the other CLI's user scope",
  "Desligar sem apagar": "Turn off without deleting",
  "Ligar de novo": "Turn on again",
  Desligar: "Turn off",
  Ligar: "Turn on",
  Editar: "Edit",
  "Reescreve o arquivo sem este servidor (pede confirmação)":
    "Rewrites the file without this server (asks first)",
  Remover: "Remove",
  "stdio — um processo local": "stdio — a local process",
  "HTTP — um endereço remoto": "HTTP — a remote address",
  "SSE — um endereço remoto (eventos)": "SSE — a remote address (events)",
  "WebSocket (só o Claude Code)": "WebSocket (Claude Code only)",
  Nome: "Name",
  "ex.: context7": "e.g. context7",
  Transporte: "Transport",
  Endereço: "Address",
  Cabeçalhos: "Headers",
  "Um CHAVE=valor por linha (ex.: Authorization=Bearer …)":
    "One KEY=value per line (e.g. Authorization=Bearer …)",
  Comando: "Command",
  "ex.: npx": "e.g. npx",
  Argumentos: "Arguments",
  "Como numa linha de comando; aspas agrupam": "As on a command line; quotes group",
  "ex.: -y “@upstash/context7-mcp”": "e.g. -y “@upstash/context7-mcp”",
  "Variáveis de ambiente": "Environment variables",
  "Um CHAVE=valor por linha": "One KEY=value per line",
  Escopo: "Scope",
  Ligado: "On",
  Salvar: "Save",
  Adicionar: "Add",
  // Ajustes → Terminal and Ajustes → Editor: one colour-scheme slot each
  "Tema de cor": "Color theme",

  // -- the features that ship turned off ------------------------------------
  // They had a store shelf of their own until it was retired; each one is a
  // row now, on the page of the surface it changes. The labels below were the
  // cards' names.
  "Ícones de arquivo": "File icons",
  "Tema de ícones": "Icon theme",
  Nenhum: "None",
  "Os ícones valem para a árvore de arquivos, a Busca e as abas. Em Nenhum, o Yard usa o glifo neutro de sempre e só o estado do git colore a árvore. Os dois temas vêm embutidos: o mapa de ícones só é carregado quando um deles é escolhido.":
    "The icons apply to the file tree, Search and the tabs. On None, Yard uses its usual neutral glyph and only the git state colors the tree. Both themes are bundled: the icon map is only loaded once one of them is chosen.",

  "Recursos do editor": "Editor features",
  Minimapa: "Minimap",
  "O arquivo inteiro em miniatura na borda direita, com a janela visível marcada":
    "The whole file in miniature on the right edge, with the visible window marked",
  "Guias de indentação": "Indent guides",
  "Linhas verticais marcando cada nível de recuo, com o bloco ativo destacado":
    "Vertical lines marking each indent level, with the active block highlighted",
  "Parênteses arco-íris": "Rainbow brackets",
  "Cada nível de ( ) [ ] { } numa cor; colchete dentro de texto ou comentário não conta":
    "Each level of ( ) [ ] { } in a color; a bracket inside text or a comment does not count",
  "Realce de TODO": "TODO highlight",
  "TODO, FIXME, HACK e NOTE viram etiquetas coloridas no meio do arquivo":
    "TODO, FIXME, HACK and NOTE become colored tags in the middle of the file",
  "Cores no CSS": "Colors in CSS",
  "Um quadradinho da cor real ao lado de cada #hex e rgb(), clicável para trocar":
    "A small square of the real color beside each #hex and rgb(), clickable to change it",
  "Formatar ao salvar": "Format on save",
  "Ctrl+S passa o arquivo pelo Prettier antes de gravar; com erro de sintaxe, salva como está":
    "Ctrl+S runs the file through Prettier before writing; with a syntax error, it saves as is",

  "Diagramas Mermaid": "Mermaid diagrams",
  "Blocos ```mermaid viram diagramas na leitura e no modo dividido":
    "```mermaid blocks become diagrams in the read and split modes",
  "Fórmulas KaTeX": "KaTeX formulas",
  "Blocos ```math viram fórmulas na leitura e no modo dividido":
    "```math blocks become formulas in the read and split modes",
  "Vale para os arquivos .md do editor e para as Anotações. Um bloco com erro de sintaxe continua aparecendo como código, nunca como uma tela quebrada.":
    "Applies to the editor's .md files and to Notes. A block with a syntax error keeps showing as code, never as a broken screen.",

  "Recursos do terminal": "Terminal features",
  "Imagens no terminal": "Images in the terminal",
  "Os protocolos sixel e iTerm desenham imagens de verdade no histórico — gráficos de ferramentas, prévias, o timg da vida":
    "The sixel and iTerm protocols draw real images in the scrollback — tool charts, previews, the odd timg",

  "Fontes de código embutidas": "Bundled code fonts",
  "Dez famílias monoespaçadas que vêm com o Yard (JetBrains Mono, Fira Code, Iosevka…) entram nos seletores de fonte, sem instalar nada no Windows":
    "Ten monospaced families that come with Yard (JetBrains Mono, Fira Code, Iosevka…) join the font pickers, with nothing installed on Windows",
  "A lista vem das fontes instaladas na máquina, mais as que vêm com o Yard quando a chave acima está ligada. A fonte da interface vale para o cromo do aplicativo; a do terminal e a do código são escolhidas em Ajustes → Terminal e Ajustes → Editor de código.":
    "The list comes from the fonts installed on the machine, plus the ones that come with Yard while the switch above is on. The interface font applies to the app's chrome; the terminal's and the code's are chosen in Settings → Terminal and Settings → Code editor.",

  "O tema de cor troca os 16 tons ANSI, o fundo e o cursor dos terminais; o editor tem o dele, em Ajustes → Editor de código. O cromo do Yard não muda: tema é cor de conteúdo, não de moldura.":
    "The color theme swaps the 16 ANSI tones, the background and the cursor of the terminals; the editor has its own, in Settings → Code editor. Yard's chrome does not change: a theme is content color, not frame color.",
  "O tema de cor pinta a sintaxe do editor, dos diffs e dos trechos de código; os terminais têm o deles, em Ajustes → Terminal. Escolher o mesmo nos dois deixa a tela inteira na mesma paleta.":
    "The color theme paints the syntax of the editor, the diffs and the code snippets; the terminals have their own, in Settings → Terminal. Choosing the same one in both puts the whole screen on one palette.",
  "Escuro é a cara do Yard; Claro troca o papel, não a linguagem — o azul, os raios e a semântica das cores ficam. Sistema segue o Windows. O tema de cor do terminal e o do editor são escolhidos à parte, na página de cada um.":
    "Dark is Yard's face; Light swaps the paper, not the language — the blue, the radii and the semantics of the colors stay. System follows Windows. The terminal's color theme and the editor's are chosen apart, on the page of each.",
} satisfies Record<string, string>;
