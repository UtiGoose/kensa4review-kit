import { expect, test } from "bun:test";
import { parsePmd } from "../src/modules/jvm";

test("parses PMD XML reports", () => {
  const xml = `<?xml version="1.0"?><pmd><file name="/p/src/main/java/A.java">
<violation beginline="3" rule="EmptyCatchBlock" ruleset="Error Prone" priority="3" externalInfoUrl="https://x">
Avoid empty catch blocks &amp; more
</violation></file></pmd>`;
  const findings = parsePmd(xml, (path) => path.replace("/p/", ""), "/nonexistent");
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ rule: "EmptyCatchBlock", file: "src/main/java/A.java", line: 3, severity: "medium", category: "quality" });
  expect(findings[0].message).toBe("Avoid empty catch blocks & more");
});
