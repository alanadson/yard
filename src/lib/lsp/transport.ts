/**
 * The bridge between `@codemirror/lsp-client` and the Rust process manager.
 *
 * The client wants a `Transport` that carries bare JSON strings; the backend
 * frames them (`lsp.rs`) and streams the answers back on one event topic
 * shared by every server. The id chosen at `lsp_start` is what tells the
 * TypeScript server's answers from rust-analyzer's — a transport delivers
 * only its own.
 */
import type { Transport } from "@codemirror/lsp-client";

import { ipc, on, type UnlistenFn } from "../ipc";
import { t } from "../i18n";

type Handler = (message: string) => void;

export class IpcTransport implements Transport {
  private readonly handlers = new Set<Handler>();
  private readonly unlisten: Promise<UnlistenFn>;
  private disposed = false;

  constructor(readonly id: string) {
    this.unlisten = on.lspMessage((p) => {
      if (this.disposed || p.id !== this.id) return;
      for (const h of [...this.handlers]) h(p.message);
    });
  }

  /** Throws once disposed: the client must see a broken connection, not silence. */
  send(message: string): void {
    if (this.disposed) throw new Error(t("transporte {id} já foi encerrado", { id: this.id }));
    void ipc.lspSend(this.id, message).catch((e) => {
      console.warn(`[yard] lsp: falha ao enviar para ${this.id}`, e);
    });
  }

  subscribe(handler: Handler): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: Handler): void {
    this.handlers.delete(handler);
  }

  dispose(): void {
    this.disposed = true;
    this.handlers.clear();
    void this.unlisten.then((u) => u());
  }
}
