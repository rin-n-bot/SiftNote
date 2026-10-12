// Serialized, debounced saves. New drafts cannot be overtaken by older requests.
export class Autosave<T> {
  private pending: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly status: (
      state: "saving" | "saved" | "error",
      error?: Error,
    ) => void,
    private readonly delay = 500,
  ) {}
  get dirty() {
    return this.pending !== undefined || this.inFlight !== undefined;
  }
  schedule(value: T) {
    this.pending = value;
    this.status("saving");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, this.delay);
  }
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
      return this.flush();
    }
    if (this.pending === undefined) return;
    const snapshot = this.pending;
    this.pending = undefined;
    this.inFlight = this.write(snapshot);
    try {
      await this.inFlight;
    } catch (cause) {
      if (this.pending === undefined) this.pending = snapshot;
      const error =
        cause instanceof Error
          ? cause
          : new Error("The note could not be saved.");
      this.status("error", error);
      throw error;
    } finally {
      this.inFlight = undefined;
    }
    if (this.pending !== undefined) return this.flush();
    this.status("saved");
  }
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight;
    this.pending = undefined;
  }
}
