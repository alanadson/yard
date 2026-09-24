// Prerequisite dialogs return to the original creation context instead of discarding it.
import { expect, it } from "vitest";
import { useUI } from "./uiStore";

it("restores the new tab draft after configuring agents or adding a prerequisite", () => {
  const state = useUI.getState();
  const draft = {
    groupId: "board",
    slot: 2,
    boardFolder: "C:/work",
    destination: "front",
    activeChoice: "agent:codex",
  };
  state.openModal("new-terminal");
  state.openChildModal("preferences", "agentes", draft);
  expect(useUI.getState().modal).toBe("preferences");
  state.closeModal();
  expect(useUI.getState().modal).toBe("new-terminal");
  expect(useUI.getState().modalPayload).toEqual(draft);
  state.closeModal();
  expect(useUI.getState().modal).toBeNull();
});
