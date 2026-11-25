// Writes the index of a data repository: `npm run build-index -- <directory of the repository> <commit> [output file]`.
// CI runs this on every push to the base branch (templates/validate.yml). Without an output file the index goes to stdout.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { blobSha } from '../src/blob-sha.js'
import { buildIndex } from '../src/index-build.js'
import type { RepoFile } from '../src/repo.js'

const [root = '.', commit = '', output] = process.argv.slice(2)

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

const json = JSON.stringify(buildIndex(files, commit, blobSha))
if (output) {
  writeFileSync(output, json)
  console.log(`index of ${files.length} files written to ${output}`)
} else console.log(json)
