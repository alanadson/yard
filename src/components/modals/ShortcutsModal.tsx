/**
 * Shortcut map.
 *
 * It exists because the whole app is keyboard-driven: without a list, the
 * shortcuts only live in button `title`s — and the ones that matter
 * (switch tab, switch group) have no button at all.
 */
import { Modal } from "./Modal";
import { useUI } from "../../stores/uiStore";

type Atalho = [teclas: string[], descricao: string];

const GRUPOS: { titulo: string; itens: Atalho[] }[] = [
  {
    titulo: "Janela",
    itens: [
      [["Ctrl", "T"], "Novo terminal"],
      [["Ctrl", "Enter"], "Compositor de prompts do terminal em foco"],
      [["Ctrl", "B"], "Mostrar ou esconder a barra lateral"],
      [["Ctrl", "Shift", "D"], "Painel de arquivos e alterações"],
      [["Ctrl", "Shift", "P"], "Preferências"],
      [["Ctrl", "Shift", "H"], "Esta lista"],
    ],
  },
  {
    titulo: "Navegação",
    itens: [
      [["Ctrl", "Tab"], "Próxima aba do painel em foco"],
      [["Ctrl", "Shift", "Tab"], "Aba anterior"],
      [["Ctrl", "1"], "Ir para a aba 1 (até Ctrl+9)"],
      [["Ctrl", "Shift", "G"], "Próximo grupo do projeto"],
    ],
  },
  {
    titulo: "No terminal",
    itens: [
      [["Ctrl", "Shift", "F"], "Buscar no histórico do painel"],
      [["Ctrl", "C"], "Copiar quando há seleção; interromper quando não há"],
      [["Ctrl", "Shift", "C"], "Copiar a seleção"],
      [["Ctrl", "V"], "Colar"],
    ],
  },
  {
    titulo: "No canvas (modo Canvas do grupo)",
    itens: [
      [["V"], "Selecionar · H mão · P caneta · E borracha"],
      [["R"], "Retângulo · O elipse · L linha · A seta"],
      [["T"], "Texto · N nota · W portal · C conectar"],
      [["Ctrl", "roda"], "Zoom no cursor (roda sozinha desloca a tela)"],
      [["Ctrl", "0"], "Zoom 100% (Ctrl+= aproxima, Ctrl+− afasta)"],
      [["Shift", "1"], "Enquadrar tudo"],
      [["Espaço", "arrastar"], "Mover a tela com qualquer ferramenta"],
      [["setas"], "Mover o item selecionado (Shift anda 10×)"],
      [["Ctrl", "D"], "Duplicar o item selecionado"],
      [["Delete"], "Apagar o item selecionado"],
      [["Ctrl", "Z"], "Desfazer (Ctrl+Y refaz)"],
      [["2× clique"], "No cabeçalho de um cartão: centralizar em 100%"],
      [["arrastar"], "No corpo de uma nota: mover; clique parado: editar"],
    ],
  },
];

export function ShortcutsModal() {
  const closeModal = useUI((s) => s.closeModal);

  return (
    <Modal title="Atalhos de teclado" onClose={closeModal}>
      {GRUPOS.map((g) => (
        <section className="shortcut-group" key={g.titulo}>
          <h4>{g.titulo}</h4>
          {g.itens.map(([teclas, descricao]) => (
            <div className="shortcut-row" key={descricao}>
              <span>{descricao}</span>
              <span className="shortcut-keys">
                {teclas.map((t, i) => (
                  <span key={t}>
                    {i > 0 && "+"} <kbd>{t}</kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      <p className="hint">
        Fora essas, tudo que você digita vai direto para a CLI — o Yard não
        intercepta teclas que o terminal precisa.
      </p>
    </Modal>
  );
}
