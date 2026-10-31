/** Inline stroke icons for the sidebar links (decorative: hidden from assistive tech). */

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${paths}</svg>`;

export const NAV_ICONS = {
  overview: icon(
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  ),
  key: icon('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>'),
  storage: icon(
    '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  ),
  code: icon('<path d="M8.5 8L4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>'),
  plug: icon('<path d="M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0zM12 17v3.5"/>'),
  book: icon(
    '<path d="M4.5 5.5A2 2 0 0 1 6.5 3.5h13v14h-13a2 2 0 0 0-2 2zM4.5 19.5a2 2 0 0 0 2 2h13v-4"/>',
  ),
  file: icon('<path d="M6.5 3.5h8l4 4v13h-12zM14.5 3.5v4h4"/>'),
  back: icon('<path d="M10 6l-6 6 6 6M4.5 12h15"/>'),
} as const;

export type NavIcon = keyof typeof NAV_ICONS;
