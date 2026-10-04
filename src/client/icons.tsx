// A handful of stroke icons, inline so the page needs no icon font.
const P = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const svg = (d: React.ReactNode) => () => <svg viewBox="0 0 24 24" aria-hidden="true" {...P}>{d}</svg>;

export const IconPlus = svg(<path d="M12 5v14M5 12h14" />);
export const IconCheck = svg(<path d="M20 6 9 17l-5-5" />);
export const IconUndo = svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>);
export const IconRedo = svg(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></>);
export const IconPalette = svg(<><circle cx="13.5" cy="6.5" r="1.2" /><circle cx="17.5" cy="10.5" r="1.2" /><circle cx="8.5" cy="7.5" r="1.2" /><circle cx="6.5" cy="12.5" r="1.2" /><path d="M12 2a10 10 0 1 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7h2A5.6 5.6 0 0 0 22 11c0-5-4.5-9-10-9z" /></>);
export const IconChat = svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const IconUser = svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IconSessions = svg(<><rect x="3" y="4" width="18" height="16" rx="1" /><path d="m7 10 3 2.5L7 15M13 15h4" /></>);
export const IconDots = svg(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>);
export const IconClose = svg(<path d="M18 6 6 18M6 6l12 12" />);
export const IconCalendar = svg(<><rect x="3" y="4" width="18" height="18" rx="1" /><path d="M16 2v4M8 2v4M3 10h18" /></>);
export const IconNotes = svg(<path d="M4 6h16M4 12h16M4 18h10" />);
export const IconSend = svg(<path d="M5 12h14M13 6l6 6-6 6" />);
export const IconStop = svg(<rect x="6" y="6" width="12" height="12" />);
export const IconSearch = svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconClip = svg(<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 7" />);
export const IconTrash = svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>);
export const IconLock = svg(<><rect x="5" y="11" width="14" height="10" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
export const IconExpand = svg(<path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />);
export const IconCollapse = svg(<path d="M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7" />);
