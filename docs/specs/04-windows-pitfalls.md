# Armadilhas específicas do Windows (checklist de sobrevivência)

1. **ConPTY tem manias.** Repaint agressivo no resize (o agente "pisca"),
   sequências de posicionamento extras no primeiro frame. Debounce do resize
   no front (~1 frame) e não tente "limpar" a saída — repasse os bytes crus ao
   xterm.
2. **`pwsh` ≠ `powershell` ≠ `cmd`.** PowerShell 7 (`pwsh.exe`) nem sempre
   está instalado; resolver com `which` e cair para
   `windows\System32\WindowsPowerShell\v1.0\powershell.exe`. Oferecer os três
   no modal de novo terminal.
3. **CLIs de npm são shims `.cmd`.** `claude`, `codex` etc. instalados via npm
   viram `claude.cmd` em `%APPDATA%\npm`. `CreateProcess` não executa `.cmd`
   direto: ou resolva o alvo real, ou spawne `cmd.exe /c claude.cmd <args>`
   dentro do PTY. O resolver de CLIs (`agents/resolver.rs`) existe por causa
   disso — os shims têm mais casos do que parece (`.cmd`, `.ps1`, registro,
   instalações fora do PATH); reserve tempo.
4. **UTF-8 no console.** Defina `TERM=xterm-256color` e considere lançar
   shells com codepage 65001 (`chcp 65001` no profile ou
   `cmd /c chcp 65001 >nul && ...`) para acentuação correta em ferramentas
   antigas.
5. **Caminhos longos e UNC.** Habilite `longPathAware` no manifesto se for
   mexer com `node_modules` profundos; cuidado com `\\?\` em caminhos vindos
   do git.
6. **Processos órfãos são a reclamação nº 1** de apps de terminal no Windows.
   Job Objects com `KILL_ON_JOB_CLOSE`
   ([motor de PTY §5](./03-pty-engine.md#5-kill-de-árvore-job-objects--fallback))
   desde a F1 — não deixe para depois.
7. **SmartScreen/Defender.** Binário não assinado = tela azul de aviso e
   possível quarentena de heurística (app que spawna muitos processos filhos é
   suspeito). Assinatura EV/OV resolve; projetos open source conseguem
   certificado gratuito via SignPath Foundation. Enquanto isso, documente o
   "Executar assim mesmo".
8. **WebView2 ausente** em Windows 10 corporativo congelado → o
   `downloadBootstrapper` do bundle resolve.
9. **HiDPI e zoom.** Teste em 125%/150%: o `FitAddon` arredonda células e
   sobra borda — aceite a borda de 1–3 px, não brigue com subpixel.
10. **Antivírus + SQLite.** Escreva o `.db` com WAL habilitado
    (`PRAGMA journal_mode=WAL`) para reduzir locks com scanners de arquivo.
11. **Uma instância só.** `single-instance` desde a F0 — duas instâncias
    gravando `app.db` e `.bin` é corrupção garantida. (Exceção deliberada:
    `YARD_DATA_DIR` desliga a trava para builds de desenvolvimento com
    diretório de dados próprio.)
