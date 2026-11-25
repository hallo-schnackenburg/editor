import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkFiles } from '@contents-editor/core'
import { prepareFile } from '../src/prepare.js'

describe('prepareFile', () => {
  it('hashes the file, names its place in the store and reports how far it got', async () => {
    const bytes = new TextEncoder().encode('scan of a letter')
    const steps: number[] = []
    const { entry } = await prepareFile(new File([bytes], 'Brief 1.TIF', { type: 'image/tiff' }), (f) => steps.push(f))
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(entry).toMatchObject({ original_name: 'Brief 1.TIF', sha256: sha, mime: 'image/tiff', bytes: bytes.length, path: `files/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}/original.tif` })
    expect(steps.at(-1)).toBe(1)
    expect(checkFiles({ files: [entry] })).toEqual([])
  })

  it('refuses a file without an extension', async () => {
    await expect(prepareFile(new File(['x'], 'scan'), () => {})).rejects.toThrow('Dateiendung')
  })
})
