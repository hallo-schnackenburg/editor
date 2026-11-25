// POST /upload: the browser says which files it wants to put into the bucket; the Worker checks that
// the paths are ones the app would produce, finds out which files are already there, and hands out
// signed URLs for the rest. The files themselves go from the browser straight to the bucket.

import { parseFilePath } from '@contents-editor/core/paths'
import { Refused, failure, json, readBody } from './common.js'
import { presign, type S3Config } from './s3.js'

export interface UploadEnv {
  S3_ENDPOINT?: string
  S3_BUCKET?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  /** Only if it differs from the first label of S3_ENDPOINT. */
  S3_REGION?: string
}

export interface UploadItem {
  path: string
  mime: string
  bytes: number
}

export type UploadAnswer =
  | { path: string; exists: true }
  /** Something else is stored under this path (another size): it is never signed over, a path holds one content only. */
  | { path: string; exists: true; conflict: true }
  | { path: string; exists: false; url: string; headers: Record<string, string> }

/** One signed PUT takes up to 5 GB at Hetzner; scans and photos stay far below this. */
export const MAX_FILE_BYTES = 1024 ** 3
const MAX_ITEMS = 8
/** A scan over a slow line takes a while. */
const URL_LIFETIME = 3 * 3600
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/

export function parseUploadRequest(data: unknown): UploadItem[] {
  const files = (data as { files?: unknown } | null)?.files
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ITEMS) {
    throw new Refused(`"files" must list 1 to ${MAX_ITEMS} files.`)
  }
  return files.map((item: Partial<UploadItem> | null) => {
    const { path, mime, bytes } = item ?? {}
    if (typeof path !== 'string' || !parseFilePath(path)) throw new Refused('A file path is not valid.')
    if (typeof mime !== 'string' || !MIME.test(mime)) throw new Refused('A file type is not valid.')
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES) {
      throw new Refused('A file has an invalid or too large size.')
    }
    return { path, mime, bytes }
  })
}

export function s3Config(env: UploadEnv): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = env
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null
  return {
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    region: S3_REGION || undefined,
  }
}

/**
 * Is the file in the bucket already? `same` if it has the size we expect, `other` if it has another one (a path holds one
 * content only, it contains the hash: a different size means something is wrong, and it must not be written over).
 * Asks with GET, not HEAD: in the deployed Worker the request passes through Cloudflare, which turns a HEAD into a
 * GET towards the bucket, and then the signature (made for HEAD) no longer fits and the bucket answers 403.
 * The body is never read; cancelling it keeps the file from being transferred.
 */
async function isThere(config: S3Config, item: UploadItem, fetchFn: typeof fetch): Promise<'none' | 'same' | 'other'> {
  const url = await presign(config, { method: 'GET', key: item.path, expires: 60 })
  const response = await fetchFn(url)
  await response.body?.cancel()
  if (response.status === 404) return 'none'
  if (!response.ok) throw new Error(`The bucket answered ${response.status}.`)
  const length = response.headers.get('content-length')
  return length === null || Number(length) === item.bytes ? 'same' : 'other'
}

export async function planUpload(items: UploadItem[], config: S3Config, fetchFn: typeof fetch = fetch): Promise<UploadAnswer[]> {
  return Promise.all(
    items.map(async (item): Promise<UploadAnswer> => {
      const there = await isThere(config, item, fetchFn)
      if (there === 'same') return { path: item.path, exists: true }
      if (there === 'other') return { path: item.path, exists: true, conflict: true }
      // The content type is signed: the browser has to send exactly this one.
      const headers = { 'content-type': item.mime }
      const url = await presign(config, { method: 'PUT', key: item.path, expires: URL_LIFETIME, headers })
      return { path: item.path, exists: false, url, headers }
    }),
  )
}

/** POST /upload: which of the files are not in the bucket, and where to put them (signed URLs). */
export async function handleUpload(request: Request, route: string, env: UploadEnv, fetchFn: typeof fetch): Promise<Response | null> {
  if (route !== '/upload' || request.method !== 'POST') return null
  const config = s3Config(env)
  if (!config) return json({ error: 'Der Server hat keine Speicher-Einstellungen (S3_* in worker/.secrets).' }, 500)
  try {
    const items = parseUploadRequest(await readBody(request))
    return json({ files: await planUpload(items, config, fetchFn) })
  } catch (error) {
    if (error instanceof Refused) return failure(error)
    console.error('Storage error', (error as Error).message)
    return json({ error: 'Der Speicher ist nicht erreichbar.' }, 502)
  }
}
