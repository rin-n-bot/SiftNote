import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
  createId,
  emptyDocument,
  parseDocument,
  type RichDocument,
} from "../domain/document";
import { parseCommand, type EditorCommand, type EditorEvent } from "./bridge";
import {
  copyPastedSlice,
  HighlightMark,
  localImageExtension,
} from "./extensions";

export class EditorController {
  editor: Editor;
  private images: Record<string, string> = {};
  private version = 0;
  private lastSnapshotVersion = 0;
  private initialized = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSelection = "";
  private destroyed = false;
  private sessionRevision = 0;
  private flashes = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  constructor(
    element: HTMLElement,
    private readonly send: (event: EditorEvent) => void,
    startup?: Extract<EditorCommand, { type: "init" }>,
  ) {
    if (startup) Object.assign(this.images, startup.images);
    this.editor = new Editor({
      element,
      content: startup?.content ?? emptyDocument(),
      enableContentCheck: true,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2] },
          blockquote: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          link: false,
          strike: false,
        }),
        HighlightMark,
        localImageExtension(this.images),
      ],
      editorProps: {
        attributes: {
          "aria-label": "Note body",
          role: "textbox",
          "aria-multiline": "true",
          spellcheck: "true",
        },
        transformPasted: (slice) => copyPastedSlice(slice, this.images),
        handleDOMEvents: {
          blur: () => {
            this.snapshot();
            return false;
          },
        },
      },
      onUpdate: () => {
        if (!this.initialized) return;
        this.version++;
        // One notification per pending snapshot is enough to mark native state
        // unsaved; the eventual snapshot carries the latest document version.
        if (this.version === this.lastSnapshotVersion + 1)
          this.send({ type: "dirty", version: this.version });
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.snapshot(), 200);
      },
      onTransaction: ({ transaction, appendedTransactions }) => {
        if (
          [transaction, ...appendedTransactions].some(
            (change) =>
              change.docChanged || change.selectionSet || change.storedMarksSet,
          )
        )
          this.selection();
      },
    });
    if (startup) this.initialize(startup, false);
  }
  receive(input: unknown) {
    let command: EditorCommand;
    try {
      command = parseCommand(input);
    } catch {
      this.send({ type: "error", code: "invalidDocument" });
      return;
    }
    this.receiveValidated(command);
  }
  // The bundled bridge already validated its packet. Avoid walking a large
  // document a second time when it reaches the controller.
  receiveValidated(command: EditorCommand) {
    try {
      this.execute(command);
    } catch {
      this.send({ type: "error", code: "editor" });
    }
  }
  private activeMark(): ProseMirrorMark | undefined {
    const { from, to, empty, $from } = this.editor.state.selection;
    if (empty) return $from.marks().find((m) => m.type.name === "highlight");
    let active: ProseMirrorMark | undefined;
    let mixed = false;
    this.editor.state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "highlight");
        if (!mark || (active && mark.attrs.id !== active.attrs.id))
          mixed = true;
        else active = mark;
      }
    });
    return mixed ? undefined : active;
  }
  private initialize(
    command: Extract<EditorCommand, { type: "init" }>,
    replaceDocument = true,
  ) {
    const e = this.editor;
    this.sessionRevision++;
    this.initialized = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearFlashes();
    e.view.dom.blur();
    for (const id of Object.keys(this.images)) delete this.images[id];
    Object.assign(this.images, command.images);
    if (replaceDocument) {
      const doc = e.schema.nodeFromJSON(command.content);
      doc.check();
      // A new note gets fresh plugin state; a page startup already has it.
      e.view.updateState(EditorState.create({ doc, plugins: e.state.plugins }));
    }
    this.version = 0;
    this.lastSnapshotVersion = 0;
    this.lastSelection = "";
    this.initialized = true;
    this.fontScale(command.fontScale);
    if (command.background)
      e.view.dom.ownerDocument.documentElement.style.setProperty(
        "--siftnote-background",
        command.background,
      );
    if (command.target?.type === "highlight")
      this.execute({ type: "jumpHighlight", id: command.target.id });
    else if (command.target?.type === "search")
      this.execute({ type: "jumpSearch", query: command.target.query });
    // The document is ready now. Source scrolling independently waits for fonts
    // when needed, without delaying input or requiring a second reveal command.
    this.send({ type: "initialized" });
    this.selection();
  }
  private execute(command: EditorCommand) {
    const e = this.editor;
    if (command.type === "init") {
      this.initialize(command);
      return;
    }
    if (!this.initialized) return;
    switch (command.type) {
      case "fontScale":
        this.fontScale(command.value);
        break;
      case "snapshot":
        // Acknowledge the live browser version even when there is no new body
        // to transfer. The caller still waits for the handshake before Back.
        if (command.knownVersion === this.version)
          this.send({ type: "snapshot", requestId: command.requestId });
        else this.snapshot(command.requestId);
        break;
      case "blur":
        e.commands.blur();
        this.snapshot();
        break;
      case "format": {
        const chain = e.chain().focus();
        switch (command.format) {
          case "normal":
            chain
              .clearNodes()
              .unsetMark("bold")
              .unsetMark("italic")
              .unsetMark("underline")
              .run();
            break;
          case "heading":
            chain.toggleHeading({ level: 2 }).run();
            break;
          case "bold":
            chain.toggleBold().run();
            break;
          case "italic":
            chain.toggleItalic().run();
            break;
          case "underline":
            chain.toggleUnderline().run();
            break;
          case "bulletList":
            chain.toggleBulletList().run();
            break;
          case "orderedList":
            chain.toggleOrderedList().run();
            break;
          case "undo":
            chain.undo().run();
            break;
          case "redo":
            chain.redo().run();
            break;
        }
        break;
      }
      case "highlight": {
        const active = this.activeMark();
        const tr = e.state.tr;
        const type = e.schema.marks.highlight;
        if (active)
          e.state.doc.descendants((node, pos) => {
            if (
              node.isInline &&
              node.marks.some(
                (m) => m.type === type && m.attrs.id === active.attrs.id,
              )
            ) {
              tr.removeMark(pos, pos + node.nodeSize, type).addMark(
                pos,
                pos + node.nodeSize,
                type.create({ ...active.attrs, color: command.color }),
              );
            }
          });
        else {
          if (e.state.selection.empty) {
            this.send({ type: "feedback", kind: "selectText" });
            return;
          }
          const { from, to } = e.state.selection;
          tr.removeMark(from, to, type).addMark(
            from,
            to,
            type.create({
              id: createId(),
              color: command.color,
              createdAt: Date.now(),
            }),
          );
        }
        e.view.dispatch(tr);
        e.commands.focus();
        this.send({ type: "feedback", kind: "applied" });
        this.snapshot();
        break;
      }
      case "removeHighlight": {
        const active = this.activeMark();
        const tr = e.state.tr;
        const type = e.schema.marks.highlight;
        if (active)
          e.state.doc.descendants((node, pos) => {
            if (
              node.isInline &&
              node.marks.some(
                (m) => m.type === type && m.attrs.id === active.attrs.id,
              )
            )
              tr.removeMark(pos, pos + node.nodeSize, type);
          });
        else {
          const { from, to } = e.state.selection;
          if (from === to) {
            this.send({ type: "feedback", kind: "selectText" });
            return;
          }
          tr.removeMark(from, to, type);
        }
        if (tr.docChanged) {
          e.view.dispatch(tr);
          this.send({ type: "feedback", kind: "removed" });
          this.snapshot();
        }
        break;
      }
      case "insertImage":
        this.images[command.assetId] = command.uri;
        e.chain()
          .focus()
          .insertContent({
            type: "image",
            attrs: {
              assetId: command.assetId,
              src: `siftnote-image:${command.assetId}`,
              alt: "Note image",
            },
          })
          .run();
        this.snapshot();
        this.send({ type: "feedback", kind: "image" });
        break;
      case "jumpHighlight": {
        let position: number | undefined;
        e.state.doc.descendants((node, pos) => {
          if (position !== undefined) return false;
          if (
            node.marks.some(
              (m) => m.type.name === "highlight" && m.attrs.id === command.id,
            )
          )
            position = pos;
          return position === undefined;
        });
        if (position === undefined) {
          this.send({ type: "feedback", kind: "missingPassage" });
          return;
        }
        e.commands.setTextSelection(position);
        this.scroll(position);
        break;
      }
      case "jumpSearch": {
        const query = command.query.normalize("NFKC").toLowerCase().trim();
        let found: number | undefined;
        e.state.doc.descendants((node, pos) => {
          if (found !== undefined) return false;
          if (!node.isTextblock) return;
          const text = node.textBetween(0, node.content.size, "", "\n");
          const normalized = text.normalize("NFKC").toLowerCase();
          const index = normalized.indexOf(query);
          if (index < 0) return false;
          let source = 0;
          let length = 0;
          for (const piece of text.match(/\P{Mark}\p{Mark}*|\p{Mark}+/gu) ??
            []) {
            if (index < length + piece.normalize("NFKC").toLowerCase().length)
              break;
            source += piece.length;
            length += piece.normalize("NFKC").toLowerCase().length;
          }
          found = pos + 1 + source;
          return false;
        });
        if (found !== undefined) {
          e.commands.setTextSelection(found);
          this.scroll(found);
        }
        break;
      }
    }
  }
  private fontScale(value: number) {
    this.editor.view.dom.style.fontSize = `${16 * value}px`;
  }
  private scroll(position: number) {
    const revision = this.sessionRevision;
    const scroll = () => {
      if (this.destroyed || revision !== this.sessionRevision) return;
      const dom = this.editor.view.domAtPos(position);
      const el = (
        dom.node.nodeType === 3 ? dom.node.parentElement : dom.node
      ) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView?.({ block: "center", behavior: "auto" });
      el.classList.add("source-flash");
      const timer = setTimeout(() => {
        el.classList.remove("source-flash");
        this.flashes.delete(el);
      }, 1400);
      const previous = this.flashes.get(el);
      if (previous) clearTimeout(previous);
      this.flashes.set(el, timer);
    };
    if (document.fonts?.status === "loading")
      void document.fonts.ready.then(scroll);
    else scroll();
  }
  private selection() {
    if (!this.initialized) return;
    const e = this.editor;
    const active = this.activeMark();
    const state = {
      hasSelection: !e.state.selection.empty,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      heading: e.isActive("heading"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      highlightColor: active?.attrs.color ?? null,
    };
    const serialized = JSON.stringify(state);
    if (serialized !== this.lastSelection) {
      this.lastSelection = serialized;
      this.send({ type: "selection", state });
    }
  }
  private snapshot(requestId?: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.initialized) return;
    // Blur/page visibility can repeat without an edit. Explicit save requests
    // still need an acknowledgment, including for an unchanged document.
    if (!requestId && this.version === this.lastSnapshotVersion) return;
    try {
      const content = parseDocument(this.editor.getJSON()) as RichDocument;
      this.lastSnapshotVersion = this.version;
      this.send({
        type: "change",
        content,
        version: this.version,
        ...(requestId ? { requestId } : {}),
      });
    } catch {
      this.send({ type: "error", code: "invalidDocument" });
    }
  }
  destroy() {
    this.destroyed = true;
    this.sessionRevision++;
    this.initialized = false;
    if (this.timer) clearTimeout(this.timer);
    this.clearFlashes();
    this.editor.destroy();
  }
  private clearFlashes() {
    for (const [element, timer] of this.flashes) {
      clearTimeout(timer);
      element.classList.remove("source-flash");
    }
    this.flashes.clear();
  }
}
