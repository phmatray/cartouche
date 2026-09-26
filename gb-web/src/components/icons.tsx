// Flat, single-color icons from the Box & Manual prototype.
import type { ReactNode } from 'react';

const svg = (children: ReactNode, small = false) => (
  <svg className={small ? 'icon s' : 'icon'} viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
);
/** The official GitHub mark (Octicons mark-github, 16 px grid). */
const GITHUB = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';
export const REPO_URL = 'https://github.com/phmatray/cartouche';
const STAR = 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z';

export const I = {
  search: svg(<><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="m20 20-4-4" stroke="currentColor" strokeWidth="2.2" /></>),
  plus: svg(<><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.6" /></>),
  play: svg(<><path d="M7 4v16l13-8z" fill="currentColor" /></>),
  next: svg(<><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.6" /></>, true),
  star: svg(<><path d={STAR} fill="currentColor" /></>),
  starS: svg(<><path d={STAR} fill="currentColor" /></>, true),
  starO: svg(<><path d={STAR} fill="none" stroke="currentColor" strokeWidth="2" /></>),
  grid: svg(<><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="currentColor" /></>, true),
  list: svg(<><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.4" /></>, true),
  close: svg(<><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.4" /></>),
  menu: svg(<><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.4" /></>),
  pause: svg(<><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" /></>),
  rew: svg(<><path d="M11 6v12L2 12zM21 6v12l-9-6z" fill="currentColor" /></>),
  save: svg(<><path d="M5 3h11l3 3v15H5z" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="M8 3v6h8V3M8 21v-7h8v7" fill="none" stroke="currentColor" strokeWidth="2.2" /></>),
  load: svg(<><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16" fill="none" stroke="currentColor" strokeWidth="2.2" /></>),
  cam: svg(<><path d="M4 7h4l2-3h4l2 3h4v13H4z" fill="none" stroke="currentColor" strokeWidth="2.2" /><circle cx="12" cy="13" r="4" fill="none" stroke="currentColor" strokeWidth="2.2" /></>),
  sound: svg(<><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2.2" /></>),
  mute: svg(<><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" /><path d="m16 9 6 6m0-6-6 6" stroke="currentColor" strokeWidth="2.2" /></>),
  full: svg(<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2.4" /></>),
  book: svg(<><path d="M4 5h7v15H4zM13 5h7v15h-7z" fill="none" stroke="currentColor" strokeWidth="2.4" /></>),
  back: svg(<><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2.6" /></>),
  up: svg(<><path d="M12 6l7 10H5z" fill="currentColor" /></>),
  down: svg(<><path d="M12 18 5 8h14z" fill="currentColor" /></>),
  left: svg(<><path d="M6 12l10-7v14z" fill="currentColor" /></>),
  right: svg(<><path d="M18 12 8 19V5z" fill="currentColor" /></>),
  link: svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" fill="none" stroke="currentColor" strokeWidth="2.2" /></>),
  github: <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d={GITHUB} fill="currentColor" /></svg>,
  cart: svg(<><path d="M5 2h11l3 3v17H5z" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 6h8v6H8zM8 16h8" fill="none" stroke="currentColor" strokeWidth="2" /></>),
};
