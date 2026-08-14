# O motor de PTY no Windows — o coração do app

> Especificação do comportamento implementado em `src-tauri/src/pty/` (e
> vizinhos `process_tree.rs`, `resources.rs`). Os critérios de aceite estão
> cobertos por `pty::engine_tests`, que sobem PowerShell de verdade.

## 1. Spawn (ConPTY)

`portable-pty` usa **ConPTY** no Windows 10 1809+ (nosso piso). Fluxo:
`native_pty_system().openpty(PtySize)` → `CommandBuilder` com
programa/args/cwd/env → `slave.spawn_command(cmd)` → **`drop(slave)`
imediatamente** (sem isso o EOF nunca chega no reader quando o processo morre)
→ `master.try_clone_reader()` para a thread de leitura e
`master.take_writer()` para input. Env mínimo: `TERM=xterm-256color` e herdar
o resto. Shell padrão: `pwsh.exe` se existir, senão `powershell.exe`
(resolvidos via `which`), com `cmd.exe` como opção.

Logo após o spawn, criar um **Job Object** (§5) e associar o PID raiz — é o
seguro de vida contra processos órfãos.

O ambiente herdado é higienizado: vetos de cor (`NO_COLOR`, `FORCE_COLOR`,
`CLICOLOR*`) exportados por quem lançou o app são removidos — cor é decisão
deste terminal, não do terminal que abriu o Yard — e marcadores de sessão de
agente (`CLAUDECODE`, `CLAUDE_CODE_*`) também, para que um agente aninhado se
comporte como sessão de primeira classe e continue gravando transcript.

## 2. Scrollback: anel de 4 MB + append-only em disco

Em memória, por PTY: `VecDeque<u8>` com teto de 4 MB (descarta do início ao
estourar) **mais** um `Vec<u8> pending` com o que ainda não foi pro disco. A
cada 250 ms (ou ao fechar), grava-se **apenas o `pending`** com append em
`scrollback/{id}.bin` — nunca o anel inteiro. Sem isso, um simples spinner de
agente (poucos bytes/s) forçaria a reescrita de 4 MB a cada flush (~16 MB/s de
I/O por terminal). Quando o `.bin` passa de 8 MB, reescreve-se atomicamente só
a cauda de 4 MB (`.bin.tmp` → rename). No `attach_pty`: se o PTY está vivo,
devolve o anel da memória; se está morto/suspenso, lê a cauda do `.bin`.
Aceitação: um spinner rodando a noite toda não pode gerar mais que ~KB/s de
I/O.

## 3. Leitura: UTF-8 e coalescing

A thread de leitura mantém um `carry: Vec<u8>`. A cada `read()`:
`carry.extend(chunk)`; calcula
`valid = from_utf8(&carry).map(|s| s.len()).unwrap_or_else(|e| e.valid_up_to())`;
emite só `carry[..valid]` e retém a cauda (0–3 bytes de um caractere partido
pelo limite do buffer — sem isso, a UI enche de `�`). Coalescing: acumula e
emite a cada ~8–16 ms **ou** ≥ 32 KB, o que vier primeiro — um evento IPC por
byte mata o WebView. Painel invisível (`set_pty_visible(false)` vindo da UI):
rebaixar para 1 emissão/450 ms mantendo o anel sempre atualizado, e continuar
emitindo `pty://activity/{id}` para o detector de "agente terminou". Payloads
são fatiados em 256 KB, com teto de 2 MB no buffer de emissão e aviso visível
quando a saída é rápida demais para exibir.

## 4. Gate de RAM no spawn

Antes de spawnar um agente: se `sysinfo` reporta < 400 MB de RAM disponível no
sistema, aguardar em polls de 1 s até 45 s; depois disso, prosseguir mesmo
assim (melhor um crash raro do que travar o usuário para sempre). O motivo: um
processo Node/agente que nasce sem RAM se mata sozinho na primeira alocação.
**Nunca** tentar "reservar" memória com base em `available_memory()` — no
Windows ela enxerga só RAM física livre, não o limite de commit
(RAM + paginação), e a manobra piora o problema. Só ler, nunca alocar de
propósito.

## 5. Kill de árvore: Job Objects (+ fallback)

Agentes spawnam árvores (pwsh → node → mcp servers → git…). `child.kill()`
mata só a raiz. Solução canônica no Windows:

```text
CreateJobObjectW(NULL, NULL)
  → SetInformationJobObject(job, JobObjectExtendedLimitInformation,
        { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE })
  → AssignProcessToJobObject(job, hProcessRaiz)   // logo após o spawn
kill_pty  ⇒ TerminateJobObject(job, 1)            // árvore inteira, atômico
crash do Yard ⇒ handle do job fecha ⇒ SO mata a árvore sozinho (KILL_ON_JOB_CLOSE)
```

Via crate `windows-sys` (features `Win32_System_JobObjects`,
`Win32_Foundation`, `Win32_System_Threading`; o `HANDLE` do processo vem de
`OpenProcess(PROCESS_ALL_ACCESS, …, pid)`). Fallback defensivo se o assign
falhar (raro, ex.: processo já em outro job sem permissão de nesting): subir a
árvore via `process_tree.rs` e matar folhas→raiz; último recurso,
`taskkill /PID <pid> /T /F`. Na árvore do `sysinfo`, **filtrar entradas com
`thread_kind().is_some()`** (threads aparecem como "PIDs" no mapa — sem
filtrar, o kill de árvore infla e fica lento) e cachear o mapa pai→filhos por
2 s.

## 6. Suspender e retomar

`suspend_pty` = flush do scrollback → kill da árvore → marcar `alive=0`
preservando `program/args/cwd/resume_json`. "Retomar" re-spawna: shell comum
volta como shell novo com o histórico visível acima; agente volta com o
comando de resume dele (`claude --resume <sessionId>`, `codex resume`,
`opencode` com sessão) — os IDs vêm dos parsers de `agents/sessions.rs`.
"Suspender grupo" aplica isso a todos os terminais do grupo de uma vez — é a
válvula de escape de RAM do app.

## 7. Detector de "agente terminou"

Sem API dos agentes, a heurística que funciona: se um PTY marcado como
`kind='agent'` ficou ≥ 4,5 s sem emitir bytes **depois** de um período de
atividade, dispare notificação nativa ("Claude terminou em api-server") +
badge no painel. O evento `pty://activity/{id}` de 450 ms existe exatamente
para isso funcionar com o painel em background.

## Apêndice: o `ESC[6n` do ConPTY

Descoberta ao escrever os testes do motor, e vale saber: no handshake o
conhost emite `ESC[6n` (DSR-CPR) e **segura toda a saída do aplicativo até
receber a resposta**. Quem responde é o emulador do outro lado — o xterm.js
faz isso sozinho, e é por isso que o app funciona. Um leitor headless trava: o
processo fica vivo, mudo e parado, sem erro. Os testes incluem um terminal
mínimo que responde `ESC[1;1R`. Se algum dia o horizonte F7 do
[roadmap](./05-roadmap.md) trouxer um emulador em Rust, ele precisa fazer o
mesmo.
