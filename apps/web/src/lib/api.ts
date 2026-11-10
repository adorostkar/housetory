import type { ApiFieldErrors } from "@/lib/types";

const API_PREFIX = "/api/v1";

export const UNAUTHORIZED_EVENT = "housetory:unauthorized";
export const HOUSEHOLD_CONTEXT_EVENT = "housetory:household-context";

let activeHouseholdId: string | null = null;

export function setActiveHouseholdId(householdId: string | null) {
  activeHouseholdId = householdId;
}

export function getActiveHouseholdId() {
  return activeHouseholdId;
}

export function householdScopedQueryHash(queryKey: readonly unknown[]) {
  if (queryKey[0] === "session") return JSON.stringify(queryKey);
  return `${activeHouseholdId ?? "none"}:${JSON.stringify(queryKey)}`;
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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, formData, skipUnauthorizedEvent, headers, ...rest } = options;
  const requestHeaders = new Headers(headers);
  let payload: BodyInit | undefined;

  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  withHouseholdContext(requestHeaders);

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      ...rest,
      headers: requestHeaders,
      body: payload,
      credentials: "include",
    });
  } catch (error) {
    if (rest.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    throw new ApiError(
      0,
      "network_error",
      "Housetory can't reach the server. Check your connection and try again.",
    );
  }

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

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const { body, formData, skipUnauthorizedEvent, headers, ...rest } = options;
  const requestHeaders = new Headers(headers);
  let payload: BodyInit | undefined;
  if (formData) payload = formData;
  else if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  withHouseholdContext(requestHeaders);
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      ...rest,
      headers: requestHeaders,
      body: payload,
      credentials: "include",
    });
  } catch (error) {
    if (rest.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    throw new ApiError(
      0,
      "network_error",
      "Housetory can't reach the server. Check your connection and try again.",
    );
  }
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
  return response.blob();
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
