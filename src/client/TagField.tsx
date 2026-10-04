// The Tags field in the card dialogs: a plain text box of space-separated tags, with the tags already
// used on the board offered above it. Typing narrows them to what's being typed; tapping one puts it
// in the field. The chips sit above the input so the on-screen keyboard can't cover them.

import { useRef } from "react";
import { cleanTag } from "../shared";

type Props = {
  value: string;
  onChange(value: string): void;
  /** Tags on the board, most used first. */
  known: string[];
  onEnter(): void;
};

const MAX_SHOWN = 12;

/** The tags already in the field, and the one still being typed (empty after a space). */
function parse(value: string) {
  const words = value.split(/[\s,]+/);
  const typing = /[\s,]$/.test(value) ? "" : cleanTag(words.pop() ?? "");
  return { have: new Set(words.map(cleanTag).filter(Boolean)), typing };
}

export function suggest(value: string, known: string[]): string[] {
  const { have, typing } = parse(value);
  const open = known.filter((t) => !have.has(t) && t !== typing);
  if (!typing) return open.slice(0, MAX_SHOWN);
  // Tags that start with what's typed come before tags that only contain it.
  return [...open.filter((t) => t.startsWith(typing)), ...open.filter((t) => !t.startsWith(typing) && t.includes(typing))].slice(0, MAX_SHOWN);
}

export function TagField({ value, onChange, known, onEnter }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const options = suggest(value, known);

  function pick(tag: string) {
    // Swap the half-typed word for the whole tag, and leave a space so the next one can start.
    const kept = /[\s,]$/.test(value) || !value ? value : value.replace(/[^\s,]*$/, "");
    onChange(`${kept}${tag} `);
    input.current?.focus();
  }

  return (
    <div className="tag-field">
      <label htmlFor="tags-input">Tags</label>
      {options.length > 0 && (
        <div className="tag-suggest" role="group" aria-label="Tags you've used">
          {options.map((t) => (
            // Keep focus in the input on press, so the keyboard doesn't drop and come back.
            <button key={t} type="button" className="chip tag" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(t)}>#{t}</button>
          ))}
        </div>
      )}
      <input
        id="tags-input" ref={input} className="field mono" value={value} placeholder="agent client"
        spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" enterKeyHint="done"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onEnter(); }
          // Tab takes the first suggestion while a tag is half typed.
          else if (e.key === "Tab" && !e.shiftKey && options.length && value && !/[\s,]$/.test(value)) { e.preventDefault(); pick(options[0]); }
        }}
      />
    </div>
  );
}
