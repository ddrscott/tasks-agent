import { useState } from "react";
import { BASE } from "./base";
import { Popover } from "./Board";

const CHANGELOG_URL = "https://github.com/ddrscott/tasks-agent/blob/main/CHANGELOG.md";

const short = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** A changelog day (YYYY-MM-DD) has no time zone: noon keeps it on that day everywhere. */
const day = (date: string) => short(new Date(`${date}T12:00:00`));

/** A changelog line, with `code` spans shown as code. Everything else is plain text. */
function Line({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/**
 * The running version: the release from package.json when there is one, and the build's commit.
 * Click it for the newest entries of CHANGELOG.md.
 */
function Version() {
  const [open, setOpen] = useState(false);
  const { version, sha, builtAt, changes, more } = __BUILD__;
  const built = new Date(builtAt);
  return (
    <span className="anchor version">
      <button
        className="version-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={`Built ${built.toLocaleString()}. Click for recent changes`}
      >
        <span className="version-mark" aria-hidden="true">$</span>
        {version ? `v${version} · ${sha}` : `${sha} · ${short(built)}`}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="changes">
            <h2 className="h">WHATS_NEW</h2>
            {changes.length === 0 && <p>No changes written up yet.</p>}
            {changes.map((r) => (
              <section key={r.name}>
                <h3>{/^\d/.test(r.name) ? `v${r.name}` : r.name}{r.date && <span>{day(r.date)}</span>}</h3>
                {r.groups.map((g) => (
                  <div key={g.kind} className="changes-group">
                    <h4>{g.kind}</h4>
                    <ul>{g.items.map((t) => <li key={t}><Line text={t} /></li>)}</ul>
                  </div>
                ))}
              </section>
            ))}
            <p className="changes-foot">
              {version ? `v${version}, ` : ""}commit {sha}, built {built.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              {" · "}<a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer">{more > 0 ? `${more} more in the changelog` : "full changelog"}</a>
            </p>
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
