import { env } from '../config/env.js'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options
  const token = env.token

  const res = await fetch(`${env.apiBase}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      // M3 T4:Accept: json 让 rsbuild SPA proxy bypass 知道这是 API 调用,
      // 不要 fallback /index.html(否则 GET /tasks 会变成 SPA 路由)
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new ApiError(res.status, text)
  }

  // 204 No Content
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

export const restClient = {
  get: <T>(path: string, init?: Omit<RequestOptions, 'body' | 'method'>) =>
    request<T>(path, { ...init, method: 'GET' }),

  post: <T>(path: string, body?: unknown, init?: Omit<RequestOptions, 'body' | 'method'>) =>
    request<T>(path, { ...init, method: 'POST', body }),

  put: <T>(path: string, body?: unknown, init?: Omit<RequestOptions, 'body' | 'method'>) =>
    request<T>(path, { ...init, method: 'PUT', body }),

  patch: <T>(path: string, body?: unknown, init?: Omit<RequestOptions, 'body' | 'method'>) =>
    request<T>(path, { ...init, method: 'PATCH', body }),

  delete: <T>(path: string, init?: Omit<RequestOptions, 'body' | 'method'>) =>
    request<T>(path, { ...init, method: 'DELETE' }),
}
