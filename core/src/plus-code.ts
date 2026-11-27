/**
 * Plus Codes (Open Location Code, as shown by Google Maps): "2HP8+RV" or "9F4M2HP8+RV". An open algorithm, so a code is turned into
 * coordinates by calculation, without any service.
 */

const ALPHABET = '23456789CFGHJMPQRVWX'
const SEPARATOR = '+'
const SEPARATOR_AT = 8
const PAIR_LENGTH = 10
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125]
const GRID_ROWS = 5
const GRID_COLUMNS = 4
/** What the finest pair stands for, in degrees; the grid divides it further. */
const FINEST_PAIR = 0.000125

export interface Position {
  lat: number
  lon: number
}

const digit = (char: string): number => ALPHABET.indexOf(char)

/** A plus code (without a place name), or nothing. Case does not matter. */
function parse(code: string): { short: boolean; digits: string } | undefined {
  const text = code.trim().toUpperCase()
  const at = text.indexOf(SEPARATOR)
  if (at < 0 || at !== text.lastIndexOf(SEPARATOR) || at > SEPARATOR_AT || at % 2 === 1) return undefined
  const before = text.slice(0, at)
  const after = text.slice(at + 1)
  if (after.length === 1) return undefined
  // A full code has its eight digits before the separator; padding zeros only with a short area.
  const padded = before.replace(/0+$/, '')
  if (before.length < SEPARATOR_AT && before.length !== padded.length) return undefined
  if (before.length < SEPARATOR_AT && padded.length !== before.length) return undefined
  const digits = padded + after
  if (digits.length === 0 || [...digits].some((c) => digit(c) < 0)) return undefined
  if (before.length === SEPARATOR_AT) {
    if (digit(digits[0]) > 8) return undefined
    if (digits.length > 1 && digit(digits[1]) > 17) return undefined
  }
  return { short: before.length < SEPARATOR_AT, digits }
}

/** The centre of the area a full code stands for. */
function decodeFull(digits: string): Position {
  let lat = -90
  let lon = -180
  let latSize = 0
  let lonSize = 0
  const pairs = Math.min(digits.length, PAIR_LENGTH)
  for (let i = 0; i < pairs; i += 2) {
    const resolution = PAIR_RESOLUTIONS[i / 2]
    lat += digit(digits[i]) * resolution
    if (i + 1 < pairs) lon += digit(digits[i + 1]) * resolution
    latSize = resolution
    lonSize = resolution
  }
  let rows = FINEST_PAIR
  let columns = FINEST_PAIR
  for (let i = PAIR_LENGTH; i < digits.length; i++) {
    rows /= GRID_ROWS
    columns /= GRID_COLUMNS
    const value = digit(digits[i])
    lat += Math.floor(value / GRID_COLUMNS) * rows
    lon += (value % GRID_COLUMNS) * columns
    latSize = rows
    lonSize = columns
  }
  return { lat: lat + latSize / 2, lon: lon + lonSize / 2 }
}

/** The first digits (as many as a short code lacks) of the code of a position. */
function prefixOf(position: Position, length: number): string {
  let latValue = Math.floor((Math.min(Math.max(position.lat, -90), 90) + 90) * 8000 + 1e-7)
  let lonValue = Math.floor((((position.lon + 180) % 360 + 360) % 360) * 8000 + 1e-7)
  let code = ''
  for (let i = 0; i < PAIR_LENGTH / 2; i++) {
    code = ALPHABET[lonValue % 20] + code
    code = ALPHABET[latValue % 20] + code
    latValue = Math.floor(latValue / 20)
    lonValue = Math.floor(lonValue / 20)
  }
  return code.slice(0, length)
}

/**
 * The position of a plus code, or nothing if it is none. A short code ("2HP8+RV") lacks its first digits; they are taken from the
 * reference, and the area nearest to the reference is the one meant.
 */
export function decodePlusCode(code: string, reference?: Position): Position | undefined {
  const parsed = parse(code)
  if (!parsed) return undefined
  if (!parsed.short) return decodeFull(parsed.digits)
  if (!reference) return undefined
  const missing = SEPARATOR_AT - (code.trim().indexOf(SEPARATOR))
  const resolution = 20 ** (2 - missing / 2)
  const centre = decodeFull(prefixOf(reference, missing) + parsed.digits)
  const half = resolution / 2
  if (reference.lat + half < centre.lat && centre.lat - resolution >= -90) centre.lat -= resolution
  else if (reference.lat - half > centre.lat && centre.lat + resolution <= 90) centre.lat += resolution
  if (reference.lon + half < centre.lon) centre.lon -= resolution
  else if (reference.lon - half > centre.lon) centre.lon += resolution
  return centre
}

/** The plus code in a text ("2HP8+RV Schnackenburg"), if there is one. */
export function findPlusCode(text: string): string | undefined {
  for (const match of text.matchAll(/(?<![A-Za-z0-9+])[0-9A-Za-z]{2,8}\+[0-9A-Za-z]{0,7}(?![A-Za-z0-9+])/g)) {
    const code = match[0]
    if (parse(code) && (parse(code)?.digits.length ?? 0) >= 4) return code
  }
  return undefined
}
