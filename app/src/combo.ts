// What a searchable dropdown (Combobox.svelte) shows: the options that match what was typed, in their groups.

export interface Option {
  value: string
  label: string
  /** The heading it is listed under (options are kept in the order they come in; a group is shown where its first option is). */
  group?: string
}

/** Lower case, without accents and with ß as ss: "Fähre" is found by "faehre" and by "fahre". */
export const fold = (text: string): string =>
  text
    .toLocaleLowerCase('de')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

/** The options whose label has every word of the query in it (in any order); those that begin with the query come first. */
export function matching(options: readonly Option[], query: string): Option[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...options]
  const found = options.filter((o) => {
    const label = fold(o.label)
    return words.every((w) => label.includes(w))
  })
  const first = fold(query.trim())
  return [...found.filter((o) => fold(o.label).startsWith(first)), ...found.filter((o) => !fold(o.label).startsWith(first))]
}

/** The matching options as the list shows them: grouped, with the headings where a group starts. */
export function listed(options: readonly Option[], query: string): ({ heading: string } | { option: Option; index: number })[] {
  const rows: ({ heading: string } | { option: Option; index: number })[] = []
  const groups = new Map<string, Option[]>()
  for (const o of matching(options, query)) groups.set(o.group ?? '', [...(groups.get(o.group ?? '') ?? []), o])
  let index = 0
  for (const [group, list] of groups) {
    if (group) rows.push({ heading: group })
    for (const option of list) rows.push({ option, index: index++ })
  }
  return rows
}
