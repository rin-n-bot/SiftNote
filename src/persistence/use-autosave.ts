import { useCallback, useEffect, useMemo, useRef } from "react";
import { Autosave } from "./autosave";
import { perfMark } from "../dev/perf";

// The saver belongs to the committed editor session, never to a render.
export function useAutosave<T>(
  write: (value: T) => Promise<void>,
  status: (state: "saving" | "saved" | "error", error?: Error) => void,
) {
  const instance = useRef<Autosave<T> | null>(null);
  useEffect(() => {
    const saver = new Autosave(write, status);
    instance.current = saver;
    return () => {
      perfMark("autosave.cleanup.start");
      instance.current = null;
      // Autosave reports failures to the session, including after unmount.
      void saver
        .flush()
        .catch(() => {})
        .finally(() => perfMark("autosave.cleanup.flushEnd"));
      perfMark("autosave.cleanup.end");
    };
  }, [write, status]);
  const schedule = useCallback((value: T) => {
    if (!instance.current) throw new Error("The note is no longer open.");
    instance.current.schedule(value);
  }, []);
  const flush = useCallback(async () => {
    await instance.current?.flush();
  }, []);
  const stop = useCallback(async () => {
    await instance.current?.stop();
  }, []);
  const isDirty = useCallback(() => instance.current?.dirty ?? false, []);
  return useMemo(
    () => ({ schedule, flush, stop, isDirty }),
    [schedule, flush, stop, isDirty],
  );
}
