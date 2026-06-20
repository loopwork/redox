# redox — User Guide

redox is a collaborative writing app. You and other people can open the same document and edit it together in real time, see each other's cursors, and leave colored highlights with side notes.

What makes it a little different: **your documents are real markdown files.** They live in a folder on the server (a git repository), so every document has a plain-text file and a full edit history — nothing is locked inside a database.

> Heads up: redox has **no sign-in**. Anyone who can reach the server and has a document's link can open and edit it. Treat it like a shared whiteboard on a trusted network.

---

## The layout

When you open redox you'll see three areas:

- **Left — Files.** Your document list, a search box, and your name at the bottom.
- **Middle — the editor.** The document you're editing, with a small toolbar on top.
- **Right — Annotations.** The side notes for the current document (empty until you add one).

Pick a file on the left, or create one, to start.

---

## Working with documents

**Create.** Click **+ New** (top-left), type a name, and press Enter. The document opens right away. The name you type becomes the file name, so keep it to something a file name can hold — odd characters are cleaned up automatically.

**Open.** Click any file in the list.

**Rename.** Hover a file (or select it) and click the **✎** (pencil). Renaming also renames the underlying file.

**Delete.** Hover a file and click the **✕**. You'll be asked to confirm. Deleting removes the file.

**Saving.** There's nothing to save — your changes are written automatically a moment after you stop typing. The **✓ Saved** label in the header is a reminder that documents persist on their own.

---

## Writing and formatting

The editor is rich text: you see the formatted result, not markdown symbols. You format the same way you would in most modern editors — with keyboard shortcuts and with markdown-style typing shortcuts:

- **Bold** / *italic* — `⌘B` / `⌘I` (Ctrl on Windows/Linux), or type `**bold**` and `*italic*`.
- **Headings** — start a line with `# `, `## `, or `### `.
- **Lists** — start a line with `- ` (bullet), `1. ` (numbered), or `- [ ] ` (a checkbox task).
- **Quote** — start a line with `> `.
- **Inline code** — wrap text in backticks: `` `code` ``.
- **Code block** — start a line with ```` ``` ````.
- **Link** — paste or type a URL.
- Strikethrough and underline are supported too.

You can also **highlight** text in a color — that's the toolbar above the document, and it's how you attach side notes (next section).

---

## Highlights and side notes

This is redox's signature feature: attach a note to a specific piece of text.

1. **Select** the text you want to annotate.
2. In the toolbar, click a **color dot** — Lavender, Yellow, Green, or Pink. The text gets highlighted in that color.
3. A **card appears on the right**, lined up next to your highlight (like a Google Docs comment). It shows your name and the time.
4. Type your note in the card. Add follow-ups in the **reply** box to build a little conversation.
5. Click the quoted text in a card to **jump** to that spot in the document.
6. Remove a note with the **✕** on its card.

Highlights and notes are saved with the document and shared with everyone viewing it. (The **Voice** and **Task** options on a card are placeholders — they're coming later.)

If two people annotate the *exact same words* at the same instant, a note can shift position for a moment and then settle — harmless while you're working.

---

## Tables

redox displays GFM (pipe) tables, with formatting inside cells, and preserves them through edits and reloads.

There isn't a "insert table" button yet. The way to add a table today is to put standard markdown table syntax into the document's file:

```
| Name  | Role     |
| ----- | -------- |
| Ada   | author   |
| Linus | reviewer |
```

Once it's in the document, redox renders and round-trips it.

---

## Find a file fast (⌘K)

Press **⌘K** (Ctrl+K) anywhere to jump to the file search. Start typing to filter the list, then press **Enter** to open the top match — type, Enter, and you're there. **Esc** clears the search.

---

## Working together

Open the same document on two devices (or send the link to someone) and you're editing together live:

- Edits appear for everyone within moments.
- You see each other's **cursors**, each labeled with a name and color.
- Highlights, side notes, and replies are shared too.

Your name and color are picked for you the first time you use redox (shown at the bottom-left). They identify your cursor and are recorded as the author of your edits in the document's history.

---

## Sharing a document

A document's **URL is its identity.** Look at the address bar while a document is open — the part after `#` is the file. Copy the whole URL and send it; whoever opens it lands on the same document and joins the live session.

Because the link points at a specific file, bookmarks and shared links keep working as long as the file exists (renaming a file changes its link).

---

## Good to know

- **Autosave, always.** Changes persist automatically; there's no save button and no "unsaved changes" trap.
- **No accounts, open access.** Anyone with the link can edit. Use it accordingly.
- **Your docs are files.** Each document is a markdown file in a git repo on the server, with full history — easy to back up, read, or edit outside the app.
