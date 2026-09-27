import { BASE } from "./base";

/** The small footer on every page. */
export function Footer() {
  return (
    <footer className="site-footer">
      made with <span role="img" aria-label="love">❤️</span> by{" "}
      <a href="https://askscottpierce.com" target="_blank" rel="noreferrer">Scott Pierce</a>
      <span aria-hidden="true"> · </span><a href={`${BASE}/terms`}>terms</a>
      <span aria-hidden="true"> · </span><a href={`${BASE}/privacy`}>privacy</a>
    </footer>
  );
}
