import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { createId, validId } from "../domain/document";
import type { NoteRepository } from "./repository";

const imageDirectory = new Directory(Paths.document, "siftnote-images");
const safeFile = /^sn_[a-z0-9]{1,16}_[a-z0-9]{32}\.(jpg|png|gif|webp)$/;
export function imageUri(fileName: string): string {
  if (!safeFile.test(fileName)) throw new Error("Invalid stored image path.");
  return new File(imageDirectory, fileName).uri;
}
export async function pickImage(repo: NoteRepository, noteId: string) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.8,
    allowsEditing: false,
    allowsMultipleSelection: false,
  });
  if (result.canceled) return null;
  const picked = result.assets[0];
  if (!picked) throw new Error("No image was selected.");
  const mime =
    picked.mimeType ??
    (picked.uri.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  const extension = extensions[mime];
  if (!extension) throw new Error("Choose a JPEG, PNG, GIF, or WebP image.");
  const id = createId();
  const fileName = `${id}.${extension}`;
  imageDirectory.create({ intermediates: true, idempotent: true });
  const target = new File(imageDirectory, fileName);
  try {
    await new File(picked.uri).copy(target);
    if (!target.exists || !target.size || target.size > 16 * 1024 * 1024)
      throw new Error("Choose an image smaller than 16 MB.");
    await repo.registerAsset(noteId, { id, fileName, mime });
    return { id, uri: target.uri };
  } catch (error) {
    if (target.exists) {
      try {
        target.delete();
      } catch {
        /* Startup reconciliation retries orphan cleanup. */
      }
    }
    throw error;
  }
}
export async function cleanImages(
  repo: NoteRepository,
  reconcileOrphans = false,
): Promise<void> {
  imageDirectory.create({ intermediates: true, idempotent: true });
  for (const row of await repo.db.getAllAsync<{ file_name: string }>(
    "SELECT file_name FROM pending_file_deletions",
  )) {
    if (!safeFile.test(row.file_name))
      throw new Error("An invalid cleanup record was preserved.");
    const file = new File(imageDirectory, row.file_name);
    if (file.exists) file.delete();
    await repo.db.runAsync(
      "DELETE FROM pending_file_deletions WHERE file_name=?",
      row.file_name,
    );
  }
  if (reconcileOrphans) {
    const known = new Set(
      (await repo.listAssets())
        .filter((a) => validId(a.id))
        .map((a) => a.fileName),
    );
    for (const file of imageDirectory.list())
      if (
        file instanceof File &&
        safeFile.test(file.name) &&
        !known.has(file.name)
      )
        file.delete();
  }
}
