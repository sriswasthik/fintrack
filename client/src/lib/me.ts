import { api, setAccessToken } from '@/lib/api';
import type { Session } from '@/lib/auth';

/** The signed-in person, as the settings page needs them. */
export interface Profile {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  createdAt: string;
  /** Whether a password is set — a Google-only account has none. */
  hasPassword: boolean;
  hasGoogle: boolean;
}

export async function fetchProfile(): Promise<Profile> {
  const { data } = await api.get<{ user: Profile }>('/api/auth/me');
  return data.user;
}

/**
 * Changes the password. The server ends every other session and issues this
 * one a fresh token and refresh cookie; the token goes straight to the API
 * client, so the page carries on signed in without a round trip.
 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const { data } = await api.post<Session>('/api/me/password', input);
  setAccessToken(data.accessToken);
}

/** Deletes the account and everything in it. The caller signs out after. */
export async function deleteMyAccount(input: { email: string; password?: string }): Promise<void> {
  await api.delete('/api/me', { data: input });
}
