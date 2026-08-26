/**
 * Code editor — the text metrics and how it is drawn.
 *
 * The sample has two lines on purpose: the first exposes the letterforms and
 * the pairs that get confused (`0O`, `1lI`) along with the sequences that
 * become ligatures; the second is real code. There are two because line
 * height only exists **between** lines — with a single one, changing it
 * changed nothing.
 */
import { fontOptions } from "../../../lib/fontPicker";
import { useT } from "../../../hooks/useT";
import { useEditor } from "../../../stores/editorStore";
import { useUI } from "../../../stores/uiStore";
import { Card, GroupTitle, NumberRow, PickerRow, SwitchRow, ToggleRow } from "../rows";
import { type Fonts } from "../useFonts";
import { LspServerRows } from "./LspServers";

const SAMPLE = [
  "AaBb 0O 1lI  =>  ->  !=  ===  >=  ::  //",
  "const soma = (a: number, b: number) => a + b;",
];

export function SecEditor({ fontes: fonts }: { fontes: Fonts }) {
  const t = useT();
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
        <ToggleRow
          label={t("Quebrar linhas longas")}
          desc={t("Linhas mais largas que o painel continuam na linha de baixo")}
          checked={wrap}
          onChange={(v) => useEditor.getState().setWrap(v)}
        />
      </Card>

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
    </>
  );
}
