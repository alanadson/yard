import { ipc } from "./ipc";
import { t } from "./i18n";

/** Runs a floor hook list in sequence and stops at the first failure. */
export async function runFloorHooks(
  cwd: string,
  commands: string[],
  env: [string, string][],
): Promise<{ ok: boolean; detail: string }> {
  for (const command of commands) {
    try {
      const result = await ipc.floorRunHook(cwd, command, env);
      if (result.code !== 0) {
        return {
          ok: false,
          detail: t("`{command}` saiu com código {code}: {output}", {
            command,
            code: String(result.code),
            output: result.output.slice(0, 200),
          }),
        };
      }
    } catch (error) {
      return { ok: false, detail: `\`${command}\`: ${error}` };
    }
  }
  return { ok: true, detail: "" };
}
