# Card editor: notes grow to fit their content, dialog capped at the viewport

## Problem
When a card is opened, the notes textarea is a fixed size (`min-height: 110px`, `resize: vertical`),
so longer notes need scrolling inside a small box even when there's plenty of screen left.

## Acceptance Criteria
- Opening a card sizes the notes textarea to its content, and it keeps resizing as you type or paste.
- The dialog never gets taller than the viewport. Once it would, the notes area stops growing and
  scrolls inside itself (or the dialog body scrolls), and the footer buttons (save, mark done, delete, etc.)
  stay visible without scrolling.
- Short or empty notes still show the current minimum height (about 110px).
- Works on phone-sized viewports and with the on-screen keyboard open (use `dvh`, not `vh`).
- Attachments and the other fields in the dialog still lay out correctly.

## Relevant Files
- `src/client/CardEditor.tsx`: the notes `<textarea className="field">` (around line 56)
- `src/client/styles.css`: `dialog` (~551), `.dialog-body` (~560), `.dialog-body textarea` (~563), `.dialog-foot` (~565)

## Constraints
- Prefer CSS (`field-sizing: content` with a `max-height`, and the dialog as a flex column with `max-height: calc(100dvh - margin)`,
  where the body gets `overflow: auto; min-height: 0` and the foot is `flex: none`). Fall back to a small JS autosize on input only if
  `field-sizing` isn't supported by the browsers that matter.
- Keep square corners and the existing dialog look.
