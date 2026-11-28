import type { ApiFieldErrors } from "@/lib/types";

const API_PREFIX = "/api/v1";

export const UNAUTHORIZED_EVENT = "housetory:unauthorized";
export const HOUSEHOLD_CONTEXT_EVENT = "housetory:household-context";

let activeHouseholdId: string | null = null;

export function setActiveHouseholdId(householdId: string | null) {
  activeHouseholdId = householdId;
}

export function householdScopedQueryHash(queryKey: readonly unknown[]) {
  if (queryKey[0] === "session") return JSON.stringify(queryKey);
  return `${activeHouseholdId ?? "none"}:${JSON.stringify(queryKey)}`;
}

/**
 * The offline copy plugs in here (see `lib/offline/controller.ts`). Without it,
 * every request goes to the server as before.
 */
export interface OfflineGate {
  /** Answers a request from the copy, or returns nothing to let it reach the server. */
  intercept(method: string, path: string): Promise<{ data: unknown } | undefined>;
  /**
   * The request did not get an answer from the API: the network failed, or a
   * proxy answered in its place. May answer from the copy instead.
   */
  onUnreachable(method: string, path: string): Promise<{ data: unknown } | undefined>;
  /** Lets a request that hangs be given up for the copy. */
  watch(method: string): { offline: Promise<void>; done(): void } | null;
  onResponse(method: string, path: string, ok: boolean): void;
}

let offlineGate: OfflineGate | null = null;

export function setOfflineGate(gate: OfflineGate | null) {
  offlineGate = gate;
}

function withHouseholdContext(headers: Headers) {
  if (activeHouseholdId) headers.set("X-Household-Id", activeHouseholdId);
}

interface ErrorPayload {
  detail?: {
    code?: string;
    message?: string;
    fields?: ApiFieldErrors;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: ApiFieldErrors;

  constructor(status: number, code: string, message: string, fields?: ApiFieldErrors) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  formData?: FormData;
  skipUnauthorizedEvent?: boolean;
};

async function parseError(response: Response): Promise<ApiError> {
  let payload: ErrorPayload = {};
  try {
    payload = (await response.json()) as ErrorPayload;
  } catch {
    // Non-JSON upstream errors still get a useful fallback below.
  }
  const detail = payload.detail;
  return new ApiError(
    response.status,
    detail?.code ?? "request_failed",
    detail?.message ?? "Something went wrong. Please try again.",
    detail?.fields,
  );
}

/**
 * What a proxy in front of the API (nginx) answers by itself when the API is
 * down (502), not ready (503) or silent (504). The API can send these too, so
 * the offline gate asks the server directly before it believes them.
 */
function mayBeProxyWithoutApi(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

const NETWORK_ERROR_MESSAGE =
  "Housetory can't reach the server. Check your connection and try again.";

/**
 * Sends a request to the server, unless the offline copy answers it. Returns the
 * server's response, or `{ data }` when the answer came from the copy.
 */
async function send(
  path: string,
  options: RequestOptions,
): Promise<{ response: Response } | { data: unknown }> {
  const { body, formData, skipUnauthorizedEvent, headers, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();
  const answered = await offlineGate?.intercept(method, path);
  if (answered) return answered;

  const requestHeaders = new Headers(headers);
  let payload: BodyInit | undefined;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  withHouseholdContext(requestHeaders);

  // Our own signal, so a request given up for the copy does not stay open.
  const abort = new AbortController();
  const onCallerAbort = () => abort.abort(rest.signal?.reason);
  if (rest.signal?.aborted) onCallerAbort();
  else rest.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const watch = offlineGate?.watch(method) ?? null;

  let response: Response;
  try {
    const fetching = fetch(`${API_PREFIX}${path}`, {
      ...rest,
      headers: requestHeaders,
      body: payload,
      credentials: "include",
      signal: abort.signal,
    });
    const first = watch
      ? await Promise.race([fetching, watch.offline.then(() => null)])
      : await fetching;
    if (first === null) {
      fetching.catch(() => undefined);
      abort.abort();
      const fromCopy = await offlineGate?.intercept(method, path);
      if (fromCopy) return fromCopy;
      throw new ApiError(0, "network_error", NETWORK_ERROR_MESSAGE);
    }
    response = first;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (rest.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    const fromCopy = await offlineGate?.onUnreachable(method, path);
    if (fromCopy) return fromCopy;
    throw new ApiError(0, "network_error", NETWORK_ERROR_MESSAGE);
  } finally {
    watch?.done();
    rest.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (offlineGate && mayBeProxyWithoutApi(response.status)) {
    // Every other status, 401 and 403 too, is the server's own answer and is
    // handled below as always.
    const fromCopy = await offlineGate.onUnreachable(method, path);
    if (fromCopy) return fromCopy;
  }
  offlineGate?.onResponse(method, path, response.ok);
  if (!response.ok) {
    const error = await parseError(response);
    if (
      error.code === "household_context_changed" ||
      error.code === "household_context_required" ||
      error.code === "household_access_revoked"
    ) {
      window.dispatchEvent(new Event(HOUSEHOLD_CONTEXT_EVENT));
    } else if (error.status === 401 && !skipUnauthorizedEvent) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw error;
  }
  return { response };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const result = await send(path, options);
  if ("data" in result) return result.data as T;
  if (result.response.status === 204) {
    return undefined as T;
  }
  return (await result.response.json()) as T;
}

async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const result = await send(path, options);
  // The copy holds records, not files. A file asked for offline was refused in `send`.
  if ("data" in result) throw new ApiError(0, "offline_unavailable", NETWORK_ERROR_MESSAGE);
  return result.response.blob();
}

export const api = {
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "GET" });
  },
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "POST", body });
  },
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "PATCH", body });
  },
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "PUT", body });
  },
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "DELETE" });
  },
  postForm<T>(path: string, formData: FormData, options?: RequestOptions): Promise<T> {
    return request<T>(path, { ...options, method: "POST", formData });
  },
  getBlob(path: string, options?: RequestOptions): Promise<Blob> {
    return requestBlob(path, { ...options, method: "GET" });
  },
  postBlob(path: string, body?: unknown, options?: RequestOptions): Promise<Blob> {
    return requestBlob(path, { ...options, method: "POST", body });
  },
};

export function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}
