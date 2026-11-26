import { expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { distinct } from "../src/core/runner";
import type { Finding } from "../src/core/types";
import { workbook } from "../src/report/xlsx";

const finding = (line: number, fingerprint = "abc"): Finding => ({
  module: "semgrep",
  rule: "rule",
  title: "Title",
  severity: "low",
  category: "quality",
  message: "message",
  file: "A.java",
  line,
  fingerprint,
});

test("keeps repeated code in one file as separate findings", () => {
  const result = distinct([finding(30), finding(10), finding(10)]);
  expect(result.map((item) => item.line)).toEqual([10, 30]);
  expect(result[0].fingerprint).toBe("abc");
  expect(result[1].fingerprint).not.toBe("abc");
});

test("writes a workbook with escaped text and filters", () => {
  const files = unzipSync(
    workbook([
      { name: "Summary", widths: [10], rows: [["a < b & c"]] },
      { name: "rules/x", widths: [10, 10], table: { headerRow: 0 }, rows: [["Rule", "Count"], ["r\u0001", 2]] },
    ]),
  );
  const book = strFromU8(files["xl/workbook.xml"]);
  expect(book).toContain('name="rules-x"');
  expect(book).toContain("_xlnm._FilterDatabase");
  expect(strFromU8(files["xl/worksheets/sheet1.xml"])).toContain("a &lt; b &amp; c");
  const second = strFromU8(files["xl/worksheets/sheet2.xml"]);
  expect(second).toContain('<autoFilter ref="A1:B2"/>');
  expect(second).toContain("<v>2</v>");
  expect(second).not.toContain("\u0001");
});
