import { useState } from "react";
import { Popover } from "./Board";
import { IconPalette } from "./icons";
import { applyTheme, THEMES } from "./themes";

/** Hovering a theme previews it; clicking keeps it. */
export function ThemePicker({ current, onPick, open, setOpen }: { current: string; onPick(id: string): void; open: boolean; setOpen(o: boolean): void }) {
  const [, force] = useState(0);
  const close = () => { applyTheme(current); setOpen(false); };
  return (
    <div className="anchor">
      <button className="btn icon" title="Theme (t)" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}><IconPalette /></button>
      {open && (
        <Popover onClose={close}>
          <div className="theme-grid" role="radiogroup" aria-label="Theme" onMouseLeave={() => applyTheme(current)}>
            <h2 className="h">THEME</h2>
            {THEMES.map((t) => (
              <button
                key={t.id} className="theme-opt" role="radio" aria-checked={current === t.id}
                onMouseEnter={() => applyTheme(t.id)} onFocus={() => applyTheme(t.id)}
                onClick={() => { onPick(t.id); applyTheme(t.id); setOpen(false); force((n) => n + 1); }}
              >
                <span className="swatch" style={{ background: t.swatch[0] }}>
                  <i style={{ background: t.swatch[1] }} />
                  <i style={{ background: t.swatch[2] }} />
                  <i style={{ background: t.swatch[3] }} />
                </span>
                <b>{t.name}</b>
                <small>{t.blurb}</small>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
