// Writes the index and the bundle of a data repository: `npm run build-index -- <directory of the repository> <commit> <output directory>`.
// CI runs this on every push to the base branch (templates/validate.yml). Writes index.json (a line per entry) and entries.ndjson.gz
// (the texts of all entries, packed): see core/src/index-build.ts.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { blobSha } from '../src/blob-sha.js'
import { buildBundle, buildIndex } from '../src/index-build.js'
import type { RepoFile } from '../src/repo.js'

const [root = '.', commit = '', output] = process.argv.slice(2)
if (!output) {
  console.error('usage: build-index <directory of the repository> <commit> <output directory>')
  process.exit(2)
}

/** GitHub takes files up to 100 MB; the editor reads the bundle as one file. */
const MAX_BUNDLE = 90_000_000

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const files: RepoFile[] = ['entities', 'contents', 'objects'].flatMap((top) => {
  try {
    return walk(join(root, top)).map((file) => ({ path: relative(root, file).split('\\').join('/'), text: readFileSync(file, 'utf8') }))
  } catch {
    return []
  }
})

mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'index.json'), JSON.stringify(buildIndex(files, commit, blobSha)))
const bundle = gzipSync(buildBundle(files, commit, blobSha), { level: 9 })
if (bundle.length > MAX_BUNDLE) {
  console.error(`the bundle is ${bundle.length} bytes: too large for one file, it has to be split`)
  process.exit(1)
}
writeFileSync(join(output, 'entries.ndjson.gz'), bundle)
console.log(`${files.length} files: index.json and entries.ndjson.gz (${bundle.length} bytes) written to ${output}`)
