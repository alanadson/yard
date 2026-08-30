/**
 * Why these rules matter: this builds a command line that is sent to another
 * machine and executed by a shell there. Two failure modes, both silent: a
 * quoting mistake (a folder with a space, a token with an odd character)
 * running the wrong thing over there, and a bridge that is *offered* to a
 * remote agent without a tunnel behind it — a `yard` that hangs for four
 * seconds and then says the app is not open, on every call.
 */
import { describe, expect, it } from "vitest";

import { REMOTE_DIR, remoteCommand, remotePortFor } from "./remoteBridge";

const base = {
  run: "claude --resume abc",
  dir: "/home/alguem/projeto",
  bridge: { port: 51515, token: "abc123", ptyId: "t-1" },
};

describe("remotePortFor", () => {
  it("is stable for the same local port — the tunnel and the shim must agree", () => {
    expect(remotePortFor(51515)).toBe(remotePortFor(51515));
  });

  it("stays inside the unprivileged range", () => {
    for (const port of [1, 1024, 51515, 65535]) {
      const remote = remotePortFor(port);
      expect(remote).toBeGreaterThan(1024);
      expect(remote).toBeLessThan(65536);
    }
  });

  it("gives different local ports different doors, so two Yards do not collide", () => {
    expect(remotePortFor(51515)).not.toBe(remotePortFor(51516));
  });
});

describe("remoteCommand", () => {
  it("runs the CLI in the folder that was asked for", () => {
    const cmd = remoteCommand({ ...base, bridge: null });
    expect(cmd).toContain("cd '/home/alguem/projeto'");
    expect(cmd).toContain("exec claude --resume abc");
  });

  it("quotes a folder with a space instead of splitting it in two", () => {
    const cmd = remoteCommand({ ...base, dir: "/home/alguem/meu projeto", bridge: null });
    expect(cmd).toContain("'/home/alguem/meu projeto'");
  });

  it("survives a folder with a quote in it", () => {
    const cmd = remoteCommand({ ...base, dir: "/home/o'brien/x", bridge: null });
    // The classic POSIX escape: close, escaped quote, reopen.
    expect(cmd).toContain(String.raw`'/home/o'\''brien/x'`);
  });

  it("with no bridge, installs nothing at all on the other machine", () => {
    const cmd = remoteCommand({ ...base, bridge: null });
    expect(cmd).not.toContain(REMOTE_DIR);
    expect(cmd).not.toContain("YARD_TOKEN");
  });

  it("with a bridge, writes the shim, puts it on PATH and exports the three variables", () => {
    const cmd = remoteCommand(base);
    expect(cmd).toContain(REMOTE_DIR);
    expect(cmd).toContain("chmod +x");
    expect(cmd).toContain("YARD_PTY_ID='t-1'");
    expect(cmd).toContain("YARD_TOKEN='abc123'");
    expect(cmd).toContain(`YARD_PORT=${remotePortFor(51515)}`);
    expect(cmd).toContain("PATH=");
  });

  /** The heredoc body is a Python program; a stray delimiter would truncate it. */
  it("uses a delimiter the shim body cannot contain", () => {
    const cmd = remoteCommand(base);
    const marker = "YARD_SHIM_EOF";
    expect(cmd.split(marker)).toHaveLength(3);
  });

  it("quotes the heredoc delimiter, so the remote shell expands nothing inside", () => {
    expect(remoteCommand(base)).toContain("<<'YARD_SHIM_EOF'");
  });
});
