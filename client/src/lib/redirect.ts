/**
 * Where a person lands when we have no better idea, or when the destination we
 * were handed can't be trusted.
 */
export const DEFAULT_DESTINATION = '/dashboard';

/**
 * True if the string carries anything below U+0020, or DEL.
 *
 * Written as a scan rather than a regexp range so the bytes it rejects never
 * have to appear literally in this file.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Sanitise a post-login destination before handing it to `navigate()`.
 *
 * `ProtectedRoute` records where someone was headed and `AuthPage` navigates
 * there once they are signed in, which is the classic open-redirect shape: the
 * value arrives through router state, so anything that can push state at us
 * gets to choose the destination. React Router 6 will follow `//evil.test` and
 * `/\evil.test` straight out of the app (GHSA-wrjc-x8rr-h8h6), so we only ever
 * navigate to a path that is unambiguously our own.
 */
export function safeRedirect(destination: unknown): string {
  if (typeof destination !== 'string') return DEFAULT_DESTINATION;

  // Must be a root-relative path: no scheme, no host, no bare word.
  if (!destination.startsWith('/')) return DEFAULT_DESTINATION;

  // `//host` is protocol-relative, so it leaves the origin; a backslash lets a
  // browser re-read the path as an authority, and `/\host` reaches the same place.
  if (destination.startsWith('//') || destination.includes('\\')) return DEFAULT_DESTINATION;

  // Control characters are stripped before the URL is parsed, so a tab tucked
  // between the two slashes would leave us back at a protocol-relative URL.
  if (hasControlCharacter(destination)) return DEFAULT_DESTINATION;

  return destination;
}
