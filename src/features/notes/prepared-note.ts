import { File } from "expo-file-system";
import { analyzeDocument, createId } from "../../domain/document";
import type { Note } from "../../domain/types";
import { prepareEditorRuntime, type EditorRuntime } from "../../editor/runtime";
import { imageUri } from "../../persistence/images";
import type { NoteRepository } from "../../persistence/repository";
import { perfMark, perfSync, perfTrace, type PerfTrace } from "../../dev/perf";
import type { EditorTarget } from "../../editor/bridge";

export type PreparedNote = {
  openingId: string;
  note: Note;
  images: Record<string, string>;
  runtime: EditorRuntime;
  missingImage: boolean;
  trace?: PerfTrace; // TEMPORARY: diagnostic identity, never persisted.
};
export type NoteOpening = {
  openingId: string;
  title: string;
  target?: EditorTarget;
  load: () => Promise<PreparedNote | null>;
  trace?: PerfTrace;
};
// One current request, not a cache. Delivery is synchronous and independent of
// Router parameters. A replaced/cancelled request cannot present a document.
let prepared: NoteOpening | undefined;
const listeners = new Set<() => void>();
export function subscribePreparedNote(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function currentPreparedNote() {
  return prepared;
}
export function stagePreparedNote(value: NoteOpening) {
  prepared = value;
  perfMark("channel.publish", value.trace);
  for (const listener of listeners) listener();
  perfMark("channel.publish.end", value.trace);
}
export function releasePreparedNote(value: NoteOpening) {
  if (prepared === value) {
    prepared = undefined;
    perfMark("channel.cancel", value.trace);
    for (const listener of listeners) listener();
  }
}
export async function loadNoteForOpening(
  repo: NoteRepository,
  source: string | Note,
  trace = perfTrace(),
): Promise<PreparedNote | null> {
  perfMark("prepare.start", trace, { sqliteRead: typeof source === "string" });
  perfMark("prepare.note.start", trace);
  const noteRequest =
    typeof source === "string" ? repo.getNote(source) : Promise.resolve(source);
  perfMark("prepare.runtime.start", trace);
  const [note, runtime] = await Promise.all([
    noteRequest.then((note) => {
      perfMark("prepare.note.end", trace);
      return note;
    }),
    prepareEditorRuntime().then((runtime) => {
      perfMark("prepare.runtime.end", trace);
      return runtime;
    }),
  ]);
  perfMark("prepare.noteAndRuntime.end", trace);
  if (!note) return null;
  const images: Record<string, string> = {};
  const usedImages = perfSync(
    "prepare.imageAnalysis",
    () => new Set(analyzeDocument(note.content).assetIds),
    trace,
  );
  perfMark("prepare.analysis.end", trace, { images: usedImages.size });
  perfMark("prepare.assets.start", trace);
  const assets = usedImages.size ? await repo.listAssets(note.id) : [];
  perfMark("prepare.assets.end", trace);
  let missingImage = false;
  perfSync(
    "prepare.imageFiles",
    () => {
      for (const asset of assets) {
        images[asset.id] = imageUri(asset.fileName);
        if (usedImages.has(asset.id) && !new File(images[asset.id]).exists)
          missingImage = true;
      }
    },
    trace,
  );
  perfMark("prepare.end", trace);
  return {
    openingId: createId(),
    note,
    images,
    runtime,
    missingImage,
    trace,
  };
}
