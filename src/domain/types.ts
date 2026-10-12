import type { HighlightColor, RichDocument } from "./document";
export type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  isPinned: boolean;
  wordCount: number;
  highlightCounts: Partial<Record<HighlightColor, number>>;
};
export type Note = NoteSummary & { content: RichDocument; revision: number };
export type Highlight = {
  id: string;
  noteId: string;
  text: string;
  color: HighlightColor;
  position: number;
  createdAt: number;
  section: string;
  noteTitle: string;
};
export type Asset = { id: string; fileName: string; mime: string };
export type NoteDraft = { title: string; content: RichDocument };
