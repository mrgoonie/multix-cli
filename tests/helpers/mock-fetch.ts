/**
 * Mock fetch helper for unit tests.
 * Patches globalThis.fetch with a response map keyed by URL substring or full URL.
 * Restores original fetch after each use via returned cleanup fn.
 */

export interface MockResponse {
  status?: number;
  body?: unknown;
  /** Raw body string — bypasses JSON serialization */
  rawBody?: string;
}

export type ResponseMap = Record<string, MockResponse>;

/**
 * Replace globalThis.fetch with a mock that returns pre-defined responses.
 * Returns a restore function to call in afterEach.
 */
export function mockFetch(responseMap: ResponseMap): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Find matching entry by URL substring
    const entry = Object.entries(responseMap).find(([key]) => url.includes(key));

    if (!entry) {
      throw new Error(`mockFetch: no response configured for URL: ${url}`);
    }

    const [, mock] = entry;
    const status = mock.status ?? 200;
    const bodyStr = mock.rawBody ?? (mock.body !== undefined ? JSON.stringify(mock.body) : "{}");

    return new Response(bodyStr, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}
