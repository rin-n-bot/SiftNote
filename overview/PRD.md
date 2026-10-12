# SiftNote- MVP PRD

## Product

SiftNote is a mobile notes app where highlighted text becomes easy to review later.

Core loop:

**Write → Highlight → Review**

---

## Main Navigation

Two bottom tabs only:

- Notes
- Highlights

---

## 1. Notes Screen

Must include:

- Notes list
- Search bar
- Add note button
- Note title
- Text preview
- Last edited time
- Highlight color indicators/count
- Pin note
- Delete note

States:

- Normal notes list
- Empty notes state
- Search results
- No search results

---

## 2. Note Editor

Must include:

- Back button
- Editable title
- Editable note body
- Autosave
- Overflow `...` menu

Overflow actions:

- Rename
- Pin / Unpin
- Duplicate
- Delete

### Editor toolbar

- `Aa` text formatting
- Bullet list
- Numbered list
- Insert image
- Undo
- Redo

Basic formatting:

- Normal text
- Heading
- Bold
- Italic
- Underline

---

## 3. Highlighting

User selects text and can:

- Highlight it
- Choose a color
- Change existing highlight color
- Remove highlight

Colors:

- Yellow
- Green
- Blue
- Pink
- Purple
- Orange

Show highlight counts by color.

---

## 4. Per-Note Review

Inside every note:

```text
Full Note | Highlights
```

### Full Note

Shows the complete editable note.

### Highlights

Shows only highlighted passages from that note.

Tapping a highlight must:

- switch back to Full Note
- scroll to the original highlighted text

---

## 5. Global Highlights

Highlights tab shows highlighted passages from all notes.

Each item includes:

- Highlight color
- Highlighted text
- Source note
- Date or section

Filters:

- All
- Yellow
- Green
- Blue
- Pink
- Purple
- Orange

Tap highlight → open original note at that passage.

---

## 6. Search

Search across:

- Note titles
- Note body text
- Highlighted text

Results should separate:

- Notes
- Highlights

Tap result → open the matching note or passage.

---

## 7. Empty / Feedback States

Required states:

- No notes yet
- No highlights yet
- No search results
- Delete confirmation
- Highlight applied
- Highlight removed
- Note created

Use lightweight toast feedback where possible.

---

## 8. Storage

MVP is local-first.

Requirements:

- Works offline
- Notes persist after closing app
- Autosave edits
- Highlights persist correctly
- Search works offline

No account or cloud sync required.

---

## 9. MVP Data

### Note

- id
- title
- content
- createdAt
- updatedAt
- isPinned

### Highlight

- id
- noteId
- text
- color
- position
- createdAt

Prefer storing highlights as rich-text marks rather than only raw character positions.

---

## 10. Not Included in MVP

Do not build yet:

- Login/accounts
- Cloud sync
- Folders
- Tags
- Collaboration
- AI
- Handwriting
- PDF annotation
- Reminders
- Templates
- Web/desktop app
- Advanced themes

---

## MVP Definition

The app is ready when a user can:

1. Create a note.
2. Write and format text.
3. Highlight text with different colors.
4. Review highlights inside a note.
5. Review highlights across all notes.
6. Filter highlights by color.
7. Search notes and highlights.
8. Jump directly back to highlighted content.
9. Use the app fully offline.

The primary product focus is:

**Make important text easier to find and review later.**
