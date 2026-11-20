/**
 * CSV, written by hand (RFC 4180), for files an administrator will open in a
 * spreadsheet.
 *
 * Two separate concerns, both applied to every cell:
 *
 *  1. **Quoting.** Every field is wrapped in double quotes and any double
 *     quote inside it is doubled. Quoting everything, rather than only the
 *     fields that "need" it, means a comma, a quote or a line break inside a
 *     value can never shift the columns — and there is no rule to get subtly
 *     wrong about which values need it.
 *
 *  2. **Formula injection.** A spreadsheet treats a cell beginning with
 *     `=`, `+`, `-` or `@` as a formula, even when it arrived quoted in a CSV.
 *     Audit rows carry text typed by users (a suspension reason, a user
 *     agent), so a value such as `=HYPERLINK(...)` would execute on the
 *     administrator's machine. Such a cell is prefixed with a single quote,
 *     which spreadsheets read as "this is text". Tab and carriage return are
 *     treated the same way, because a leading one of those is skipped by some
 *     spreadsheets before the formula check.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One cell: neutralised if it could be read as a formula, then quoted. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);

  if (FORMULA_LEAD.test(text)) text = `'${text}`;

  return `"${text.replace(/"/g, '""')}"`;
}

/** One record, CRLF-terminated as RFC 4180 specifies. */
export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
