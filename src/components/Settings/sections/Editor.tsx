/**
 * Code editor — the text metrics, how it is drawn, and what it draws with.
 *
 * The sample has two lines on purpose: the first exposes the letterforms and
 * the pairs that get confused (`0O`, `1lI`) along with the sequences that
 * become ligatures; the second is real code. There are two because line
 * height only exists **between** lines — with a single one, changing it
 * changed nothing.
 *
 * The last four groups are what the store shelf used to hold. They are here,
 * and not on a shelf of their own, because that is where someone goes to
 * answer "what is my editor doing?" — the colour theme, the icons, the
 * minimap and Prettier are the same question asked four times.
 */
import { fontOptions } from "../../../lib/fontPicker";
import { useT } from "../../../hooks/useT";
import { iconThemeOptions, iconThemePick, iconThemeValue } from "../../../lib/iconTheme";
import {
  schemeOptions,
  schemePick,
  schemeValue,
  setSurface,
} from "../../../lib/schemeChoice";
import { useExtensions } from "../../../stores/extensionsStore";
import { useEditor } from "../../../stores/editorStore";
import { useUI } from "../../../stores/uiStore";
import {
  Card,
  FeatureRow,
  GroupTitle,
  NumberRow,
  PickerRow,
  SwitchRow,
  TextRow,
  ToggleRow,
} from "../rows";
import { type Fonts } from "../useFonts";
import { LspServerRows } from "./LspServers";

const SAMPLE = [
  "AaBb 0O 1lI  =>  ->  !=  ===  >=  ::  //",
  "const soma = (a: number, b: number) => a + b;",
];

export function SecEditor({ fontes: fonts }: { fontes: Fonts }) {
  const t = useT();
  const scheme = useExtensions((x) => x.scheme);
  const setScheme = useExtensions((x) => x.setScheme);
  // The whole map, not one id: the icon picker asks it which theme is on, and
  // the store keeps it as one object — a selector that built a new one here
  // would re-render on every unrelated switch.
  const enabled = useExtensions((x) => x.enabled);
  const setEnabled = useExtensions((x) => x.setEnabled);
  const codeFontFamily = useUI((s) => s.prefs.codeFontFamily);
  const codeLigatures = useUI((s) => s.prefs.codeLigatures);
  const codeFontSize = useUI((s) => s.prefs.codeFontSize);
  const codeLineHeight = useUI((s) => s.prefs.codeLineHeight);
  const setPref = useUI((s) => s.setPref);
  /**
   * Line wrapping is the same button as the editor's bar — it lives in
   * `editorStore`, next to the markdown mode and the heading ruler, and is
   * written to `kv` by it. Here it is just the second door to the same setting.
   */
  const wrap = useEditor((s) => s.wrap);

  return (
    <>
      <Card>
        <PickerRow
          label={t("Fonte do código")}
          value={codeFontFamily}
          disabled={fonts.carregando}
          placeholder={fonts.carregando ? t("Procurando fontes…") : undefined}
          options={fontOptions(fonts.lista, true, codeFontFamily, t("Padrão do Yard"))}
          onChange={(v) => setPref("codeFontFamily", v)}
        />
        <NumberRow
          pref="codeFontSize"
          label={t("Tamanho da fonte")}
          min={9}
          max={32}
          step={0.5}
        />
        <NumberRow
          pref="codeLineHeight"
          label={t("Altura da linha")}
          min={1}
          max={2.4}
          step={0.05}
        />
        <NumberRow pref="codeTabSize" label={t("Largura da tabulação")} min={1} max={8} step={1} />
      </Card>

      <GroupTitle>{t("Como o código é desenhado")}</GroupTitle>
      <Card>
        {/* The editor's half of a colour scheme. Setting it apart from the
            terminal's is all it takes to split them: "what is the editor on
            right now?" is answered on the editor's own page. */}
        <PickerRow
          label={t("Tema de cor")}
          value={schemeValue(scheme.code)}
          options={schemeOptions(t("Padrão do Yard"))}
          onChange={(v) => setScheme(setSurface(scheme, "code", schemePick(v)))}
        />
        {fonts.hasLigatures(codeFontFamily) && (
          <SwitchRow
            pref="codeLigatures"
            label={t("Ligaduras no código")}
            desc={t("A opção vale quando a fonte escolhida as tem")}
          />
        )}
        <SwitchRow
          pref="codeHardTabs"
          label={t("Indentar com tabulação em vez de espaços")}
          desc={t("O Tab escreve um caractere de tabulação de verdade")}
        />
        <SwitchRow
          pref="codeLineNumbers"
          label={t("Números de linha")}
          desc={t("Calha de números no editor de arquivos")}
        />
        <TextRow
          pref="codeRulers"
          label={t("Guias de coluna")}
          desc={t("Linhas verticais nas colunas escolhidas, separadas por vírgula. Vazio, nenhuma")}
          placeholder="80, 120"
        />
        <ToggleRow
          label={t("Quebrar linhas longas")}
          desc={t("Linhas mais largas que o painel continuam na linha de baixo")}
          checked={wrap}
          onChange={(v) => useEditor.getState().setWrap(v)}
        />
      </Card>
      <div
        className="set-sample"
        style={{
          // `--mono` already follows the picker live (applyFontPrefs), so the
          // sample only has to obey the switch on its own.
          // Size and line height, by contrast, live inside the CodeMirror
          // theme — here they come straight from the preference.
          fontVariantLigatures: codeLigatures ? "normal" : "none",
          fontSize: `${codeFontSize}px`,
          lineHeight: codeLineHeight,
        }}
      >
        {SAMPLE.map((row) => (
          <div key={row}>{row}</div>
        ))}
      </div>
      <p className="hint">
        {t(
          "A fonte vale para o editor de arquivos, diffs e trechos de código; tamanho, altura da linha, tabulação e numeração valem para o editor de arquivos, e a amostra acima mostra o resultado. A largura da tabulação é quantas colunas um recuo ocupa — e, com a indentação por tabulação desligada, quantos espaços o Tab escreve. Ligaduras juntam símbolos num desenho só (=> vira uma seta, != vira ≠) sem mudar os caracteres do arquivo.",
        )}
      </p>
      <p className="hint">
        {t(
          "O tema de cor pinta a sintaxe do editor, dos diffs e dos trechos de código; os terminais têm o deles, em Ajustes → Terminal. Escolher o mesmo nos dois deixa a tela inteira na mesma paleta.",
        )}
      </p>

      <GroupTitle>{t("Ícones de arquivo")}</GroupTitle>
      <Card>
        {/* Two themes, one slot: both draw over the same tree. The picker is
            the shape that says so — the rule and the clearing live in
            `lib/iconTheme.ts`, with a test. */}
        <PickerRow
          label={t("Tema de ícones")}
          value={iconThemeValue(enabled)}
          options={iconThemeOptions(t("Nenhum"))}
          onChange={(v) => {
            const step = iconThemePick(enabled, v);
            if (step) setEnabled(step.id, step.on);
          }}
        />
      </Card>
      <p className="hint">
        {t(
          "Os ícones valem para a árvore de arquivos, a Busca e as abas. Em Nenhum, o Yard usa o glifo neutro de sempre e só o estado do git colore a árvore. Os dois temas vêm embutidos: o mapa de ícones só é carregado quando um deles é escolhido.",
        )}
      </p>

      <GroupTitle>{t("Recursos do editor")}</GroupTitle>
      <Card>
        <FeatureRow
          id="minimap"
          label={t("Minimapa")}
          desc={t("O arquivo inteiro em miniatura na borda direita, com a janela visível marcada")}
        />
        <FeatureRow
          id="indent-guides"
          label={t("Guias de indentação")}
          desc={t("Linhas verticais marcando cada nível de recuo, com o bloco ativo destacado")}
        />
        <FeatureRow
          id="rainbow-brackets"
          label={t("Parênteses arco-íris")}
          desc={t("Cada nível de ( ) [ ] { } numa cor; colchete dentro de texto ou comentário não conta")}
        />
        <FeatureRow
          id="todo-highlight"
          label={t("Realce de TODO")}
          desc={t("TODO, FIXME, HACK e NOTE viram etiquetas coloridas no meio do arquivo")}
        />
        <FeatureRow
          id="css-colors"
          label={t("Cores no CSS")}
          desc={t("Um quadradinho da cor real ao lado de cada #hex e rgb(), clicável para trocar")}
        />
        <FeatureRow
          id="format-on-save"
          label={t("Formatar ao salvar")}
          desc={t("Ctrl+S passa o arquivo pelo Prettier antes de gravar; com erro de sintaxe, salva como está")}
        />
      </Card>

      <GroupTitle>{t("Markdown")}</GroupTitle>
      <Card>
        <FeatureRow
          id="mermaid"
          label={t("Diagramas Mermaid")}
          desc={t("Blocos ```mermaid viram diagramas na leitura e no modo dividido")}
        />
        <FeatureRow
          id="katex"
          label={t("Fórmulas KaTeX")}
          desc={t("Blocos ```math viram fórmulas na leitura e no modo dividido")}
        />
      </Card>
      <p className="hint">
        {t(
          "Vale para os arquivos .md do editor e para as Anotações. Um bloco com erro de sintaxe continua aparecendo como código, nunca como uma tela quebrada.",
        )}
      </p>

      <GroupTitle>{t("Servidores de linguagem")}</GroupTitle>
      <Card>
        <SwitchRow
          pref="lspEnabled"
          label={t("Servidores de linguagem (LSP)")}
          desc={t(
            "Completar, erros, ir para a definição, referências, renomear e formatar no editor de arquivos — com o servidor de cada linguagem instalado nesta máquina",
          )}
        />
        <LspServerRows />
      </Card>
      <p className="hint">
        {t(
          "O editor liga ao servidor da linguagem do arquivo aberto (um por projeto) e o desliga quando o último arquivo daquele projeto fecha. Sem servidor, o editor completa palavras do próprio arquivo, como antes. F12 vai para a definição, Shift+F12 lista as referências, F2 renomeia o símbolo, Shift+Alt+F formata.",
        )}
      </p>
    </>
  );
}
