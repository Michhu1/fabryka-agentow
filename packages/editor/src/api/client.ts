import type { ApiErrorBody } from '@app/shared';

/**
 * A failed API call. `message` and `code` come from the server's error body (`{ message, code? }`);
 * `body` keeps any extra fields (e.g. `projectCount` of a 409). `status` 0 = the server was not reached.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server's message for a request without a valid session (see `isSessionExpired`). */
export const UNAUTHORIZED_MESSAGE = 'Unauthorized';

/**
 * Whether an error means "the session is gone". Only a 401 `Unauthorized` does: other 401s
 * (`Wrong username or password`, `MFA required`, `Current password is incorrect`, …) are form errors.
 */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.message === UNAUTHORIZED_MESSAGE;
}

type Query = Record<string, string | number | boolean | undefined | null>;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const baseUrl: string = import.meta.env.VITE_API_URL ?? '';

let sessionExpiredHandler: (() => void) | null = null;

/** Called once for every API answer that means the session is gone (set by the app at start). */
export function onSessionExpired(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}${path.includes('?') ? '&' : '?'}${search}` : path;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function request<T>(method: Method, path: string, body?: unknown, query?: Query): Promise<T> {
  const init: RequestInit = { method, credentials: 'include', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    // CSRF protection on the server: every mutating request must declare JSON, even without a body.
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${withQuery(path, query)}`, init);
  } catch {
    throw new ApiError(0, 'Network error');
  }
  const data = await readBody(response);
  if (!response.ok) {
    const errorBody = (typeof data === 'object' && data !== null ? data : {}) as Partial<ApiErrorBody> &
      Record<string, unknown>;
    const message =
      typeof errorBody.message === 'string'
        ? errorBody.message
        : `Request failed with status ${response.status}`;
    const code = typeof errorBody.code === 'number' ? errorBody.code : undefined;
    const error = new ApiError(response.status, message, code, errorBody);
    if (isSessionExpired(error)) sessionExpiredHandler?.();
    throw error;
  }
  return data as T;
}

/** The editor's JSON client for `/rest` (session cookie, `credentials: 'include'`). */
export const apiClient = {
  get<T>(path: string, query?: Query): Promise<T> {
    return request<T>('GET', path, undefined, query);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body);
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, body);
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, body);
  },
  delete<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('DELETE', path, body);
  },
};
