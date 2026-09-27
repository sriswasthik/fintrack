import { useState } from 'react';

import { chooseTheme, currentTheme, type Theme } from '@/lib/theme';

/** Switches between Paper and Night. Says what it will switch *to*. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => {
        chooseTheme(next);
        setTheme(next);
      }}
      aria-label={next === 'dark' ? 'Switch to night theme' : 'Switch to paper theme'}
      title={next === 'dark' ? 'Night' : 'Paper'}
      className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-8 items-center justify-center rounded-sm transition-colors"
    >
      {next === 'dark' ? (
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="currentColor">
          <path d="M6.2 1.6a6.5 6.5 0 1 0 8.2 8.2A5.5 5.5 0 0 1 6.2 1.6Z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          aria-hidden
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" />
        </svg>
      )}
    </button>
  );
}
