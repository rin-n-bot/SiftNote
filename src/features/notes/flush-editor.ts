export async function flushEditorChanges(
  autosave: { flush: () => Promise<void> },
  snapshot: (() => Promise<void>) | undefined,
  hasUnsyncedChanges: boolean,
): Promise<void> {
  // Commit received text before awaiting a WebView that Android may suspend.
  await autosave.flush();
  if (snapshot) await snapshot();
  else if (hasUnsyncedChanges)
    throw new Error(
      "The editor has unsaved changes. Restart it here before leaving.",
    );
  // The acknowledged snapshot may have scheduled a newer document.
  await autosave.flush();
}

// TEMPORARY Back-only guard. Backgrounding and explicit save actions retain
// their full snapshot guarantee. The deadline bounds navigation, not SQLite:
// any write already started continues after the screen has popped.
export async function flushBeforeBack(
  autosave: { flush: () => Promise<void> },
  snapshot: (() => Promise<void>) | undefined,
  onError: (error: Error) => void,
  onTimeout: () => void,
): Promise<void> {
  const report = (cause: unknown) =>
    onError(
      cause instanceof Error
        ? cause
        : new Error("The note could not be saved."),
    );
  // Request the browser immediately while committing the last RN snapshot.
  // Handle rejection now, even when a SQLite write takes longer to complete.
  const captured = snapshot
    ? Promise.resolve()
        .then(snapshot)
        .then(
          () => undefined,
          (error: unknown) => error,
        )
    : Promise.resolve(undefined);
  let expired = false;
  const save = (async () => {
    await autosave.flush();
    const error = await captured;
    // A pop cancels outstanding browser requests. That expected cancellation
    // must not report a second failure after the deadline's fallback.
    if (expired) return;
    if (error !== undefined) report(error);
    await autosave.flush();
  })().catch(report);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    save.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), 300);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    expired = true;
    onTimeout();
    // Flush the latest RN document before allowing the owner to unmount.
    // Autosave serializes this with any write already in flight.
    void autosave.flush().catch(report);
  }
}
