#!/usr/bin/env bash
set -euo pipefail
# Run from root of pinned OpenMemory git clone after running configure.mjs.
export CLOUDFLARE_ACCOUNT_ID='7b4a06f2fcfaa0169d55051dc7c7eff0'
PROJECT='austin-openmemory'
TARGET_URL='https://austin-openmemory.austinlaw076.workers.dev'
ACTION="${1:-help}"

ensure_root(){
  test -f apps/api/wrangler.jsonc && test -f wrangler.jsonc || { echo 'Run from repository root' >&2; exit 2; }
  command -v bun >/dev/null || { echo 'Bun required: https://bun.sh/docs/installation' >&2; exit 2; }
  node austin-openmemory-kit/verify.mjs
}
case "$ACTION" in
  check)
    ensure_root
    bun install --frozen-lockfile
    bun run check
    bun run build
    bun run test:integration:local
    bun --cwd apps/api wrangler deploy --dry-run
    ;;
  secrets)
    ensure_root
    bun --cwd apps/api wrangler whoami
    # Best practice: write secrets before deploy; no secrets are printed or committed.
    openssl rand -hex 32 | bun --cwd apps/api wrangler secret put BETTER_AUTH_SECRET --config wrangler.jsonc
    printf %s "$TARGET_URL" | bun --cwd apps/api wrangler secret put BETTER_AUTH_URL --config wrangler.jsonc
    echo 'Core Better Auth secrets set. Optional social providers can be configured later.'
    ;;
  migrate)
    ensure_root
    bun run db:migrate:remote
    ;;
  publish)
    ensure_root
    bun run deploy
    ;;
  smoke)
    curl -sS -i "$TARGET_URL/health"
    curl -sS -i "$TARGET_URL/v1/readiness"
    curl -sS -i "$TARGET_URL/.well-known/oauth-protected-resource/mcp"
    ;;
  *)
    echo 'Usage: bash austin-openmemory-kit/deploy.sh check|secrets|migrate|publish|smoke'
    echo 'Order: check -> secrets -> migrate -> publish -> smoke'
    ;;
esac
