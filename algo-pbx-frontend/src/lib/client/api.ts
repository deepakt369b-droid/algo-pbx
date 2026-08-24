// Shared client-side fetch helper. Every admin page's `fetch(...).then(r
// => r.json())` chain today has no `.catch` and silently discards a
// non-2xx response — see the production audit's cross-cutting finding #1.
// apiFetch() throws on failure with the SERVER'S OWN error message when
// one is present, so a caller's catch block has something real to show
// instead of an empty list.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export async function apiFetch<T = unknown>(url: string, init: ApiFetchInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message =
      (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : null) ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data && typeof data === "object" ? (data as { details?: unknown }).details : undefined);
  }

  return data as T;
}
