import { describe, expect, it } from "vitest";
import {
  type CsvAggregateSpec,
  csvAggregateSpecSchema,
  formatDecimal,
  MAX_CSV_BYTES,
  parseCsv,
  parseDecimal,
  runCsvAggregate,
  TaskInputError,
} from "../src/index.ts";

const spec = (csv: string, extra: Partial<CsvAggregateSpec> = {}): CsvAggregateSpec => ({
  type: "csv-aggregate",
  version: 1,
  csv,
  groupBy: "region",
  metrics: [
    { column: "amount", op: "count" },
    { column: "amount", op: "sum" },
    { column: "amount", op: "avg" },
    { column: "amount", op: "min" },
    { column: "amount", op: "max" },
  ],
  decimals: 2,
  ...extra,
});

describe("parseCsv", () => {
  it("parses quotes, escaped quotes, CRLF and blank lines", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["1", "2"],
    ]);
  });

  it("keeps quoted newlines inside a field", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it("rejects malformed quoting", () => {
    expect(() => parseCsv('a\n"open')).toThrow(TaskInputError);
    expect(() => parseCsv('a\nx"y')).toThrow(TaskInputError);
    expect(() => parseCsv('a\n"x"y')).toThrow(TaskInputError);
  });

  it("enforces row and column limits", () => {
    expect(() => parseCsv(`h\n${"1\n".repeat(10_001)}`)).toThrow(/rows/);
    expect(() => parseCsv(Array(52).fill("c").join(","))).toThrow(/columns/);
  });
});

describe("exact decimals", () => {
  it("parses and formats without floating point error", () => {
    expect(formatDecimal(parseDecimal("0.1") + parseDecimal("0.2"), 2)).toBe("0.30");
    expect(formatDecimal(parseDecimal("1.005"), 2)).toBe("1.01");
    expect(formatDecimal(parseDecimal("-1.005"), 2)).toBe("-1.01");
    expect(formatDecimal(parseDecimal("-0.004"), 2)).toBe("0.00");
    expect(formatDecimal(parseDecimal("123"), 0)).toBe("123");
    expect(formatDecimal(parseDecimal("0.00000001"), 8)).toBe("0.00000001");
  });

  it("rejects non-numbers and excess precision", () => {
    for (const bad of ["", "abc", "1e5", "1.2.3", "0x10", "1.123456789", "--1"]) {
      expect(() => parseDecimal(bad), bad).toThrow(TaskInputError);
    }
  });
});

describe("runCsvAggregate", () => {
  const csv = "region,amount\neu,10.50\nus,3\neu,0.25\nus,4\nasia,-1.5\n";

  it("computes grouped aggregates sorted by key", () => {
    expect(runCsvAggregate(spec(csv))).toEqual({
      columns: ["region", "count_amount", "sum_amount", "avg_amount", "min_amount", "max_amount"],
      rows: [
        ["asia", "1", "-1.50", "-1.50", "-1.50", "-1.50"],
        ["eu", "2", "10.75", "5.38", "0.25", "10.50"],
        ["us", "2", "7.00", "3.50", "3.00", "4.00"],
      ],
      inputRows: 5,
    });
  });

  it("is deterministic regardless of row order", () => {
    const shuffled = "region,amount\nasia,-1.5\nus,4\neu,0.25\nus,3\neu,10.50\n";
    expect(runCsvAggregate(spec(shuffled))).toEqual(runCsvAggregate(spec(csv)));
  });

  it("rejects unknown columns, ragged rows and non-numeric metrics", () => {
    expect(() => runCsvAggregate(spec(csv, { groupBy: "country" }))).toThrow(/unknown column/);
    expect(() => runCsvAggregate(spec("region,amount\neu\n"))).toThrow(/fields/);
    expect(() => runCsvAggregate(spec("region,amount\neu,ten\n"))).toThrow(/not a number/);
    expect(() => runCsvAggregate(spec("region,region\neu,1\n"))).toThrow(/duplicate/);
  });

  it("count does not require numeric values", () => {
    const out = runCsvAggregate(
      spec("region,amount\neu,n/a\n", { metrics: [{ column: "amount", op: "count" }] }),
    );
    expect(out.rows).toEqual([["eu", "1"]]);
  });
});

describe("csvAggregateSpecSchema", () => {
  it("rejects oversized input and bad column names", () => {
    const big = `region,amount\n${"x".repeat(MAX_CSV_BYTES)}`;
    expect(csvAggregateSpecSchema.safeParse(spec(big)).success).toBe(false);
    expect(csvAggregateSpecSchema.safeParse(spec(csvA(), { groupBy: "a;drop" })).success).toBe(false);
    expect(csvAggregateSpecSchema.safeParse(spec(csvA())).success).toBe(true);
  });
});

function csvA() {
  return "region,amount\neu,1\n";
}
