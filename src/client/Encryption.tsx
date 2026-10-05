import { useEffect, useRef, useState } from "react";
import { createBoardKey, keyProof, MIN_PASSPHRASE, PBES2_COUNT, rewrapBoardKey, unlockBoardKey, type BoardKey, type SealInfo } from "../sealed";
import type { Board } from "../shared";
import { plainWholeBoard, sealWholeBoard } from "./migrate";
import { Footer } from "./Footer";
import { IconClose } from "./icons";
import { refreshMembers, useBoardMembers } from "./Members";
import { MODAL, useModal } from "./modal";
import { forgetKey, recallKey, rememberKey, Vault } from "./vault";

// End-to-end encryption screens: the unlock screen an encrypted board opens to, and the
// Encryption dialog (user menu) that turns it on, changes the passphrase, exports an
// encrypted backup, and turns it off. The passphrase never leaves this tab.

export type EncryptionStub = {
  enableEncryption(input: { kid: string; envelope: string; board: Board; proof: string }): Promise<void>;
  beginDisable(input: { proof: string }): Promise<void>;
  disableEncryption(input: { board: Board; proof: string }): Promise<void>;
  changePassphrase(input: { previous: string; envelope: string; proof: string }): Promise<void>;
  ensureKeyCheck(proof: string): Promise<boolean>;
  resetEncryptedBoard(): Promise<void>;
};

const RESET_WORD = "START OVER";

// Password managers and browsers find a passphrase by the markup: a <form>, type="password"
// with autocomplete current-password or new-password, and a username field in the same form
// to file it under. The account email plays that part here.
const RULES = { passwordrules: `minlength: ${MIN_PASSPHRASE};` }; // Safari's generator reads this

function AccountField({ email }: { email: string }) {
  return <input className="sr-only" type="email" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />;
}

/** Keeps password managers from filling or saving a field that isn't a secret. */
const NOT_A_SECRET = { autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" };

export function Unlock({ seal, userId, email, onUnlocked, onReset, onSignOut }: {
  seal: SealInfo; userId: string; email: string;
  onUnlocked(k: BoardKey): void; onReset(): Promise<void>; onSignOut(): void;
}) {
  const [pass, setPass] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [confirm, setConfirm] = useState("");

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      const k = await unlockBoardKey(seal, pass);
      if (remember) await rememberKey(userId, k);
      onUnlocked(k);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <h1 className="wordmark">tasks<span>.</span></h1>
        <p>This board is end-to-end encrypted. Enter your passphrase to open it on this device.</p>
        <form onSubmit={unlock} action="#" method="post">
          <AccountField email={email} />
          <input
            className="field" type="password" id="passphrase" name="passphrase" autoFocus autoComplete="current-password" value={pass}
            placeholder="Passphrase" aria-label="Passphrase" onChange={(e) => setPass(e.target.value)}
          />
          <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
          <button className="btn primary" disabled={!pass || busy}>{busy ? "Unlocking…" : "Unlock"}</button>
          {error && <div className="login-error" role="alert">{error}</div>}
        </form>
        <div className="login-note">Signed in as <b>{email}</b>. Nobody else, including this app's server, can read the board without the passphrase.</div>
        {!forgot ? (
          <div className="login-foot">
            <button className="linkish" onClick={() => setForgot(true)}>Forgot the passphrase?</button>
            <button className="linkish" onClick={onSignOut}>Sign out</button>
          </div>
        ) : (
          <div className="forgot">
            <p>Without the passphrase, nobody can open this board. That's the point, and it means it can't be recovered. You can throw it away, files included, and start over with an empty board.</p>
            <input className="field" type="text" name="confirm-reset" {...NOT_A_SECRET} value={confirm} placeholder={`Type ${RESET_WORD}`} aria-label={`Type ${RESET_WORD} to confirm`} onChange={(e) => setConfirm(e.target.value)} />
            <div className="login-foot">
              <button className="linkish" onClick={() => { setForgot(false); setConfirm(""); }}>Never mind</button>
              <button className="btn danger" disabled={confirm.trim().toUpperCase() !== RESET_WORD || busy} onClick={() => { setBusy(true); void onReset().catch((e) => { setError((e as Error).message); setBusy(false); }); }}>
                Erase and start over
              </button>
            </div>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}

type DialogProps = {
  /** The board as the UI sees it: decrypted when it's encrypted. */
  view: Board;
  /** The board as the server holds it, for the encrypted backup. */
  raw: Board;
  vault: Vault | null;
  userId: string;
  /** The signed-in email, as the "username" password managers file the passphrase under. */
  email: string;
  stub: EncryptionStub;
  onEnabled(k: BoardKey): void;
  /** Called just before this tab turns encryption off (true) or when that fails (false), so the plain board that follows isn't taken for a downgrade. */
  onDisabling(active: boolean): void;
  onDisabled(): void;
  onClose(): void;
  /** Close this and open Members: a shared board has to be un-shared there before it can be encrypted. */
  onMembers(): void;
  say(text: string): void;
};

export function EncryptionDialog({ view, raw, vault, userId, email, stub, onEnabled, onDisabling, onDisabled, onClose, onMembers, say }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useModal(ref);
  return (
    <dialog ref={ref} {...MODAL} aria-label="End-to-end encryption" className="enc-dialog" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="dialog-body">
        <h2 className="h">END_TO_END_ENCRYPTION</h2>
        {view.sealed && vault
          ? <Manage view={view} raw={raw} vault={vault} userId={userId} email={email} stub={stub} onDisabling={onDisabling} onDisabled={onDisabled} say={say} onClose={onClose} />
          : <TurnOn view={view} userId={userId} email={email} stub={stub} onEnabled={onEnabled} say={say} onClose={onClose} onMembers={onMembers} />}
      </div>
      <div className="dialog-foot">
        <span className="spacer" />
        <button className="btn" onClick={onClose}><IconClose />Close</button>
      </div>
    </dialog>
  );
}

function TurnOn({ view, userId, email, stub, onEnabled, say, onClose, onMembers }: Pick<DialogProps, "view" | "userId" | "email" | "stub" | "onEnabled" | "say" | "onClose" | "onMembers">) {
  // A board with members or pending invites can't be encrypted (// TEAM_BOARDS): the server
  // refuses it. Say so here, before anyone types a passphrase, instead of after.
  const shared = useBoardMembers(userId);
  useEffect(() => { void refreshMembers(userId); }, [userId]);
  const on = shared.members.filter((m) => m.status === "accepted").length;
  const waiting = shared.members.length - on;
  const isShared = shared.members.length > 0;
  // Until the members list has answered, nobody knows whether this board is shared, so the fields wait for it.
  const off = isShared || shared.state === "loading";
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [remember, setRemember] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const short = pass.length > 0 && pass.length < MIN_PASSPHRASE;
  const mismatch = again.length > 0 && again !== pass;
  const ready = pass.length >= MIN_PASSPHRASE && again === pass && understood && !busy && !off;

  async function go() {
    if (!ready) return;
    setError(null);
    try {
      setBusy("Making your key…");
      const { boardKey, envelope } = await createBoardKey(pass);
      const vault = new Vault(boardKey);
      const sealed = await sealWholeBoard(view, vault, (d, t) => setBusy(t ? `Encrypting files ${d} of ${t}…` : "Encrypting…"));
      setBusy("Saving…");
      await stub.enableEncryption({ kid: boardKey.kid, envelope, board: sealed, proof: await keyProof(boardKey) });
      if (remember) await rememberKey(userId, boardKey);
      onEnabled(boardKey);
      say("Your board is end-to-end encrypted now.");
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      // Someone was invited between this dialog opening and the click. The server's refusal carries a code.
      if (message.includes("[board_shared]")) {
        void refreshMembers(userId);
        setError("This board is shared, so it can't be encrypted. Remove its members and revoke its pending invites in Members first.");
      } else setError(message);
      setBusy(null);
    }
  }

  return (
    <>
      {isShared && (
        <div className="enc-shared" role="note">
          <p>
            <b>This board is shared, so it can't be encrypted yet.</b>{" "}
            {on > 0 && <>{on} {on === 1 ? "person is" : "people are"} on it</>}{on > 0 && waiting > 0 && " and "}
            {waiting > 0 && <>{waiting} {waiting === 1 ? "invite is" : "invites are"} pending</>}.
            {" "}An encrypted board is closed to everyone but you: the server can't serve members a board it can't read.
          </p>
          <p>Remove the members and revoke the pending invites in Members first. Nothing below works until then.</p>
          <div className="enc-actions"><button type="button" className="btn primary" onClick={onMembers}>Open Members</button></div>
        </div>
      )}
      <p>
        With a passphrase, your board is encrypted in this browser before it's sent. The server stores only
        ciphertext: lane names, cards, notes, due dates, files and their names, and assistant messages. Any device
        can open it with the passphrase, and nobody can without it, including whoever runs this app.
      </p>
      <ul className="enc-list">
        <li>The assistant in this tab (Needle) keeps working. The cloud assistant can't read an encrypted board, so it's off.</li>
        <li>Outside agents (MCP) can't read or change it.</li>
        <li>It can't be shared. Members is off while the board is encrypted, and a board that already has members or pending invites can't be encrypted.</li>
        <li>Search runs in your browser and matches words, not meaning.</li>
        <li>Undo history and the chat are cleared, so no plain copy is left behind.</li>
        <li><b>If you forget the passphrase, the board can't be recovered.</b></li>
      </ul>
      <form className="enc-form" action="#" method="post" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <AccountField email={email} />
      {isShared && <p className="enc-off">The fields below are off while the board is shared.</p>}
      <fieldset className="enc-fields" disabled={off}>
      <label>
        Passphrase ({MIN_PASSPHRASE}+ characters; a few random words works well)
        <input className="field" type="password" id="new-passphrase" name="new-passphrase" autoComplete="new-password" minLength={MIN_PASSPHRASE} {...RULES} value={pass} disabled={off} onChange={(e) => setPass(e.target.value)} />
      </label>
      {short && <div className="login-error">At least {MIN_PASSPHRASE} characters.</div>}
      <label>
        Same passphrase again
        <input className="field" type="password" id="confirm-passphrase" name="confirm-passphrase" autoComplete="new-password" minLength={MIN_PASSPHRASE} {...RULES} value={again} disabled={off} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {mismatch && <div className="login-error">Those don't match.</div>}
      <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device</label>
      <label className="check"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand a forgotten passphrase means a lost board</label>
      </fieldset>
      {error && <div className="login-error" role="alert">{error}</div>}
      <div className="enc-actions">
        <button type="submit" className="btn primary" disabled={!ready}>{busy ?? "Encrypt my board"}</button>
      </div>
      </form>
    </>
  );
}

function Manage({ view, raw, vault, userId, email, stub, onDisabling, onDisabled, say, onClose }: Pick<DialogProps, "view" | "raw" | "userId" | "email" | "stub" | "onDisabling" | "onDisabled" | "say" | "onClose"> & { vault: Vault }) {
  const seal = raw.sealed!;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  useEffect(() => { void recallKey(userId, seal.kid).then((k) => setRemembered(!!k)); }, [userId, seal.kid]);

  async function change() {
    setError(null);
    if (next.length < MIN_PASSPHRASE) return setError(`The new passphrase needs at least ${MIN_PASSPHRASE} characters.`);
    if (next !== again) return setError("The new passphrases don't match.");
    try {
      setBusy("Changing…");
      const envelope = await rewrapBoardKey(seal, current, next);
      await stub.changePassphrase({ previous: seal.envelope, envelope, proof: await keyProof(vault.key) });
      setCurrent(""); setNext(""); setAgain("");
      say("Passphrase changed. Other devices keep working until they're locked; after that they need the new one.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function backup() {
    const body = JSON.stringify({ format: "tasks-encrypted-board", v: 1, exportedAt: new Date().toISOString(), board: raw }, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    a.download = `tasks-encrypted-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function turnOff() {
    setError(null);
    try {
      const proof = await keyProof(vault.key);
      await stub.beginDisable({ proof }); // opens the window for the plain re-uploads below
      const plain = await plainWholeBoard(view, vault.key, (d, t) => setBusy(t ? `Decrypting files ${d} of ${t}…` : "Decrypting…"));
      setBusy("Saving…");
      onDisabling(true); // before the swap lands, so no tab warns about this change
      await stub.disableEncryption({ board: plain, proof });
      await forgetKey(userId);
      onDisabled();
      say("Encryption is off. The server can read your board again.");
      onClose();
    } catch (e) {
      onDisabling(false);
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <>
      <p className="enc-on"><span className="prompt">$</span> Encrypted since {new Date(seal.since).toLocaleDateString(undefined, { dateStyle: "medium" })}. Key <code>{seal.kid}</code>, wrapped with PBES2-HS512+A256KW ({PBES2_COUNT.toLocaleString()} rounds); fields are A256GCM JWE.</p>

      <p>An encrypted board can't be shared, so Members is off until encryption is. The server can't serve anyone else a board it can't read.</p>

      <h3 className="h">CHANGE_PASSPHRASE</h3>
      <form className="enc-form" action="#" method="post" onSubmit={(e) => { e.preventDefault(); void change(); }}>
        <AccountField email={email} />
        <input className="field" type="password" id="current-passphrase" name="current-passphrase" autoComplete="current-password" placeholder="Current passphrase" aria-label="Current passphrase" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="field" type="password" id="new-passphrase" name="new-passphrase" autoComplete="new-password" minLength={MIN_PASSPHRASE} {...RULES} placeholder={`New passphrase (${MIN_PASSPHRASE}+ characters)`} aria-label="New passphrase" value={next} onChange={(e) => setNext(e.target.value)} />
        <input className="field" type="password" id="confirm-passphrase" name="confirm-passphrase" autoComplete="new-password" minLength={MIN_PASSPHRASE} {...RULES} placeholder="New passphrase again" aria-label="New passphrase again" value={again} onChange={(e) => setAgain(e.target.value)} />
        <div className="enc-actions">
          <button type="submit" className="btn" disabled={!current || !next || !!busy}>{busy === "Changing…" ? busy : "Change passphrase"}</button>
        </div>
      </form>

      <h3 className="h">BACKUP</h3>
      <p>The board exactly as the server holds it, still encrypted. <code>scripts/decrypt-board.mjs</code> or any JOSE library opens it with the passphrase. Files aren't in it; download those from their cards.</p>
      <div className="enc-actions"><button className="btn" onClick={backup}>Download encrypted backup</button></div>

      <h3 className="h">THIS_DEVICE</h3>
      <p>{remembered ? "This browser remembers the key, so it opens without the passphrase." : "This browser asks for the passphrase each time the board opens."}</p>
      {remembered && <div className="enc-actions"><button className="btn" onClick={() => void forgetKey(userId).then(() => { setRemembered(false); say("This device will ask for the passphrase next time."); })}>Forget on this device</button></div>}

      <h3 className="h">TURN_OFF</h3>
      {!offOpen ? (
        <div className="enc-actions"><button className="btn danger" onClick={() => setOffOpen(true)}>Turn off encryption…</button></div>
      ) : (
        <>
          <p>This decrypts everything in this tab and sends it back as plain text, so the server, the cloud assistant, search, and outside agents can read it again. Undo history and the chat are cleared.</p>
          <div className="enc-actions">
            <button className="btn" onClick={() => setOffOpen(false)}>Keep it encrypted</button>
            <button className="btn danger" disabled={!!busy} onClick={() => void turnOff()}>{busy && busy !== "Changing…" ? busy : "Decrypt my board"}</button>
          </div>
        </>
      )}
      {error && <div className="login-error" role="alert">{error}</div>}
    </>
  );
}

/**
 * Shown when a board this device knew as encrypted arrives unencrypted and no tab here turned
 * it off: someone with the session reset it, or a server downgraded it. Until the person
 * chooses, nothing they type goes anywhere.
 */
export function Downgraded({ email, onEncrypt, onAccept }: { email: string; onEncrypt(): void; onAccept(): void }) {
  return (
    <div className="login">
      <div className="login-card">
        <h1 className="wordmark">tasks<span>.</span></h1>
        <p><b>This board isn't encrypted anymore.</b> It was end-to-end encrypted on this device, and it was turned off or reset somewhere else, not here.</p>
        <p>If that wasn't you, someone else could sign in as <b>{email}</b>, and anyone who can read that inbox can. Secure the email account first. Anything you add here now can be read by the server.</p>
        <div className="login-foot">
          <button className="linkish" onClick={onAccept}>Continue without encryption</button>
          <button className="btn primary" onClick={onEncrypt}>Encrypt it again</button>
        </div>
      </div>
      <Footer />
    </div>
  );
}
