// Account labels and terminal bindings must survive reload without exposing CLI credentials.
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { accountsSnapshot: api.snapshot } }));

import { useAccounts } from "./accountsStore";

beforeEach(() => api.snapshot.mockReset());

it("loads the saved default and the original account of an existing terminal", async () => {
  api.snapshot.mockResolvedValue({ accounts: [
    { id: "personal", provider: "codex", label: "Personal", status: "ready" },
    { id: "work", provider: "codex", label: "Work", status: "ready" },
  ], selected: { codex: "personal" }, bindings: [{ terminalId: "old", provider: "codex", accountId: "work" }] });
  await useAccounts.getState().load();
  expect(useAccounts.getState().selected.codex).toBe("personal");
  expect(useAccounts.getState().bindings.old.accountId).toBe("work");
  expect(useAccounts.getState().accounts.find((account) => account.id === "work")?.label).toBe("Work");
});

it("keeps the newer account selection when an older refresh finishes late", async () => {
  let completeOld!: (value: unknown) => void;
  api.snapshot.mockImplementationOnce(() => new Promise((resolve) => { completeOld = resolve; }));
  api.snapshot.mockResolvedValueOnce({ accounts: [], bindings: [], selected: { codex: "new" } });
  const older = useAccounts.getState().load();
  await useAccounts.getState().load();
  completeOld({ accounts: [], bindings: [], selected: { codex: "old" } });
  await older;
  expect(useAccounts.getState().selected.codex).toBe("new");
});
