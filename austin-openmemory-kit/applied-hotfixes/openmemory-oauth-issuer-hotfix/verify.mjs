import assert from "node:assert/strict";
import fs from "node:fs";

const checks = [
  [
    "apps/api/src/better-auth.ts",
    "authorization_servers:",
    "${authBaseUrl}/api/auth",
    "${authBaseUrl}/.well-known/oauth-authorization-server/api/auth",
  ],
  [
    "apps/api/src/readiness.ts",
    "authorizationServer:",
    "${authBaseUrl}/api/auth",
    "${authBaseUrl}/.well-known/oauth-authorization-server/api/auth",
  ],
  [
    "apps/api/test/http.integration.test.ts",
    "protectedResourceMetadata.authorization_servers",
    "${worker.baseUrl}/api/auth",
    null,
  ],
];
for (const [file, anchor, expected, bad] of checks) {
  const data = fs.readFileSync(file, "utf8");
  assert.ok(data.includes(anchor), `${file}: missing anchor`);
  assert.ok(data.includes(expected), `${file}: expected issuer not present`);
  if (bad)
    assert.ok(
      !data.includes(bad),
      `${file}: stale OAuth metadata URL still advertised`,
    );
  console.log(`PASS ${file}`);
}
console.log(
  "Source-level issuer regression checks passed; also run Bun integration tests and production discovery checks.",
);
