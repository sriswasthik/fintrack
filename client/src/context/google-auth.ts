import { createContext, useContext } from 'react';

/**
 * Whether Google's identity script is usable on this page load.
 *
 * `unavailable` is the case worth having: the script is fetched from
 * accounts.google.com, and a corporate network, a content blocker or an outage
 * can stop it arriving. Without knowing, the page reserves space for a button
 * that never appears and leaves an "or" divider separating the form from
 * nothing — which reads as broken rather than as unavailable.
 */
export type GoogleScriptState = 'disabled' | 'pending' | 'ready' | 'unavailable';

export const GoogleScriptContext = createContext<GoogleScriptState>('disabled');

/** True when there is any point drawing a Google button. */
export function useGoogleSignInAvailable(): boolean {
  const state = useContext(GoogleScriptContext);
  return state === 'pending' || state === 'ready';
}
