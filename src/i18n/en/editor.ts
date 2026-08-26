/**
 * English lines of the file editor (`components/CodeEditor/`): document
 * header, formatting bar, outline, search bar, media viewer, diff tab,
 * markdown preview, and the markdown / editor libs. Key = the PT-BR sentence.
 */
export default {
  // --- the four ways to look at a markdown file ---------------------------
  Editar: "Edit",
  "Fonte do markdown": "Markdown source",
  Dividido: "Split",
  Ler: "Read",
  "escreve markdown já desenhado": "write markdown as it is drawn",
  "o texto cru, como o agente lê": "the raw text, as the agent reads it",
  "fonte de um lado, página do outro": "source on one side, page on the other",
  "só a página, largura toda": "the page only, full width",
  "Como mostrar o markdown": "How to show the markdown",

  // --- the path bar's tools ----------------------------------------------
  "Sumário dos títulos": "Heading outline",
  "Símbolos do arquivo": "File symbols",
  "Mostrar ou esconder o sumário": "Show or hide the outline",
  "Mostrar ou esconder os símbolos do arquivo": "Show or hide the file's symbols",
  "Ver desenhado": "View rendered",
  "Ver o código": "View the code",
  "Salvar (Ctrl+S)": "Save (Ctrl+S)",
  "salvando…": "saving…",
  Salvar: "Save",
  "Salvar os {n} arquivos com alterações": "Save the {n} files with changes",
  "Salvar tudo": "Save all",
  "Buscar no arquivo (Ctrl+F)": "Find in file (Ctrl+F)",
  "Buscar no arquivo": "Find in file",
  "Quebra de linha": "Word wrap",
  "Abrir no aplicativo padrão": "Open in the default app",
  "Reler do disco": "Reread from disk",
  "Reler o arquivo do disco": "Reread the file from disk",
  "Mostrar no Explorer": "Show in Explorer",

  // --- the rails and the status line --------------------------------------
  "Sem símbolos ainda — funções e classes do arquivo aparecem aqui.":
    "No symbols yet — the file's functions and classes show up here.",
  Sumário: "Outline",
  "Sem títulos ainda. Comece uma linha com": "No headings yet. Start a line with",
  "e ela aparece aqui.": "and it shows up here.",
  "(sem título)": "(untitled)",
  "somente leitura": "read-only",
  "não salvo": "unsaved",
  "Tarefas concluídas neste arquivo": "Tasks completed in this file",
  "{done}/{total} tarefas": "{done}/{total} tasks",
  "{n} caracteres": "{n} characters",
  "{n} palavra": "{n} word",
  "{n} palavras": "{n} words",
  "Tempo de leitura, a 200 palavras por minuto": "Reading time, at 200 words per minute",
  binário: "binary",
  "Ir para a linha (Ctrl+G)": "Go to line (Ctrl+G)",
  Texto: "Plain text",

  // --- the overlay (canvas) ------------------------------------------------
  "Mostrar ou esconder a árvore": "Show or hide the tree",
  "Mostrar ou esconder a árvore de arquivos": "Show or hide the file tree",
  "Arquivos abertos": "Open files",
  "Fechar {name} (não salvo)": "Close {name} (unsaved)",
  "Fechar {name}": "Close {name}",
  "Fechar o editor (Esc)": "Close the editor (Esc)",
  "Fechar o editor": "Close the editor",
  "Arquivos do projeto": "Project files",
  "Não consegui abrir: {reason}": "Could not open: {reason}",
  "Não achei “{path}” no projeto.": "Could not find “{path}” in the project.",
  "Não sei abrir “{href}”.": "Don't know how to open “{href}”.",

  // --- the disk banners ----------------------------------------------------
  "Esse arquivo não está mais no disco — alguém apagou ou moveu.":
    "This file is no longer on disk — someone deleted or moved it.",
  "Gravar de volta": "Write it back",
  "Fechar a aba": "Close the tab",
  "Arquivo grande demais: só o começo foi carregado, e por isso ele abre em somente leitura.":
    "File too large: only the beginning was loaded, so it opens read-only.",
  "Este arquivo não está em UTF-8 (provavelmente cp1252/latin-1). O que aparece como":
    "This file is not UTF-8 (probably cp1252/latin-1). What shows up as",
  "é byte que não deu para ler, então ele abre em somente leitura — gravar trocaria os acentos originais por esse símbolo no arquivo inteiro. Converta o arquivo para UTF-8 para editá-lo aqui.":
    "is a byte that could not be read, so it opens read-only — saving would replace the original accents with that symbol across the whole file. Convert the file to UTF-8 to edit it here.",
  "Não consegui gravar: {reason}": "Could not save: {reason}",
  "O arquivo mudou no disco desde que você o abriu — nada foi gravado.":
    "The file changed on disk since you opened it — nothing was saved.",
  "Um agente mexeu neste arquivo enquanto você editava.":
    "An agent touched this file while you were editing.",
  "Compara o que está no disco com o seu texto, antes de escolher":
    "Compares what is on disk with your text, before you choose",
  "Esconder a diferença": "Hide the difference",
  "Ver a diferença": "See the difference",
  "Joga fora o seu rascunho e traz a versão do disco":
    "Throws your draft away and brings back the disk version",
  Recarregar: "Reload",
  "Grava o seu texto por cima do que está no disco": "Writes your text over what is on disk",
  "gravando…": "saving…",
  "Salvar por cima": "Overwrite",
  "Não consegui ler o arquivo no disco: {reason}": "Could not read the file on disk: {reason}",
  "lendo o disco…": "reading the disk…",
  "No disco (agora)": "On disk (now)",
  "No seu editor": "In your editor",

  // --- the formatting bar --------------------------------------------------
  Parágrafo: "Paragraph",
  "Título 1": "Heading 1",
  "Título 2": "Heading 2",
  "Título 3": "Heading 3",
  "Título 4": "Heading 4",
  "Título 5": "Heading 5",
  "Título 6": "Heading 6",
  Negrito: "Bold",
  Itálico: "Italic",
  Riscado: "Strikethrough",
  "Marca-texto": "Highlight",
  "Código na linha": "Inline code",
  Lista: "List",
  "Lista numerada": "Numbered list",
  "Lista de tarefas": "Task list",
  Citação: "Quote",
  Imagem: "Image",
  Tabela: "Table",
  "Bloco de código": "Code block",
  "Linha divisória": "Horizontal rule",
  Régua: "Rule",
  "Nota de rodapé — a marca aqui, o texto no fim do arquivo":
    "Footnote — the mark here, the text at the end of the file",
  Rodapé: "Footnote",
  "Concluir ou reabrir a tarefa": "Complete or reopen the task",
  Concluir: "Complete",
  Recuar: "Indent",
  "Tirar o recuo": "Remove the indent",
  Voltar: "Back",
  "Duplicar a linha": "Duplicate the line",
  Duplicar: "Duplicate",
  "Subir a linha": "Move the line up",
  Subir: "Up",
  "Descer a linha": "Move the line down",
  Descer: "Down",
  "Limpar a formatação": "Clear formatting",
  Limpar: "Clear",
  "Formatação do markdown": "Markdown formatting",
  "Menos comandos": "Fewer commands",
  "Mais comandos": "More commands",

  // --- the rendered page ---------------------------------------------------
  "Imagem de fora do projeto — abre como portal no canvas":
    "Image from outside the project — opens as a portal on the canvas",
  "Não consegui ler o arquivo": "Could not read the file",
  "Copiar o bloco": "Copy the block",
  "Copiar o bloco de código": "Copy the code block",
  "Reabrir a tarefa": "Reopen the task",
  "Concluir a tarefa": "Complete the task",
  "Coluna 1": "Column 1",
  "Coluna 2": "Column 2",
  "Coluna 3": "Column 3",

  // --- the media viewer ----------------------------------------------------
  arquivo: "file",
  "O visualizador embutido não deu conta: o formato (ou o codec lá dentro) está fora do que o navegador do app toca. No programa do sistema ele abre.":
    "The built-in viewer could not handle it: the format (or the codec inside it) is outside what the app's browser plays. It opens in the system's own program.",
  Diminuir: "Zoom out",
  ajustada: "fit",
  Aumentar: "Zoom in",
  "Caber na janela": "Fit to window",
  "Tamanho real (1:1)": "Actual size (1:1)",
  "Tamanho real": "Actual size",

  // --- the find bar --------------------------------------------------------
  "Diferenciar maiúsculas de minúsculas": "Match case",
  "Somente palavras inteiras": "Whole words only",
  "Expressão regular": "Regular expression",
  Todas: "All",
  "Selecionar todas as ocorrências": "Select all matches",
  Tudo: "All",
  "Substituir (Ctrl+H)": "Replace (Ctrl+H)",
  "regex inválida": "invalid regex",
  "sem ocorrências": "no matches",
  "{current} de {total}": "{current} of {total}",
  "{n} ocorrência": "{n} match",
  "{n} ocorrências": "{n} matches",

  // --- the tab menu and its confirms ----------------------------------------
  Fechar: "Close",
  "Fechar as outras": "Close the others",
  "Fechar as da direita": "Close the ones to the right",
  "Recarregar do disco": "Reload from disk",
  "Copiar caminho": "Copy path",
  "Copiar caminho completo": "Copy full path",
  "Mostrar na pasta": "Show in folder",
  "“{name}” tem alterações não salvas. Fechar a aba descarta o que você escreveu.":
    "“{name}” has unsaved changes. Closing the tab discards what you wrote.",
  "Fechar sem salvar?": "Close without saving?",
  "Caminho copiado.": "Path copied.",
  "Não consegui copiar.": "Could not copy.",

  // --- the language server transport ---------------------------------------
  "transporte {id} já foi encerrado": "transport {id} was already closed",
} satisfies Record<string, string>;
