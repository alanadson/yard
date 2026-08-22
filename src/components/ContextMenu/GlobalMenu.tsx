/**
 * The menu of last resort — what shows up when nobody else wanted the click.
 *
 * Yard swallows WebView2's native menu (the terminal depends on it: the host's
 * "Paste" used to write straight into the PTY). Without a net underneath,
 * every place with no menu of its own went mute on right-click — the title
 * bar, the dialogs, the text fields, the empty space of any panel.
 *
 * The listener is on `window`, **in the bubble phase**: any surface with a
 * menu of its own has already called `preventDefault` before the event gets
 * here, and then this one does nothing. That is why it lives at the end of
 * `App` and needs to know about none of the others.
 *
 * What each entry does lives in `lib/textMenu`; which of them fits each
 * target, in `lib/systemMenu`.
 */
import { useEffect, useState } from "react";

import { ContextMenu, type MenuAnchor } from "./index";
import { captureTextTarget, textMenuEntries, type TextTarget } from "../../lib/textMenu";

export function GlobalMenu() {
  const [click, setClick] = useState<{ anchor: MenuAnchor; alvo: TextTarget } | null>(
    null,
  );

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      // Someone already answered this click — that surface's menu is the right
      // one, and two menus on screen is no answer at all.
      if (e.defaultPrevented) return;
      e.preventDefault();
      setClick({
        anchor: { x: e.clientX, y: e.clientY },
        alvo: captureTextTarget(e),
      });
    };
    window.addEventListener("contextmenu", onCtx);
    return () => window.removeEventListener("contextmenu", onCtx);
  }, []);

  if (!click) return null;
  return (
    <ContextMenu
      anchor={click.anchor}
      items={textMenuEntries(click.alvo)}
      onClose={() => setClick(null)}
    />
  );
}
