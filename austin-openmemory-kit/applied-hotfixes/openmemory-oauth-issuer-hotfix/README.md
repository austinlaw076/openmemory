# OpenMemory MCP OAuth issuer hotfix (2026-10-20)

## Root cause

The OAuth Protected Resource Metadata's `authorization_servers` list incorrectly contained the well-known **discovery URL**, not the Authorization Server **issuer**. The issuer identified by Better Auth is `https://openmemory.openvm067.space/api/auth`, so MCP clients attempted nested `.well-known` discovery paths and could reject the `iss` authorization-response parameter. A second incorrect link existed in `/v1/readiness`.

**Live Worker v13 was already hotfixed on 2026-10-20 by replacing both occurrences of the incorrect string in the bundled Worker.** This kit makes the fix persistent in your *source repository*, so the next Wrangler deployment will not reintroduce it.

## Apply in your own OpenMemory checkout

```bash
# From the OpenMemory Git repository root, with this kit unpacked under the repository:
node openmemory-oauth-issuer-hotfix/apply.mjs
node openmemory-oauth-issuer-hotfix/verify.mjs
bun run check
bun run build
bun run test:integration:local
# Only deploy after all checks pass:
bun run deploy
```

The patch updates only:
- `apps/api/src/better-auth.ts`: `authorization_servers` emits `${authBaseUrl}/api/auth`.
- `apps/api/src/readiness.ts`: `authorizationServer` emits `${authBaseUrl}/api/auth`.
- `apps/api/test/http.integration.test.ts`: corresponding integration assertions.
- `apps/web/src/dashboard-model.test.ts`: expected readiness fixture.

The actual discovery endpoint `/.well-known/oauth-authorization-server/api/auth` **must remain available** and must not be removed. It is the correct RFC 8414 path for the path-bearing issuer `/api/auth`.

## Live smoke checks

```bash
curl -fsS https://openmemory.openvm067.space/health
curl -fsS https://openmemory.openvm067.space/.well-known/oauth-protected-resource/mcp
curl -fsS https://openmemory.openvm067.space/.well-known/oauth-authorization-server/api/auth
```

Expected metadata:
- `resource` = `https://openmemory.openvm067.space/mcp`
- `authorization_servers[0]` = `https://openmemory.openvm067.space/api/auth`
- Authorization Server `issuer` = `https://openmemory.openvm067.space/api/auth`

**Still requires real ChatGPT authorization testing:** reconnect the MCP plugin with `https://openmemory.openvm067.space/mcp`, sign in, accept scopes, check the callback, then verify token exchange and `tools/list`. Do not treat metadata passing alone as evidence of full OAuth success. Never copy OAuth authorization codes, `state`, access tokens or cookie values into chat.
