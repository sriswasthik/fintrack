/**
 * Paper (light) or Night (dark).
 *
 * The first visit follows the operating system; choosing one in the header
 * remembers it. `index.html` applies the saved choice before the first paint,
 * so a Night reader never sees a flash of Paper — this module keeps the two in
 * step afterwards.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'fintrack-theme';

function saved(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // Private windows and blocked storage: fall back to the system setting.
    return null;
  }
}

function system(): Theme {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function currentTheme(): Theme {
  return saved() ?? system();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function chooseTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Still applied for this visit; just not remembered.
  }
}
