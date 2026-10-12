# SiftNote Decisions

## Local-first
User data is stored locally. No backend, account, or cloud sync for the MVP.

## Navigation
Use Expo Router.

## Storage
Use SQLite as the persistent source of truth.

## Editor
Use the existing bundled offline Tiptap/ProseMirror WebView editor.
Highlights use stable IDs rather than raw offsets as their identity.

## Platform
Android is the MVP target.

## Native changes
Do not add native dependencies or trigger a development-app rebuild without
asking the user first.