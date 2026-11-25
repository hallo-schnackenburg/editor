// Checks the entries of a data repository: `npm run validate-repo -- <directory of the repository>`.
// The automatic check of a submission runs this (templates/validate.yml). Problems are printed as GitHub annotations
// (`::error file=…::message`), which GitHub shows at the file; the exit code is 1 if there are any.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { validateRepo, type RepoFile } from '../src/repo.js'

const root = process.argv[2] ?? '.'

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
    return [] // a repository without objects (yet)
  }
})

const problems = validateRepo(files)
for (const { path, issues } of problems) for (const issue of issues) console.log(`::error file=${path},title=Contents::${issue.path === '/' ? '' : `${issue.path}: `}${issue.message}`)
const count = problems.reduce((sum, p) => sum + p.issues.length, 0)
console.log(count === 0 ? `${files.length} files checked, all valid.` : `${count} problem(s) in ${problems.length} of ${files.length} entries.`)
process.exit(count === 0 ? 0 : 1)
