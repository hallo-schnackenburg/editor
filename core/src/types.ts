/** One problem found in an entry, with the place where it was found. */
export interface Issue {
  /** JSON pointer into the entry, e.g. "/about/1". "/" is the entry itself. */
  path: string
  message: string
  /** Incomplete rather than wrong: shown, but it refuses nothing and fails no check. */
  warning?: true
}
