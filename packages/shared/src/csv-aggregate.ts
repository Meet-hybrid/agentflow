/**
 * `csv-aggregate`: the reference task type.
 *
 * A client supplies a CSV dataset and asks for per-group aggregates
 * (count, sum, avg, min, max). The computation is deterministic and uses
 * exact decimal arithmetic (BigInt), so any party can recompute the expected
 * output and compare hashes. That makes the result independently verifiable,
 * which is why it was chosen for the first agent-executable task type.
 *
 * Limitations: inline CSV only (no URLs, so agents need no network access),
 * at most 256 KiB / 10,000 rows / 50 columns, decimal numbers with at most
 * 8 fractional digits, and a fixed output ordering (group key ascending by
 * UTF-16 code unit).
 */
import { z } from "zod";

export const CSV_AGGREGATE = "csv-aggregate" as const;
export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 50;
const MAX_FRACTION_DIGITS = 8;

const columnName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_ .-]+$/, "column names may contain letters, digits, space, _ . -");

export const metricSchema = z.object({
  column: columnName,
  op: z.enum(["count", "sum", "avg", "min", "max"]),
});

export const csvAggregateSpecSchema = z.object({
  type: z.literal(CSV_AGGREGATE),
  version: z.literal(1),
  csv: z
    .string()
    .min(1)
    .refine((s) => new TextEncoder().encode(s).length <= MAX_CSV_BYTES, {
      message: `CSV must be at most ${MAX_CSV_BYTES} bytes`,
    }),
  groupBy: columnName,
  metrics: z.array(metricSchema).min(1).max(10),
  decimals: z.number().int().min(0).max(MAX_FRACTION_DIGITS),
});
export type CsvAggregateSpec = z.infer<typeof csvAggregateSpecSchema>;

export const csvAggregateOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  inputRows: z.number().int().nonnegative(),
});
export type CsvAggregateOutput = z.infer<typeof csvAggregateOutputSchema>;

export class TaskInputError extends Error {
  override name = "TaskInputError";
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: comma separator, double-quote escaping, CRLF or LF)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    // Skip blank lines (a single empty field).
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) throw new TaskInputError(`more than ${MAX_ROWS} data rows`);
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        if (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          throw new TaskInputError("unexpected character after closing quote");
        }
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field !== "") throw new TaskInputError("quote inside an unquoted field");
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      if (row.length > MAX_COLUMNS) throw new TaskInputError(`more than ${MAX_COLUMNS} columns`);
      i++;
    } else if (c === "\r" || c === "\n") {
      pushRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new TaskInputError("unterminated quoted field");
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

// ---------------------------------------------------------------------------
// Exact decimals: a value is an integer scaled by 10^MAX_FRACTION_DIGITS.
// ---------------------------------------------------------------------------

const SCALE = 10n ** BigInt(MAX_FRACTION_DIGITS);

export function parseDecimal(raw: string): bigint {
  const s = raw.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new TaskInputError(`not a number: ${JSON.stringify(raw.slice(0, 40))}`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > MAX_FRACTION_DIGITS) {
    throw new TaskInputError(`more than ${MAX_FRACTION_DIGITS} decimal places: ${s.slice(0, 40)}`);
  }
  const value = BigInt(whole as string) * SCALE + BigInt(frac.padEnd(MAX_FRACTION_DIGITS, "0"));
  return sign === "-" ? -value : value;
}

/** Divides with round-half-away-from-zero. */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (2n * (r < 0n ? -r : r) >= d) return q + (n < 0n === d < 0n ? 1n : -1n);
  return q;
}

export function formatDecimal(scaled: bigint, decimals: number): string {
  const factor = 10n ** BigInt(MAX_FRACTION_DIGITS - decimals);
  const rounded = divRound(scaled, factor);
  const negative = rounded < 0n;
  const digits = (negative ? -rounded : rounded).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  const out = decimals > 0 ? `${whole}.${frac}` : whole;
  return negative && rounded !== 0n ? `-${out}` : out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Acc {
  count: bigint;
  sum: bigint;
  min: bigint | null;
  max: bigint | null;
}

export function runCsvAggregate(spec: CsvAggregateSpec): CsvAggregateOutput {
  const rows = parseCsv(spec.csv);
  const header = rows[0];
  if (!header) throw new TaskInputError("CSV has no header row");
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (index.has(name)) throw new TaskInputError(`duplicate column ${name}`);
    index.set(name, i);
  });
  const col = (name: string) => {
    const i = index.get(name);
    if (i === undefined) throw new TaskInputError(`unknown column ${name}`);
    return i;
  };
  const groupIdx = col(spec.groupBy);
  const metricIdx = spec.metrics.map((m) => col(m.column));

  const groups = new Map<string, Acc[]>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as string[];
    if (row.length !== header.length) {
      throw new TaskInputError(`row ${r} has ${row.length} fields, expected ${header.length}`);
    }
    const key = row[groupIdx] as string;
    let accs = groups.get(key);
    if (!accs) {
      accs = spec.metrics.map(() => ({ count: 0n, sum: 0n, min: null, max: null }));
      groups.set(key, accs);
    }
    spec.metrics.forEach((metric, m) => {
      const acc = accs[m] as Acc;
      acc.count++;
      if (metric.op === "count") return;
      const v = parseDecimal(row[metricIdx[m] as number] as string);
      acc.sum += v;
      acc.min = acc.min === null || v < acc.min ? v : acc.min;
      acc.max = acc.max === null || v > acc.max ? v : acc.max;
    });
  }

  const keys = [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const outRows = keys.map((key) => {
    const accs = groups.get(key) as Acc[];
    return [
      key,
      ...spec.metrics.map((metric, m) => {
        const acc = accs[m] as Acc;
        switch (metric.op) {
          case "count":
            return acc.count.toString();
          case "sum":
            return formatDecimal(acc.sum, spec.decimals);
          case "avg":
            return formatDecimal(divRound(acc.sum, acc.count), spec.decimals);
          case "min":
            return formatDecimal(acc.min as bigint, spec.decimals);
          case "max":
            return formatDecimal(acc.max as bigint, spec.decimals);
        }
      }),
    ];
  });

  return {
    columns: [spec.groupBy, ...spec.metrics.map((m) => `${m.op}_${m.column}`)],
    rows: outRows,
    inputRows: rows.length - 1,
  };
}
