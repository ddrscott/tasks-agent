import { BASE } from "./base";

// What a board with no cards shows above its lanes. An empty kanban says nothing about agents,
// which are the reason to use this one, so the three steps to put an agent to work are spelled
// out here with a link to the Connect page. It's gone once the board has a card. An encrypted
// board never shows it: agents can't reach one.

export function FirstRun({ onConnect }: { onConnect(): void }) {
  return (
    <section className="first-run" aria-labelledby="first-run-h">
      <h2 className="h" id="first-run-h">START_HERE</h2>
      <p className="first-run-lede">This board is empty. Here's how to put an agent to work on it.</p>
      <ol>
        <li>
          <b>Connect an agent</b>
          <span>Give Claude, ChatGPT, Claude Code, Cursor, or any other MCP client this board's URL. Then it can read and change your cards.</span>
          {/* A real link, so it can be opened in a new tab; a plain click stays in the app. */}
          <a className="btn primary" href={`${BASE}/connect`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onConnect(); }}>
            Connect an agent
          </a>
        </li>
        <li>
          <b>Tag a card <code>#agent</code></b>
          <span>The tag marks work an agent owns. It's how an agent finds its cards and leaves yours alone.</span>
        </li>
        <li>
          <b>Answer its questions here</b>
          <span>When an agent needs a decision, its question shows on the card with a button for each option. One tap answers it.</span>
        </li>
      </ol>
      <p className="first-run-foot">Or just add a card. This goes away once the board has one.</p>
    </section>
  );
}
