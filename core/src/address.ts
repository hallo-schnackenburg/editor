// Street names and addresses as people write them, for finding the place a house lies in and for checking an address against its parent.

/** A street or place name as it is compared: lower case, umlauts and ß spelled out, "str." as "strasse", no spaces or punctuation. */
export const streetKey = (name: string): string =>
  name.toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/str\.?(?=\s|$|,)/g, 'strasse').replace(/[^a-z0-9]/g, '')

/** "Niedernstr. 3a, 29493 Schnackenburg" as its parts: the street (or place), the house number, and the postal code and town if given. */
export function parseAddress(text: string): { street: string; number: string; postal?: string; town?: string } | undefined {
  const m = /^\s*(.+?)\s+(\d+[a-zA-Z]?)\s*(?:,\s*(?:(\d{5})\s*)?(.*?))?\s*$/.exec(text)
  if (!m) return undefined
  return { street: m[1], number: m[2], ...(m[3] ? { postal: m[3] } : {}), ...(m[4] ? { town: m[4] } : {}) }
}
