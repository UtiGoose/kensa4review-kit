import { expect, test } from "bun:test";
import { checkSpring, readSpringConfig } from "../src/modules/springConfig";

const base = `
spring:
  datasource:
    password: \${DB_PASSWORD:app_password}
jwt:
  secret: \${JWT_SECRET:replace-with-a-unique-secret}
  access-token-expiration-ms: 1800000
management:
  endpoints:
    web:
      exposure:
        include: "*"
logging:
  level:
    org.hibernate.SQL: \${SQL_LOG_LEVEL:DEBUG}
springdoc:
  api-docs:
    path: /v3/api-docs
`;

test("finds secrets with defaults, risky actuator and missing prod switches", () => {
  const properties = readSpringConfig("src/main/resources/application.yml", base);
  const rules = checkSpring(properties, true).map((item) => `${item.rule}:${item.line}`);
  expect(rules).toContain("secret-default:4");
  expect(rules).toContain("secret-default:6");
  expect(rules).not.toContain("secret-default:7");
  expect(rules).toContain("actuator-all:12");
  expect(rules).toContain("debug-logging:15");
  expect(rules.some((rule) => rule.startsWith("springdoc-prod"))).toBe(true);
  expect(rules.some((rule) => rule.startsWith("open-in-view"))).toBe(true);
});

test("dev profiles only produce low severity secrets", () => {
  const properties = readSpringConfig("src/main/resources/application-dev.yml", "app:\n  password: Admin1234!\n");
  const findings = checkSpring(properties, false);
  expect(findings).toHaveLength(1);
  expect(findings[0].severity).toBe("low");
});
