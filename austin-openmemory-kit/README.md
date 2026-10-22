# Austin OpenMemory — Safe deployment patch kit

**Status:** Source-config patch + preflight tested, **not deployed**. This kit is NOT the full upstream application source. It must be applied to the upstream project after checkout.

- Upstream: https://github.com/andrew-bierman/openmemory
- Pinned SHA: `c85ed66f9b35588506e2e2550ee3705c5e4b4201`
- Cloudflare account: `7b4a06f2fcfaa0169d55051dc7c7eff0`
- Target: `https://austin-openmemory.austinlaw076.workers.dev`

## Safety invariants

- Never run upstream `scripts/setup-cloudflare.sh`; this kit actively disables it, because resources already exist.
- Never use the upstream D1 UUID or defaults in Wrangler configs.
- Never touch `gswm` Worker or its Queues.
- Never import Supermemory personal memories as smoke test data.
- No Cloudflare billing plan change, data deletion, or irreversible operation is carried out by the kit's source patcher.
- R2 bucket lifecycle rules are **not set** (the upstream default 90-day export expiration may be unsuitable for permanent backups).

## Step 1 — independent source checkout

In a trusted computer / ChatGPT Work cloud terminal **with Git, Node, Bun, and authorized Wrangler access**:

```bash
git clone https://github.com/andrew-bierman/openmemory.git austin-openmemory
cd austin-openmemory
git checkout c85ed66f9b35588506e2e2550ee3705c5e4b4201
```

Create your own private GitHub repo/fork before production usage; keep upstream remote and source commit intact. Do not deploy to an existing unrelated repository.

## Step 2 — place this kit inside repo and configure

Unzip this kit and copy its `austin-openmemory-kit/` folder into the cloned repository root. Then:

```bash
node austin-openmemory-kit/configure.mjs
node austin-openmemory-kit/verify.mjs
```

The patcher updates BOTH `wrangler.jsonc` and `apps/api/wrangler.jsonc` without overwriting their relative paths, and modifies package migration names and observability dataset. It disables the unsafe one-click setup script. Changes are repeatable on the pinned commit. Review `git diff`.

## Step 3 — tests and deployment

```bash
bash austin-openmemory-kit/deploy.sh check
bash austin-openmemory-kit/deploy.sh secrets
bash austin-openmemory-kit/deploy.sh migrate
bash austin-openmemory-kit/deploy.sh publish
bash austin-openmemory-kit/deploy.sh smoke
```

The `check` command performs dependency installation, lint/tests, build, Wrangler local integration tests, and dry-run; it must PASS before proceeding. Secrets are sent to Cloudflare using Wrangler and not written to tracked files. `BETTER_AUTH_URL` is `https://austin-openmemory.austinlaw076.workers.dev`. **The `secrets` command generates a new secret on each run — do not repeat after publishing without rotating sessions intentionally.**

### Postdeployment verification

- `/health` reports healthy status (expected HTTP 200).
- `/v1/readiness` confirms bindings, auth and MCP readiness; social providers may show `missing` when optional.
- Dashboard sign-in (email/password; social auth optional) functions with HTTPS cookies.
- OAuth protected resource metadata is present and the `/mcp` route enforces authentication.
- Create/search/update/forget sample *non-sensitive* memories.
- Validate exact-match + Cantonese / Traditional Chinese / English cross-lingual semantic retrieval.
- Validate Vectorize filtering by tenantId, status, isLatest.
- Validate R2 export/restore on disposable test tenant, and tenant isolation.
- Confirm Workflows show as deployed after `publish`; confirm two Queue consumers and DLQs.
- Confirm `gswm` and its Queues are unchanged.

## Environment notes

- BGE-M3 tested successfully using connected Cloudflare Workers AI REST on Oct 20 2026: HTTP 200, `result.data[0]` has exactly 1024 floats. This does not verify the complete OpenMemory runtime.
- All preexisting D1/R2/Vectorize/Queues were checked through Cloudflare API. This kit does not create them again.
- SQLite-backed Durable Objects & Workflows can operate on the Free plan subject to quotas (check plan/limits; not a guarantee of sufficient resources).
- This environment does NOT have an outbound network / a Cloudflare Wrangler login, so the original Bun build and production deploy cannot be performed here. Use a Work cloud computer or your own authenticated terminal.

## Rollback

Cloudflare Workers & Pages -> `austin-openmemory` -> Deployments -> select previous healthy version. Avoid deleting DO/D1/R2 data or queues. Roll back code only, then run `/health` and smoke tests; D1 migrations require separate forward-fix procedures.

## Refs

- Upstream deployment docs: https://github.com/andrew-bierman/openmemory/blob/main/docs/deployment.md
- Cloudflare Workers AI model: https://developers.cloudflare.com/workers-ai/models/bge-m3/
- Workers: https://developers.cloudflare.com/workers/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
