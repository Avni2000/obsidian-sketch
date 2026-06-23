# Pencil

An infinite whiteboard for Obsidian. Draw and handwrite with a stylus, mouse, or finger — saved as `.pencil` files right inside your vault.

Pencil is an opinionated, single-slice take on handwriting in Obsidian. The existing whiteboard apps are heavy and loaded with features most people never touch. Pencil does one thing well: a fast, infinite canvas that feels like pen on paper, and nothing more.

## What you get

- **Infinite canvas** — pan and zoom endlessly; your view position is saved with the note.
- **Stylus-first, pressure-aware** — Apple Pencil and other pens get real pressure-thickness variation. Toggle it off anytime.
- **Mouse and finger too** — no stylus? Draw with a mouse or finger. Pressure is simply held constant.
- **Palm rejection** — once you've used a pen, finger touches become panning so you can rest your hand. Two-finger pinch to zoom.
- **Eraser** — stroke-level erase by dragging over what you don't want.
- **Select & move** — box-select strokes and drag them around.
- **Colors & sizes** — 8 built-in colors plus your own custom palette (native color picker, long-press or right-click to remove). Four stroke widths.
- **Undo / redo** — full history (`⌘Z` / `⌘⇧Z`, or `Ctrl`).
- **Saved as vault files** — each whiteboard is a `.pencil` JSON file, versioned and synced with the rest of your notes.
- **Works everywhere** — desktop, iPad, and mobile. The toolbar adapts: icons on desktop, short text labels on mobile.

## Tools & shortcuts

| Tool      | Key | Notes                                   |
| --------- | --- | --------------------------------------- |
| Pencil    | `P` | Draw. Pressure varies with pen input.  |
| Eraser    | `E` | Drag over strokes to delete them.       |
| Select    | `V` | Box-select, then drag to move.          |
| Pan       | `H` | Drag to pan (also: middle/right mouse).|

Other shortcuts: `⌘/Ctrl+Z` undo, `⌘/Ctrl+Shift+Z` redo, `Delete`/`Backspace` removes the current selection.

Scroll to pan; `⌘/Ctrl` + scroll (or pinch on touch) to zoom. Use **Fit** to frame everything you've drawn.

## Creating a whiteboard

Click the pencil icon in the ribbon, or run the **Create new whiteboard** command. A `Whiteboard.pencil` file is created in your active folder and opened immediately (subsequent ones are numbered `Whiteboard 1`, `Whiteboard 2`, …).

## Notes

- Pressure sensitivity is on by default for pen input. Turn it off from the toolbar if you want uniform strokes.
- `.pencil` files are plain JSON, so they're diffable, sync-friendly, and inspectable.
