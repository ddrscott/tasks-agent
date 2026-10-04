import { useState } from "react";
import { BASE } from "./base";
import { Popover } from "./Board";

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The running version (the build's commit and date). Click it for the newest lines of CHANGELOG.md. */
function Version() {
  const [open, setOpen] = useState(false);
  const { sha, builtAt, changes } = __BUILD__;
  return (
    <span className="anchor version">
      <button
        className="version-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={`Built ${new Date(builtAt).toLocaleString()}. Click for recent changes`}
      >
        <span className="version-mark" aria-hidden="true">$</span>{sha} · {day(builtAt)}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="changes">
            <h2 className="h">WHATS_NEW</h2>
            {changes.length === 0 && <p>No changes written up yet.</p>}
            {changes.map((c) => (
              <section key={c.date}>
                <h3>{day(c.date)}</h3>
                <ul>{c.items.map((t) => <li key={t}>{t}</li>)}</ul>
              </section>
            ))}
            <p className="changes-foot">version {sha}, built {new Date(builtAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
          </div>
        </Popover>
      )}
    </span>
  );
}

/** The small footer on every page. */
export function Footer() {
  return (
    <footer className="site-footer">
      made with <span role="img" aria-label="love">❤️</span> by{" "}
      <a href="https://askscottpierce.com" target="_blank" rel="noreferrer">Scott Pierce</a>
      <span aria-hidden="true"> · </span><a href={`${BASE}/terms`}>terms</a>
      <span aria-hidden="true"> · </span><a href={`${BASE}/privacy`}>privacy</a>
      <span aria-hidden="true"> · </span><Version />
    </footer>
  );
}
