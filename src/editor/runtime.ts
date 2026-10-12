import { Directory, File, Paths } from "expo-file-system";
import { EDITOR_ENTRY, EDITOR_FILES, EDITOR_HTML } from "./generated/html";
import { perfMark, perfTrace } from "../dev/perf";

export type EditorRuntime = { uri: string };
export function editorPage(packet: string, background?: string): string {
  if (background !== undefined && !/^#[0-9a-f]{6}$/i.test(background))
    throw new Error("Invalid editor background.");
  return EDITOR_HTML.replace(
    "<html>",
    background
      ? `<html style="--siftnote-background:${background}">`
      : "<html>",
  ).replace(
    '<script id="siftnote-startup" type="application/json">null</script>',
    () =>
      `<script id="siftnote-startup" type="application/json">${packet.replace(/</g, "\\u003c")}</script>`,
  );
}
const directory = new Directory(Paths.cache, "siftnote-editor");
let preparing: Promise<EditorRuntime> | undefined;

// Materialize bundled scripts and fonts once. Each note's small HTML page uses
// this directory as its base URL, keeping these large assets out of its props.
export function prepareEditorRuntime(): Promise<EditorRuntime> {
  if (preparing) return preparing;
  const trace = perfTrace();
  perfMark("runtime.files.start", trace);
  preparing = (async () => {
    directory.create({ intermediates: true, idempotent: true });
    for (const asset of EDITOR_FILES) {
      if (
        !/^(inter-[a-f0-9]{16}\.ttf|editor-[a-f0-9]{16}\.(html|js))$/.test(
          asset.name,
        )
      )
        throw new Error("Invalid bundled editor file.");
      const target = new File(directory, asset.name);
      if (target.exists && target.size === asset.byteLength) continue;
      // Yield between files rather than blocking a frame with all six fonts.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const temporary = new File(directory, `${asset.name}.tmp`);
      try {
        temporary.create({ overwrite: true });
        temporary.write(asset.contents, { encoding: asset.encoding });
        if (temporary.size !== asset.byteLength)
          throw new Error("The bundled editor could not be prepared.");
        await temporary.move(target, { overwrite: true });
      } finally {
        // move() changes the File object's URI to the destination. Clean only
        // the original staging path, never the published page/font file.
        const stagingFile = new File(directory, `${asset.name}.tmp`);
        if (stagingFile.exists) stagingFile.delete();
      }
    }
    perfMark("runtime.files.end", trace);
    return {
      uri: new File(directory, EDITOR_ENTRY).uri,
    };
  })().catch((error: unknown) => {
    preparing = undefined;
    throw error;
  });
  return preparing;
}
