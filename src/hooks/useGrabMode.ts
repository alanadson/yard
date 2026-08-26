/**
 * Modo Design — pointing at an element inside a portal instead of
 * describing it. Shared by the canvas portal card and the pane browser tab:
 * same engine, same gesture, same delivery.
 *
 * The picker lives inside the page and the app can only reach it through
 * one-shot `eval`s, so this is a poll: arm it, ask every 300 ms whether a
 * click happened, take the answer to the composer. Slow enough to be free,
 * fast enough that the click feels answered.
 */
import { useEffect, useState } from "react";

import { parseGrab } from "../lib/grab";
import { deliverGrab } from "../lib/grabDeliver";
import { t } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { GRAB_POLL_JS, GRAB_START_JS, GRAB_STOP_JS } from "../lib/portalDriver";

export function useGrabMode(
  portalId: string,
  showToast: (message: string, kind?: "info" | "error") => void,
): { grabbing: boolean; toggleGrab: () => void } {
  /** Modo Design: the next click in the page describes an element. */
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    if (!grabbing) return;
    let alive = true;
    let tries = 0;

    void ipc.portalEval(portalId, GRAB_START_JS).catch((e) => {
      if (!alive) return;
      setGrabbing(false);
      showToast(t("Não consegui armar o modo design: {reason}", { reason: String(e) }), "error");
    });

    const timer = setInterval(() => {
      // ~90 s of pointing is someone who walked away. Leaving the picker armed
      // would swallow the next real click on the page.
      if (++tries > 300) {
        setGrabbing(false);
        return;
      }
      void ipc
        .portalEval(portalId, GRAB_POLL_JS)
        .then((raw) => {
          if (!alive) return;
          const result = parseGrab(raw);
          if (result.kind === "pending") return;
          setGrabbing(false);
          if (result.kind === "cancelled") return;
          void deliverGrab(portalId, result.pick, showToast);
        })
        .catch(() => {
          // A navigation blows the injected picker away; re-arming would fight
          // the page. Dropping out is the honest answer.
          if (!alive) return;
          setGrabbing(false);
        });
    }, 300);

    return () => {
      alive = false;
      clearInterval(timer);
      void ipc.portalEval(portalId, GRAB_STOP_JS).catch(() => {});
    };
    // `portalId` and nothing of the caller's item: a canvas card's identity
    // changes on every navigation (the url is patched), and re-arming the
    // picker mid-gesture would drop the highlight the user is aiming with.
  }, [grabbing, portalId, showToast]);

  return { grabbing, toggleGrab: () => setGrabbing((v) => !v) };
}
