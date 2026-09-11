/**
 * The one way the frontend talks to the backend.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

export interface ApiErrorBody {
  code: string
  message: string
  retryable?: boolean
  retryAfter?: number
  verificationUrl?: string
  problems?: unknown[]
  [extra: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.body = body
  }

  get retryable(): boolean {
    return this.body.retryable ?? this.status >= 500
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === 'not_authenticated'
  }
}

function describe(status: number): string {
  if (status === 0) return 'Cannot reach the Alpha Harness backend.'
  if (status >= 500) return 'The backend failed while handling that request.'
  return `The request was refused (${status}).`
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

function fromObject(status: number, o: Record<string, unknown>): ApiErrorBody {
  const fields = o.fields as Record<string, unknown> | undefined
  const fieldDetail = Array.isArray(fields?.detail) ? (fields.detail as unknown[]).map(String).join(' ') : text(fields?.detail)
  const base = text(o.message) ?? describe(status)
  const extra = text(o.detail) ?? fieldDetail
  return {
    ...o,
    code: text(o.code) ?? `http_${status}`,
    message: extra && !base.includes(extra) ? `${base} ${extra}` : base,
  }
}

export function normalise(status: number, raw: unknown): ApiErrorBody {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.error && typeof o.error === 'object') return fromObject(status, o.error as Record<string, unknown>)
    const detail = o.detail
    if (Array.isArray(detail)) {
      const message = detail
        .map((d) => {
          const e = d as { loc?: unknown[]; msg?: string }
          const where = (e.loc ?? []).filter((part) => part !== 'body' && part !== 'query').join('.')
          return where ? `${where}: ${e.msg}` : String(e.msg)
        })
        .join('; ')
      return { code: 'invalid_request', message: message || describe(status), problems: detail }
    }
    if (detail && typeof detail === 'object') return fromObject(status, detail as Record<string, unknown>)
    if (text(detail)) return { code: `http_${status}`, message: text(detail)! }
  }
  if (text(raw)) return { code: `http_${status}`, message: text(raw)!.slice(0, 300) }
  return { code: `http_${status}`, message: describe(status) }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${BASE_URL}${path}` // <-- THIS IS THE FIX
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include', // <-- important for cookies/auth
    })
  } catch {
    throw new ApiError(0, { code: 'backend_unreachable', message: describe(0) })
  }

  if (response.status === 204) return undefined as T

  const raw = await response.text()
  let parsed: unknown = raw
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {}
  }

  if (!response.ok) throw new ApiError(response.status, normalise(response.status, parsed))
  return parsed as T
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]): [string, string] => [k, String(v)])).toString()}` : ''
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}
