export interface ConfirmationOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmationRequest extends ConfirmationOptions {
  readonly id: number;
  readonly message: string;
}

interface PendingConfirmation {
  request: ConfirmationRequest;
  resolve: (answer: boolean) => void;
}

let sequence = 0;
let queue: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function confirmationSnapshot(): ConfirmationRequest | null {
  return queue[0]?.request ?? null;
}

export function subscribeConfirmations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Matches the native dialog call shape while keeping the choice inside Yard. */
export function ask(message: string, options: ConfirmationOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const wasEmpty = queue.length === 0;
    queue.push({ request: { id: ++sequence, message, ...options }, resolve });
    if (wasEmpty) emit();
  });
}

export function settleConfirmation(answer: boolean): void {
  const current = queue.shift();
  if (!current) return;
  current.resolve(answer);
  emit();
}

export function resetConfirmationsForTests(): void {
  const pending = queue;
  queue = [];
  for (const item of pending) item.resolve(false);
  emit();
}
