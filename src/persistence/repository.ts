import {
  analyzeDocument,
  createId,
  duplicateDocument,
  emptyDocument,
  HIGHLIGHT_COLORS,
  isColor,
  normalizeSearch,
  parseDocument,
  validId,
  type IndexedHighlight,
} from "../domain/document";
import type {
  Asset,
  Highlight,
  Note,
  NoteDraft,
  NoteSummary,
} from "../domain/types";
import { perfMark, perfSync, perfTrace } from "../dev/perf";

type SqlValue = string | number | null;
export interface SqlExecutor {
  execAsync(sql: string): Promise<void>;
  runAsync(
    sql: string,
    ...params: SqlValue[]
  ): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
export interface SqlDatabase extends SqlExecutor {
  withExclusiveTransactionAsync(
    task: (tx: SqlExecutor) => Promise<void>,
  ): Promise<void>;
}
const SCHEMA_V1 = `
CREATE TABLE notes (
 id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
 body_text TEXT NOT NULL, search_text TEXT NOT NULL, preview TEXT NOT NULL,
 word_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0,1)), revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE highlights (
 id TEXT NOT NULL, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 text TEXT NOT NULL, search_text TEXT NOT NULL, color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink','purple','orange')),
 position INTEGER NOT NULL, created_at INTEGER NOT NULL, section TEXT NOT NULL,
 PRIMARY KEY(note_id,id)
);
CREATE INDEX notes_order ON notes(is_pinned DESC,updated_at DESC);
CREATE INDEX highlights_note_color ON highlights(note_id,color);
CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL, file_name TEXT UNIQUE NOT NULL, mime TEXT NOT NULL);
CREATE TABLE note_assets (
 note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
 asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(note_id,asset_id)
);
CREATE TABLE pending_file_deletions (file_name TEXT PRIMARY KEY NOT NULL);
PRAGMA user_version = 1;`;
export async function migrateDatabase(db: SqlDatabase): Promise<void> {
  await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const row = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version",
  );
  if ((row?.user_version ?? 0) > 1)
    throw new Error(
      "This database was saved by a newer SiftNote version. Your data has been kept.",
    );
  if (!row?.user_version)
    await db.withExclusiveTransactionAsync((tx) => tx.execAsync(SCHEMA_V1));
}
type SummaryRow = {
  id: string;
  title: string;
  preview: string;
  created_at: number;
  updated_at: number;
  is_pinned: number;
  word_count: number;
  color_list: string | null;
};
type NoteRow = SummaryRow & { content: string; revision: number };
const summaryColumns =
  "n.id,n.title,n.preview,n.created_at,n.updated_at,n.is_pinned,n.word_count,GROUP_CONCAT(h.color) color_list";
function summary(row: SummaryRow): NoteSummary {
  if (
    !validId(row.id) ||
    typeof row.title !== "string" ||
    row.title.length > 1000 ||
    typeof row.preview !== "string" ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at <= 0 ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at <= 0 ||
    !Number.isSafeInteger(row.word_count) ||
    row.word_count < 0 ||
    ![0, 1].includes(row.is_pinned) ||
    (row.color_list !== null && typeof row.color_list !== "string")
  )
    throw new Error(
      "A saved note could not be read. Your stored data has been kept.",
    );
  const highlightCounts: NoteSummary["highlightCounts"] = {};
  for (const color of row.color_list?.split(",") ?? [])
    if (isColor(color))
      highlightCounts[color] = (highlightCounts[color] ?? 0) + 1;
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isPinned: row.is_pinned === 1,
    wordCount: row.word_count,
    highlightCounts,
  };
}

async function insertHighlights(
  tx: SqlExecutor,
  noteId: string,
  highlights: readonly IndexedHighlight[],
): Promise<void> {
  // Eight bound values per row: keep each statement below 999 parameters,
  // including on SQLite builds with the older default variable limit.
  const rowsPerStatement = 64;
  for (let start = 0; start < highlights.length; start += rowsPerStatement) {
    const batch = highlights.slice(start, start + rowsPerStatement);
    const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?)").join(",");
    const values: SqlValue[] = batch.flatMap((highlight) => [
      highlight.id,
      noteId,
      highlight.text,
      normalizeSearch(highlight.text),
      highlight.color,
      highlight.position,
      highlight.createdAt,
      highlight.section,
    ]);
    await tx.runAsync(
      `INSERT INTO highlights(id,note_id,text,search_text,color,position,created_at,section) VALUES ${placeholders}`,
      ...values,
    );
  }
}
export class NoteRepository {
  constructor(readonly db: SqlDatabase) {}
  async listNotes(query = ""): Promise<NoteSummary[]> {
    const trace = perfTrace();
    perfMark("sqlite.listNotes.start", trace);
    const rows = await this.db.getAllAsync<SummaryRow>(
      `SELECT ${summaryColumns} FROM notes n LEFT JOIN highlights h ON h.note_id=n.id WHERE instr(n.search_text,?)>0 GROUP BY n.id ORDER BY n.is_pinned DESC,n.updated_at DESC,n.id`,
      normalizeSearch(query),
    );
    perfMark("sqlite.listNotes.end", trace, { rows: rows.length });
    return perfSync(
      "sqlite.listNotes.summaries",
      () => rows.map(summary),
      trace,
    );
  }
  async getNote(id: string): Promise<Note | null> {
    if (!validId(id)) return null;
    const trace = perfTrace();
    perfMark("sqlite.getNote.start", trace);
    const row = await this.db.getFirstAsync<NoteRow>(
      `SELECT ${summaryColumns},n.content,n.revision FROM notes n LEFT JOIN highlights h ON h.note_id=n.id WHERE n.id=? GROUP BY n.id`,
      id,
    );
    perfMark("sqlite.getNote.end", trace);
    if (!row) return null;
    try {
      if (!Number.isSafeInteger(row.revision) || row.revision < 0)
        throw new Error("Invalid note revision.");
      const parsed: unknown = perfSync(
        "prepare.jsonParse",
        () => JSON.parse(row.content),
        trace,
      );
      const content = perfSync(
        "prepare.validation",
        () => parseDocument(parsed),
        trace,
      );
      perfSync("prepare.savedAnalysis", () => analyzeDocument(content), trace);
      return {
        ...summary(row),
        content,
        revision: row.revision,
      };
    } catch {
      throw new Error(
        "This note contains unreadable data. It has not been changed or deleted.",
      );
    }
  }
  async createNote(): Promise<Note> {
    const id = createId();
    const time = Date.now();
    const content = emptyDocument();
    await this.db.runAsync(
      "INSERT INTO notes(id,title,content,body_text,search_text,preview,word_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      "",
      JSON.stringify(content),
      "",
      "",
      "",
      0,
      time,
      time,
    );
    // Return the committed values; creation does not need a SELECT round trip.
    return {
      id,
      title: "",
      content,
      preview: "",
      wordCount: 0,
      highlightCounts: {},
      createdAt: time,
      updatedAt: time,
      isPinned: false,
      revision: 0,
    };
  }
  async saveNote(
    id: string,
    draft: NoteDraft,
    expectedRevision: number,
  ): Promise<number> {
    if (
      !validId(id) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      typeof draft.title !== "string" ||
      draft.title.length > 1000
    )
      throw new Error("The note title is too long to save.");
    const content = parseDocument(draft.content);
    const analyzed = analyzeDocument(content);
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      for (const assetId of analyzed.assetIds) {
        const asset = await tx.getFirstAsync(
          "SELECT asset_id FROM note_assets WHERE note_id=? AND asset_id=?",
          id,
          assetId,
        );
        if (!asset)
          throw new Error(
            "An image is missing from local storage. Your previous saved note has been kept.",
          );
      }
      const result = await tx.runAsync(
        "UPDATE notes SET title=?,content=?,body_text=?,search_text=?,preview=?,word_count=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?",
        draft.title,
        JSON.stringify(content),
        analyzed.text,
        normalizeSearch(draft.title + "\n" + analyzed.text),
        analyzed.preview,
        analyzed.wordCount,
        Date.now(),
        id,
        expectedRevision,
      );
      if (result.changes !== 1)
        throw new Error(
          "This note was changed or deleted elsewhere. Your edits have not been overwritten.",
        );
      await tx.runAsync("DELETE FROM highlights WHERE note_id=?", id);
      await insertHighlights(tx, id, analyzed.highlights);
    });
    return expectedRevision + 1;
  }
  async setPinned(id: string, pinned: boolean): Promise<void> {
    const result = await this.db.runAsync(
      "UPDATE notes SET is_pinned=?,updated_at=? WHERE id=?",
      pinned ? 1 : 0,
      Date.now(),
      id,
    );
    if (!result.changes) throw new Error("This note no longer exists.");
  }
  async duplicateNote(id: string): Promise<string> {
    const note = await this.getNote(id);
    if (!note) throw new Error("This note no longer exists.");
    const copyId = createId();
    const content = duplicateDocument(note.content);
    const analyzed = analyzeDocument(content);
    const time = Date.now();
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      const source = await tx.getFirstAsync<{ revision: number }>(
        "SELECT revision FROM notes WHERE id=?",
        id,
      );
      if (!source || source.revision !== note.revision)
        throw new Error(
          "This note changed before it could be duplicated. Reopen it and try again.",
        );
      await tx.runAsync(
        "INSERT INTO notes(id,title,content,body_text,search_text,preview,word_count,created_at,updated_at,is_pinned) VALUES (?,?,?,?,?,?,?,?,?,?)",
        copyId,
        note.title,
        JSON.stringify(content),
        analyzed.text,
        normalizeSearch(note.title + "\n" + analyzed.text),
        analyzed.preview,
        analyzed.wordCount,
        time,
        time,
        note.isPinned ? 1 : 0,
      );
      await insertHighlights(tx, copyId, analyzed.highlights);
      for (const assetId of analyzed.assetIds) {
        if (
          !(await tx.getFirstAsync("SELECT id FROM assets WHERE id=?", assetId))
        )
          throw new Error(
            "An image is no longer available. The duplicate was not created.",
          );
        await tx.runAsync(
          "INSERT INTO note_assets(note_id,asset_id) VALUES (?,?)",
          copyId,
          assetId,
        );
      }
    });
    return copyId;
  }
  async deleteNote(id: string): Promise<void> {
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      // Expo exclusive transactions use a new connection; foreign-key PRAGMAs
      // are connection-local. Explicit cleanup is required on every connection.
      await tx.runAsync("DELETE FROM highlights WHERE note_id=?", id);
      await tx.runAsync("DELETE FROM note_assets WHERE note_id=?", id);
      await tx.runAsync("DELETE FROM notes WHERE id=?", id);
      await tx.execAsync(
        "INSERT OR IGNORE INTO pending_file_deletions(file_name) SELECT file_name FROM assets WHERE id NOT IN (SELECT asset_id FROM note_assets); DELETE FROM assets WHERE id NOT IN (SELECT asset_id FROM note_assets);",
      );
    });
  }
  async listHighlights(
    options: { noteId?: string; color?: string; query?: string } = {},
  ): Promise<Highlight[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const query = normalizeSearch(options.query ?? "");
    if (query) {
      clauses.push("instr(h.search_text,?)>0");
      params.push(query);
    }
    if (options.noteId) {
      clauses.push("h.note_id=?");
      params.push(options.noteId);
    }
    if (options.color && options.color !== "all") {
      if (!isColor(options.color)) return [];
      clauses.push("h.color=?");
      params.push(options.color);
    }
    const rows = await this.db.getAllAsync<{
      id: string;
      note_id: string;
      text: string;
      color: string;
      position: number;
      created_at: number;
      section: string;
      title: string;
    }>(
      `SELECT h.id,h.note_id,h.text,h.color,h.position,h.created_at,h.section,n.title FROM highlights h JOIN notes n ON n.id=h.note_id${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${options.noteId ? "h.position" : "h.created_at DESC"},h.id`,
      ...params,
    );
    return rows.map((h) => {
      if (
        !validId(h.id) ||
        !validId(h.note_id) ||
        !isColor(h.color) ||
        typeof h.text !== "string" ||
        typeof h.title !== "string" ||
        typeof h.section !== "string" ||
        !Number.isSafeInteger(h.position) ||
        h.position < 0 ||
        !Number.isSafeInteger(h.created_at) ||
        h.created_at <= 0
      )
        throw new Error(
          "A highlight could not be read. Your data has been kept.",
        );
      return {
        id: h.id,
        noteId: h.note_id,
        text: h.text,
        color: h.color,
        position: h.position,
        createdAt: h.created_at,
        section: h.section,
        noteTitle: h.title,
      };
    });
  }
  async registerAsset(noteId: string, asset: Asset): Promise<void> {
    if (
      !validId(asset.id) ||
      !new RegExp(`^${asset.id}\\.(jpg|png|webp|gif)$`).test(asset.fileName)
    )
      throw new Error("Invalid image file.");
    await this.db.withExclusiveTransactionAsync(async (tx) => {
      if (!(await tx.getFirstAsync("SELECT id FROM notes WHERE id=?", noteId)))
        throw new Error(
          "The note was deleted before the image could be added.",
        );
      await tx.runAsync(
        "INSERT INTO assets(id,file_name,mime) VALUES (?,?,?)",
        asset.id,
        asset.fileName,
        asset.mime,
      );
      await tx.runAsync(
        "INSERT INTO note_assets(note_id,asset_id) VALUES (?,?)",
        noteId,
        asset.id,
      );
    });
  }
  async listAssets(noteId?: string): Promise<Asset[]> {
    const rows = noteId
      ? await this.db.getAllAsync<{
          id: string;
          file_name: string;
          mime: string;
        }>(
          "SELECT a.* FROM assets a JOIN note_assets n ON n.asset_id=a.id WHERE n.note_id=?",
          noteId,
        )
      : await this.db.getAllAsync<{
          id: string;
          file_name: string;
          mime: string;
        }>("SELECT * FROM assets");
    return rows.map((a) => ({ id: a.id, fileName: a.file_name, mime: a.mime }));
  }
}
export const totalHighlights = (note: NoteSummary) =>
  HIGHLIGHT_COLORS.reduce(
    (sum, color) => sum + (note.highlightCounts[color] ?? 0),
    0,
  );
