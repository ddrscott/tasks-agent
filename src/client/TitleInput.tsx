// A card's title in the dialogs. It's a one-line value in a textarea, so a long title wraps and
// shows in full on a narrow screen instead of scrolling sideways out of view.

import { useLayoutEffect, useRef } from "react";

type Props = {
  value: string;
  onChange(value: string): void;
  onEnter(): void;
  onBlur?(): void;
  placeholder?: string;
  autoFocus?: boolean;
};

export function TitleInput({ value, onChange, onEnter, onBlur, placeholder, autoFocus }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // CSS `field-sizing: content` grows it to fit. Where that's missing, size it by hand.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref} className="field title-input" rows={1} value={value} maxLength={200} aria-label="Title"
      placeholder={placeholder} autoFocus={autoFocus} enterKeyHint="done" onBlur={onBlur}
      // A title is one line: a pasted line break becomes a space.
      onChange={(e) => onChange(e.target.value.replace(/\s*\n\s*/g, " "))}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }}
    />
  );
}
