// Spreadsheet programs evaluate a cell that starts with one of these characters as a formula, even when the CSV
// field is quoted, and they ignore leading whitespace and control characters when deciding (formula injection,
// issue #368). A leading apostrophe makes them treat the cell as text.
const formulaTriggers = '=+-@';
const firstSignificantCodePoint = 0x21;

function neutralizeFormula(text: string): string {
  const first = Array.from(text).find((character) => character.charCodeAt(0) >= firstSignificantCodePoint);
  if (first === undefined || !formulaTriggers.includes(first)) return text;
  return `'${text}`;
}

export function encodeCSVCell(value: string | number | undefined): string {
  if (typeof value === 'number') return String(value);
  if (value === undefined) return '""';
  return `"${neutralizeFormula(value).replaceAll('"', '""')}"`;
}

export function encodeCSV(rows: (string | number | undefined)[][]): string {
  return rows.map((row) => row.map(encodeCSVCell).join(',')).join('\r\n');
}
