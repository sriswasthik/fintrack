import axios from 'axios';

interface ApiErrorBody {
  error?: string;
  /** Zod issues, when the server rejected the request shape. */
  details?: { message?: string }[];
  /** On an unexpected server error: the ID its log line is filed under. */
  requestId?: string;
}

/** The API's error body, from anything shaped like a failed HTTP response. */
function apiBody(error: unknown): ApiErrorBody | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  return typeof data === 'object' && data !== null ? (data as ApiErrorBody) : undefined;
}

/**
 * A message worth showing a person, from whatever the API or the network threw.
 *
 * The server's own `error` field is preferred because it was written for a
 * reader; a Zod issue is unpacked because "month must be YYYY-MM" is more use
 * than "Invalid request body"; and a request that never reached the server says
 * so, because "Network Error" tells nobody anything.
 *
 * Shaped structurally rather than through `axios.isAxiosError`, which is a
 * brand check: an error thrown by a different axios instance — or by a test —
 * carries the same information and should read the same way.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  const body = apiBody(error);
  if (body) {
    if (Array.isArray(body.details) && body.details[0]?.message) return body.details[0].message;
    if (typeof body.error === 'string') {
      // An unexpected failure says nothing useful by itself; its reference is
      // what lets whoever runs the server find what happened.
      return typeof body.requestId === 'string'
        ? `${body.error} (reference ${body.requestId.slice(0, 8)})`
        : body.error;
    }
  }

  if (axios.isAxiosError(error) && !error.response) {
    return 'Could not reach the server. Is it running?';
  }

  return error instanceof Error ? error.message : fallback;
}
