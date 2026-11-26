import { expect, test } from "bun:test";
import { endpointFindings, parseController, permitAllPaths, strength } from "../src/modules/endpoints";

const controller = `
package a;
// @PreAuthorize("hasRole('ADMIN')") in a comment
@RestController
@RequestMapping("/api/users")
@PreAuthorize("isAuthenticated()")
public class UserController {
  @GetMapping
  public List<User> list() { return null; }

  @PreAuthorize("hasAuthority('user:write')")
  @PostMapping(value = {"/a", "/b"})
  public User create(@RequestBody User user) { return user; }

  @RequestMapping(path = "/x", method = RequestMethod.DELETE)
  public void remove() {}
}`;

test("parses mappings, paths and security", () => {
  const endpoints = parseController("UserController.java", controller);
  expect(endpoints.map((item) => `${item.http.join()} ${item.path} ${strength(item)}`)).toEqual([
    "GET /api/users authenticated",
    "POST /api/users/a role",
    "POST /api/users/b role",
    "DELETE /api/users/x authenticated",
  ]);
});

test("controllers without security annotations are reported", () => {
  const endpoints = parseController("A.java", "@RestController class A { @GetMapping(\"/p\") String p() { return \"\"; } }");
  const findings = endpointFindings(endpoints);
  expect(findings[0].rule).toBe("missing-authorization");
  expect(findings[0].severity).toBe("medium");
});

test("finds permitAll paths", () => {
  expect(permitAllPaths('auth.requestMatchers("/api/auth/login", "/actuator/health").permitAll();')).toEqual(["/api/auth/login", "/actuator/health"]);
});
