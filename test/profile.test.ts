import { expect, test } from "bun:test";
import { classify } from "../src/core/profile";
import type { Finding, Profile } from "../src/core/types";
import { matchesAny } from "../src/core/util";

const finding = (rule: string, file: string, fingerprint: string): Finding => ({
  module: "m",
  rule,
  title: rule,
  severity: "high",
  category: "security",
  message: "",
  file,
  fingerprint,
});

test("glob matching", () => {
  expect(matchesAny("frontend/node_modules/a/b.js", ["**/node_modules"])).toBe(true);
  expect(matchesAny("design/x.html", ["design"])).toBe(true);
  expect(matchesAny("src/design.ts", ["design"])).toBe(false);
  expect(matchesAny("backend/src/main/resources/application.yml", ["**/application*.yml"])).toBe(true);
});

test("classifies new, baseline, accepted and expired entries", () => {
  const profile: Profile = {
    source: null,
    dir: ".",
    exclude: [],
    skip: [],
    flywayPolicy: "warn",
    accepted: [
      { rule: "a", path: "x/**", reason: "ok" },
      { rule: "b", reason: "old", expires: "2000-01-01" },
    ],
  };
  const result = classify([finding("a", "x/y.yml", "1"), finding("b", "z", "2"), finding("c", "z", "3")], profile, new Set(["3"]));
  expect(result.map((item) => item.status)).toEqual(["accepted", "new", "baseline"]);
  expect(result[1].note).toContain("expired");
});
