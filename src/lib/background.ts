interface BackgroundHandlers<T> {
  success?: (value: T) => void;
  error?: (error: unknown) => void;
}

export function bridgeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("window is not defined") ||
    message.includes("__TAURI_INTERNALS__") ||
    message.includes("not running in a Tauri")
  );
}

/**
 * Starts non-blocking persistence without leaking rejected Tauri invokes in
 * unit tests. Only the missing bridge is ignored; real application failures
 * still reach the caller's error state/logger.
 */
export function runBackground<T>(
  operation: () => Promise<T>,
  handlers: BackgroundHandlers<T> = {},
): void {
  try {
    void operation().then(handlers.success, (error) => {
      if (!bridgeUnavailable(error)) handlers.error?.(error);
    });
  } catch (error) {
    if (!bridgeUnavailable(error)) handlers.error?.(error);
  }
}
