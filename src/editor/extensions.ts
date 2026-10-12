import { Mark, mergeAttributes } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
  createId,
  HIGHLIGHT_PALETTE,
  isColor,
  validId,
} from "../domain/document";

export const HighlightMark = Mark.create({
  name: "highlight",
  inclusive: false,
  keepOnSplit: true,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-highlight-id"),
      },
      color: {
        default: "yellow",
        parseHTML: (element) => element.getAttribute("data-highlight-color"),
      },
      createdAt: {
        default: null,
        parseHTML: (element) =>
          Number(element.getAttribute("data-highlight-created")),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "mark[data-highlight-id]",
        getAttrs: (element) => {
          const el = element as HTMLElement;
          return validId(el.dataset.highlightId) &&
            isColor(el.dataset.highlightColor) &&
            Number.isSafeInteger(Number(el.dataset.highlightCreated)) &&
            Number(el.dataset.highlightCreated) > 0
            ? null
            : false;
        },
      },
    ];
  },
  renderHTML({ mark, HTMLAttributes }) {
    const color = isColor(mark.attrs.color) ? mark.attrs.color : "yellow";
    return [
      "mark",
      mergeAttributes(HTMLAttributes, {
        "data-highlight-id": mark.attrs.id,
        "data-highlight-color": color,
        "data-highlight-created": mark.attrs.createdAt,
        style: `background-color:${HIGHLIGHT_PALETTE[color].fill};color:inherit;border-radius:3px;box-decoration-break:clone;-webkit-box-decoration-break:clone;`,
      }),
      0,
    ];
  },
});
export function localImageExtension(images: Record<string, string>) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        assetId: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-asset-id"),
        },
        src: {
          default: null,
          parseHTML: (element) =>
            `siftnote-image:${element.getAttribute("data-asset-id")}`,
        },
      };
    },
    parseHTML() {
      return [
        {
          tag: "img[data-asset-id]",
          getAttrs: (element) =>
            validId((element as HTMLElement).dataset.assetId) ? null : false,
        },
      ];
    },
    renderHTML({ node }) {
      return [
        "img",
        {
          "data-asset-id": node.attrs.assetId,
          src: images[node.attrs.assetId] ?? "",
          alt: node.attrs.alt ?? "Note image",
          draggable: "false",
        },
      ];
    },
  }).configure({ allowBase64: false, inline: false });
}
// Clipboard copies are new passages, not aliases of the original highlight IDs.
export function copyPastedSlice(
  slice: Slice,
  images: Record<string, string>,
): Slice {
  const ids = new Map<string, { id: string; createdAt: number }>();
  const transform = (fragment: Fragment): Fragment => {
    const nodes: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      if (node.type.name === "image" && !images[node.attrs.assetId]) return;
      const marks = node.marks.map((mark) => {
        if (mark.type.name !== "highlight") return mark;
        const old = String(mark.attrs.id);
        if (!ids.has(old))
          ids.set(old, { id: createId(), createdAt: Date.now() });
        return mark.type.create({ ...mark.attrs, ...ids.get(old) });
      });
      nodes.push(
        node.isText
          ? node.mark(marks)
          : node.copy(transform(node.content)).mark(marks),
      );
    });
    return Fragment.fromArray(nodes);
  };
  return new Slice(transform(slice.content), slice.openStart, slice.openEnd);
}
