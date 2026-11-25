// The sha git gives a file (`git hash-object`). Node only (CI and tests): the Worker and the editor get the sha from GitHub.

import { createHash } from 'node:crypto'

export function blobSha(text: string): string {
  const body = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}
