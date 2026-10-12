export const HIGHLIGHT_COLORS = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
  "orange",
] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const HIGHLIGHT_PALETTE: Record<
  HighlightColor,
  { dot: string; fill: string; label: string }
> = {
  yellow: { dot: "#E6AD00", fill: "#FFF2AD", label: "Yellow" },
  green: { dot: "#37AE58", fill: "#D8F5D9", label: "Green" },
  blue: { dot: "#398BE8", fill: "#D9E9FF", label: "Blue" },
  pink: { dot: "#E6579C", fill: "#FFE0EE", label: "Pink" },
  purple: { dot: "#9C62DF", fill: "#EEDFFF", label: "Purple" },
  orange: { dot: "#ED8C28", fill: "#FFE5CC", label: "Orange" },
};
type RichMark =
  | { type: "bold" | "italic" | "underline" }
  | {
      type: "highlight";
      attrs: { id: string; color: HighlightColor; createdAt: number };
    };
type RichNode = {
  type:
    | "doc"
    | "paragraph"
    | "heading"
    | "bulletList"
    | "orderedList"
    | "listItem"
    | "text"
    | "hardBreak"
    | "image";
  attrs?: {
    level?: number;
    start?: number;
    assetId?: string;
    src?: string;
    alt?: string | null;
    title?: string | null;
  };
  text?: string;
  marks?: RichMark[];
  content?: RichNode[];
};
export type RichDocument = RichNode & { type: "doc"; content: RichNode[] };
export type IndexedHighlight = {
  id: string;
  text: string;
  color: HighlightColor;
  position: number;
  createdAt: number;
  section: string;
};
export function createId(): string {
  return `sn_${Date.now().toString(36)}_${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10).padEnd(8, "0")).join("")}`;
}
export const validId = (value: unknown): value is string =>
  typeof value === "string" && /^sn_[a-z0-9]{1,16}_[a-z0-9]{32}$/.test(value);
export const isColor = (value: unknown): value is HighlightColor =>
  HIGHLIGHT_COLORS.includes(value as HighlightColor);
export const emptyDocument = (): RichDocument => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
export const plainDocument = (text: string): RichDocument => ({
  type: "doc",
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    ...(line ? { content: [{ type: "text", text: line }] } : {}),
  })),
});
export const normalizeSearch = (text: string): string =>
  text.normalize("NFKC").toLowerCase().trim();
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const nodeTypes = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "text",
  "hardBreak",
  "image",
]);
// Validate persisted and bridge documents before they can replace stored user data.
export function parseDocument(value: unknown): RichDocument {
  let count = 0;
  let characters = 0;
  const visit = (input: unknown, depth: number): RichNode => {
    if (
      ++count > 100000 ||
      depth > 64 ||
      !isRecord(input) ||
      typeof input.type !== "string" ||
      !nodeTypes.has(input.type)
    )
      throw new Error("Invalid note document.");
    const type = input.type as RichNode["type"];
    const node: RichNode = { type };
    if (type === "text") {
      if (
        typeof input.text !== "string" ||
        !input.text.length ||
        (characters += input.text.length) > 5000000
      )
        throw new Error("Invalid note text.");
      node.text = input.text;
    }
    if (type === "heading") {
      if (!isRecord(input.attrs) || input.attrs.level !== 2)
        throw new Error("Invalid heading.");
      node.attrs = { level: 2 };
    }
    if (type === "orderedList") {
      if (
        isRecord(input.attrs) &&
        input.attrs.start !== undefined &&
        (!Number.isSafeInteger(input.attrs.start) ||
          Number(input.attrs.start) <= 0)
      )
        throw new Error("Invalid numbered list.");
      node.attrs = {
        start:
          isRecord(input.attrs) &&
          Number.isInteger(input.attrs.start) &&
          Number(input.attrs.start) > 0
            ? Number(input.attrs.start)
            : 1,
      };
    }
    if (type === "image") {
      if (
        !isRecord(input.attrs) ||
        !validId(input.attrs.assetId) ||
        input.attrs.src !== `siftnote-image:${input.attrs.assetId}`
      )
        throw new Error("Invalid note image.");
      node.attrs = {
        assetId: input.attrs.assetId,
        src: input.attrs.src,
        alt:
          typeof input.attrs.alt === "string"
            ? input.attrs.alt.slice(0, 500)
            : "Note image",
      };
    }
    if (input.marks !== undefined) {
      if (
        !Array.isArray(input.marks) ||
        input.marks.length > 4 ||
        (type !== "text" && type !== "hardBreak")
      )
        throw new Error("Invalid formatting.");
      const seen = new Set<string>();
      node.marks = input.marks.map((mark): RichMark => {
        if (
          !isRecord(mark) ||
          typeof mark.type !== "string" ||
          seen.has(mark.type)
        )
          throw new Error("Invalid formatting.");
        seen.add(mark.type);
        if (["bold", "italic", "underline"].includes(mark.type))
          return { type: mark.type as "bold" | "italic" | "underline" };
        if (
          mark.type !== "highlight" ||
          !isRecord(mark.attrs) ||
          !validId(mark.attrs.id) ||
          !isColor(mark.attrs.color) ||
          !Number.isSafeInteger(mark.attrs.createdAt) ||
          Number(mark.attrs.createdAt) <= 0
        )
          throw new Error("Invalid highlight.");
        return {
          type: "highlight",
          attrs: {
            id: mark.attrs.id,
            color: mark.attrs.color,
            createdAt: Number(mark.attrs.createdAt),
          },
        };
      });
    }
    if (input.content !== undefined) {
      if (
        !Array.isArray(input.content) ||
        ["text", "hardBreak", "image"].includes(type)
      )
        throw new Error("Invalid document structure.");
      node.content = input.content.map((child) => visit(child, depth + 1));
    }
    const children = node.content ?? [];
    const inline = (child: RichNode) =>
      ["text", "hardBreak"].includes(child.type);
    const block = (child: RichNode) =>
      ["paragraph", "heading", "bulletList", "orderedList", "image"].includes(
        child.type,
      );
    if (
      (type === "doc" &&
        (depth !== 0 || !children.length || !children.every(block))) ||
      (["paragraph", "heading"].includes(type) && !children.every(inline)) ||
      (["bulletList", "orderedList"].includes(type) &&
        (!children.length ||
          !children.every((child) => child.type === "listItem"))) ||
      (type === "listItem" &&
        (children[0]?.type !== "paragraph" || !children.every(block)))
    )
      throw new Error("Invalid document structure.");
    return node;
  };
  const result = visit(value, 0);
  if (result.type !== "doc") throw new Error("Invalid note document.");
  return result as RichDocument;
}
export function analyzeDocument(doc: RichDocument) {
  const highlights = new Map<string, IndexedHighlight>();
  const assets = new Set<string>();
  let text = "";
  let section = "";
  let blockNumber = 0;
  const lastBlocks = new Map<string, number>();
  const lastEnds = new Map<string, number>();
  const walk = (node: RichNode, position: number): number => {
    if (node.type === "heading")
      section = (node.content ?? []).map((child) => child.text ?? "").join("");
    if (node.type === "image" && node.attrs?.assetId)
      assets.add(node.attrs.assetId);
    if (node.type === "text" || node.type === "hardBreak") {
      const value = node.text ?? "\n";
      text += value;
      const mark = node.marks?.find(
        (m): m is Extract<RichMark, { type: "highlight" }> =>
          m.type === "highlight",
      );
      if (mark) {
        let highlight = highlights.get(mark.attrs.id);
        if (!highlight) {
          highlight = { ...mark.attrs, text: "", position, section };
          highlights.set(highlight.id, highlight);
        } else if (
          highlight.color !== mark.attrs.color ||
          highlight.createdAt !== mark.attrs.createdAt
        )
          throw new Error("Inconsistent highlight identity.");
        if (highlight.text && lastBlocks.get(highlight.id) !== blockNumber)
          highlight.text += "\n";
        else if (highlight.text && lastEnds.get(highlight.id) !== position)
          highlight.text += " … ";
        highlight.text += value;
        lastBlocks.set(highlight.id, blockNumber);
        lastEnds.set(highlight.id, position + value.length);
      }
      return node.type === "text" ? value.length : 1;
    }
    if (node.type === "image") return 1;
    let size = 0;
    for (const child of node.content ?? [])
      size += walk(child, position + (node.type === "doc" ? 0 : 1) + size);
    if (["paragraph", "heading"].includes(node.type)) {
      text += "\n";
      blockNumber++;
    }
    return size + (node.type === "doc" ? 0 : 2);
  };
  walk(doc, 0);
  text = text.trimEnd();
  return {
    text,
    preview:
      text.replace(/\s+/gu, " ").slice(0, 180) || (assets.size ? "Image" : ""),
    wordCount: text.trim() ? text.trim().split(/\s+/u).length : 0,
    highlights: [...highlights.values()].filter((h) => h.text.trim().length),
    assetIds: [...assets],
  };
}
export function duplicateDocument(doc: RichDocument): RichDocument {
  const ids = new Map<string, string>();
  const copied = JSON.parse(JSON.stringify(doc)) as RichDocument;
  const visit = (node: RichNode) => {
    for (const mark of node.marks ?? [])
      if (mark.type === "highlight") {
        if (!ids.has(mark.attrs.id)) ids.set(mark.attrs.id, createId());
        mark.attrs.id = ids.get(mark.attrs.id)!;
      }
    node.content?.forEach(visit);
  };
  visit(copied);
  return copied;
}
