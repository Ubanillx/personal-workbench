export type NotificationSync = {
  sync: () => Promise<void>;
  invalidate: () => void;
  dispose: () => void;
};

/** A newer SSE event or sync request makes an in-flight snapshot obsolete. */
export function createNotificationSync<T>(load: () => Promise<T[] | null>, apply: (items: T[]) => void): NotificationSync {
  let revision = 0;
  let disposed = false;
  let pending: Promise<void> | null = null;

  const invalidate = (): void => {
    revision += 1;
  };
  const sync = (): Promise<void> => {
    invalidate();
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      while (!disposed) {
        const requestedRevision = revision;
        const items = await load();
        if (disposed) return;
        if (requestedRevision !== revision) continue;
        if (items !== null) apply(items);
        return;
      }
    })()
      .catch(() => {
        // Keep the current list on network failure; a later sync can retry.
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    sync,
    invalidate,
    dispose: () => {
      disposed = true;
      invalidate();
    },
  };
}
