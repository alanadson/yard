/**
 * Carrying the `yard` bridge across an SSH connection.
 *
 * "Roda em: SSH" has shipped since 2026-08-26 with a hole written into the
 * docs: *"o `yard` e o ambiente `YARD_*` não atravessam a conexão"*. An agent
 * on another machine could not ask another agent anything, read a note, drive
 * a portal or say it had finished — which is to say it was a terminal, not a
 * participant.
 *
 * What closes it, in three pieces:
 *
 * 1. the app's bridge also listens on a **loopback TCP port**
 *    (`src-tauri/src/bridge.rs`), speaking the same one-line JSON protocol as
 *    the named pipe and demanding a session token;
 * 2. `ssh -R` carries that port to the **remote host's own loopback**;
 * 3. a small **Python shim** is written on the remote host and put on `PATH`,
 *    so `yard …` over there means exactly what it means here.
 *
 * Python rather than shell because the request is JSON containing arbitrary
 * prompt text: escaping that by hand in `sh` is how you get a bridge that
 * works until someone's prompt has a quote in it. `python3` is the one
 * interpreter that is on essentially every machine a coding agent runs on,
 * and when it is missing the shim says so in one line instead of failing
 * strangely.
 *
 * The security shape, stated plainly because it is the reason this is
 * opt-in per agent: the tunnel makes the workspace reachable from the remote
 * host's loopback, which is shared with every process and user on that
 * machine. The token is what stands there, and it lives in the remote
 * process's environment — readable by that user and by root. Turn it on for
 * hosts you would already trust with your source tree.
 */

/** Where the shim lives on the other machine. */
export const REMOTE_DIR = "$HOME/.yard/bin";

/** Heredoc delimiter. Must not appear inside the shim body. */
const EOF = "YARD_SHIM_EOF";

/** POSIX single-quoting: the only form that needs no other escaping. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The port the tunnel lands on over there.
 *
 * Derived from the local port so the `-R` flag and the shim's `YARD_PORT`
 * cannot disagree — they are computed from the same number, in two places,
 * and a mismatch would be a bridge that silently refuses every call. High and
 * unprivileged; a collision on a shared host makes `ssh` warn that the
 * forward failed and leaves the agent exactly where it was before, without
 * the bridge.
 */
export function remotePortFor(localPort: number): number {
  return 40000 + (localPort % 20000);
}

export interface RemoteBridge {
  /** Loopback port the app's bridge is listening on, here. */
  port: number;
  token: string;
  /** The terminal this CLI is, as the workspace knows it. */
  ptyId: string;
}

/** The `-R` argument for `ssh`, or `null` when the bridge is not going. */
export function reverseTunnelArg(bridge: RemoteBridge | null): string | null {
  if (!bridge?.port) return null;
  return `${remotePortFor(bridge.port)}:127.0.0.1:${bridge.port}`;
}

/**
 * The whole remote command: install the shim (when the bridge is going), then
 * `cd` and `exec` the CLI.
 */
export function remoteCommand(input: {
  /** The CLI and its arguments, already quoted for the remote shell. */
  run: string;
  /** Remote folder, or empty. */
  dir: string;
  bridge: RemoteBridge | null;
}): string {
  const lines: string[] = [];
  let prefix = "";

  if (input.bridge) {
    const port = remotePortFor(input.bridge.port);
    lines.push(
      `mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_DIR}/yard <<'${EOF}'`,
      SHIM,
      EOF,
      `chmod +x ${REMOTE_DIR}/yard`,
    );
    prefix =
      `PATH=${REMOTE_DIR}:$PATH ` +
      `YARD_PTY_ID=${shQuote(input.bridge.ptyId)} ` +
      `YARD_TOKEN=${shQuote(input.bridge.token)} ` +
      `YARD_PORT=${port} `;
  }

  const dir = input.dir.trim();
  const run = `${prefix}exec ${input.run}`;
  lines.push(dir ? `cd ${shQuote(dir)} && ${run}` : run);
  return lines.join("\n");
}

/**
 * The shim itself. Same contract as `yard.ps1` on this machine: one JSON line
 * out, one JSON line back, `--file` rewritten to `--stdin` with the text in
 * its own field, and the longer default timeout for the three commands that
 * wait on another agent.
 */
// i18n-ok — the shim below is a CLI's own output, on another machine
const SHIM = `#!/usr/bin/env python3
# yard - Yard app bridge, remote half. Written by the app; do not edit.
import json, os, socket, sys

port = os.environ.get("YARD_PORT")
token = os.environ.get("YARD_TOKEN")
if not port or not token:
    sys.stderr.write("yard: fora de um terminal do Yard (YARD_PORT ausente)\\n")
    sys.exit(2)

argv_in = sys.argv[1:]
argv = []
stdin_text = None
timeout_ms = 180000
i = 0
while i < len(argv_in):
    a = argv_in[i]
    if a == "--file" and i + 1 < len(argv_in):
        path = argv_in[i + 1]
        try:
            with open(path, "r", encoding="utf-8") as fh:
                stdin_text = fh.read()
        except OSError as e:
            sys.stderr.write("yard: nao consegui ler %s: %s\\n" % (path, e))
            sys.exit(2)
        argv.append("--stdin")
        i += 2
        continue
    if a == "--stdin":
        if stdin_text is None:
            stdin_text = sys.stdin.read()
        argv.append("--stdin")
        i += 1
        continue
    if a == "--timeout" and i + 1 < len(argv_in):
        try:
            timeout_ms = int(float(argv_in[i + 1]) * 1000)
        except ValueError:
            pass
    argv.append(a)
    i += 1

if argv and argv[0] in ("ask", "recruit", "wait") and timeout_ms < 600000:
    timeout_ms = 600000

req = {
    "v": 1,
    "terminal": os.environ.get("YARD_PTY_ID", ""),
    "cwd": os.getcwd(),
    "argv": argv,
    "stdin": stdin_text,
    "timeoutMs": timeout_ms,
    "token": token,
}

try:
    conn = socket.create_connection(("127.0.0.1", int(port)), 8)
except OSError as e:
    sys.stderr.write("yard: nao consegui falar com o app Yard (%s); o tunel esta de pe?\\n" % e)
    sys.exit(2)

# The app answers only when the work is done: an \`ask\` waits for the other
# agent to finish, so the socket timeout has to follow the request's.
conn.settimeout(timeout_ms / 1000.0 + 15)
try:
    conn.sendall((json.dumps(req) + "\\n").encode("utf-8"))
    buf = b""
    while not buf.endswith(b"\\n"):
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
finally:
    conn.close()

line = buf.decode("utf-8", "replace").strip()
if not line:
    sys.stderr.write("yard: resposta vazia do app\\n")
    sys.exit(1)
res = json.loads(line)
out = res.get("output") or ""
sys.stdout.write(out)
sys.exit(int(res.get("code") or 0))
`;

/**
 * The local half, read once at boot (`App.boot`) and kept here so the launch
 * — which is synchronous, and happens in four different places — can reach it
 * without an await.
 */
let local: { port: number; token: string } | null = null;

export function setLocalBridge(next: { port: number | null; token: string }): void {
  local = next.port ? { port: next.port, token: next.token } : null;
}

export function localBridge(): { port: number; token: string } | null {
  return local;
}

/**
 * The placeholder the backend fills in at spawn (`pty::expand_pty_id`).
 *
 * The command line is built before the terminal row exists, so the id it has
 * to announce cannot be known here. Spelled identically on both sides.
 */
export const PTY_ID_MARK = "{{YARD_PTY_ID}}";
