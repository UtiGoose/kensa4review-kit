import { expect, test } from "bun:test";
import { checkNginx, parseNginx } from "../src/modules/nginx";

const conf = `
server {
    listen 80;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    location = /index.html {
        add_header Cache-Control "no-cache" always;
    }
    location /api/ {
        client_max_body_size 110m;
        proxy_pass http://127.0.0.1:8080/api/;
    }
}`;

test("reports headers lost by add_header in a location", () => {
  const findings = checkNginx("nginx.conf", parseNginx(conf));
  const lost = findings.filter((item) => item.rule === "add-header-inheritance");
  expect(lost).toHaveLength(1);
  expect(lost[0].line).toBe(6);
  expect(lost[0].message).toContain("x-frame-options");
});

test("reports missing security headers and server_tokens", () => {
  const rules = checkNginx("nginx.conf", parseNginx(conf)).map((item) => item.rule);
  expect(rules).toContain("missing-content-security-policy");
  expect(rules).toContain("server-tokens");
  expect(rules).toContain("large-body");
  expect(rules).not.toContain("missing-x-frame-options");
});
