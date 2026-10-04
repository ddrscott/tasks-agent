// Keep dialogs above the on-screen keyboard.
//
// Android Chrome shrinks the page when the keyboard opens (index.html asks for that with
// `interactive-widget=resizes-content`), so `100dvh` is already the space above the keys. iOS
// Safari doesn't: the page keeps its height and the keyboard covers the bottom of it. The visual
// viewport is the part you can actually see on both, so the stylesheet sizes phone dialogs from
// `--vvh` (its height) and `--vvt` (how far it has scrolled down the page).

export function watchViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;

  // The field being typed in, when it sits inside something that scrolls.
  const reveal = () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.closest("dialog") && el.matches("input, textarea, select")) {
      el.scrollIntoView({ block: "nearest" });
    }
  };

  let frame = 0;
  const sync = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
      reveal();
    });
  };

  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  // The keyboard is often already up when focus moves to the next field, so nothing resizes.
  document.addEventListener("focusin", () => setTimeout(reveal, 50));
  sync();
}
