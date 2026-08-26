/**
 * Opens the welcome sheet once the two things it depends on have arrived:
 * the kv snapshot (`onboardingStore.load`, hydrated in `App.boot`) and the
 * workspace (`projectsStore.loaded`). Either may land first, so the hook
 * subscribes to both and lets `decide` — which answers `"show"` at most once
 * per session — do the arithmetic.
 */
import { useEffect } from "react";

import { useOnboarding as useOnboardingStore } from "../stores/onboardingStore";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

function consider() {
  const projects = useProjects.getState();
  if (!projects.loaded) return;
  if (useOnboardingStore.getState().decide(projects.projects.length) === "show") {
    useUI.getState().openModal("onboarding");
  }
}

export function useFirstRun() {
  useEffect(() => {
    consider();
    const offProjects = useProjects.subscribe((s, prev) => {
      if (s.loaded !== prev.loaded) consider();
    });
    const offKv = useOnboardingStore.subscribe((s, prev) => {
      if (s.loaded !== prev.loaded) consider();
    });
    return () => {
      offProjects();
      offKv();
    };
  }, []);
}
