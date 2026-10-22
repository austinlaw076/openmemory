#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Austin OpenMemory configuration patcher.
 * Run from the root of an independent clone of andrew-bierman/openmemory.
 * Requires Node >=20. No third-party packages or network calls.
 * Fails closed on unknown resource references.
 */
import fs from "node:fs";
import path from "node:path";

const PINNED_COMMIT = "c85ed66f9b35588506e2e2550ee3705c5e4b4201";
const D1_ID = "8818d6e4-f8e0-4549-862e-578938df0242";
const SOURCE_D1_ID = "c36373fd-bd51-4a56-9d8c-653a72d51fc9";
const P = "austin-openmemory";
const ENV = "@cf/baai/bge-m3";
const root = process.cwd();
const args = new Set(process.argv.slice(2));
const files = ["wrangler.jsonc", "apps/api/wrangler.jsonc"];

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}
function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}
function writeIfChanged(relative, newContent) {
  const filename = path.join(root, relative);
  const old = fs.readFileSync(filename, "utf8");
  if (old === newContent) return false;
  fs.writeFileSync(filename, newContent);
  return true;
}

assert(
  fs.existsSync(path.join(root, "apps/api/src/semantic-index.ts")),
  "Run from OpenMemory source repository root, not the deploy-kit folder.",
);
assert(fs.existsSync(path.join(root, "package.json")), "Missing package.json");
let sha = "";
try {
  sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {}
assert(
  sha === PINNED_COMMIT,
  `Wrong upstream HEAD (${sha || "unknown"}). Checkout pinned commit: git checkout ${PINNED_COMMIT}`,
);

const expectedNames = new Set(["openmemory-api", P]);
const expectedResourceNames = {
  vectorize: new Set(["openmemory-vectors", `${P}-vectors`]),
  r2: new Set(["openmemory-exports", `${P}-exports`]),
  d1: new Set(["openmemory-auth", `${P}-auth`]),
  queues: new Set([
    "openmemory-memory-extraction",
    "openmemory-memory-extraction-dlq",
    "openmemory-source-ingestion",
    "openmemory-source-ingestion-dlq",
    `${P}-memory-extraction`,
    `${P}-memory-extraction-dlq`,
    `${P}-source-ingestion`,
    `${P}-source-ingestion-dlq`,
  ]),
  workflow: new Set([
    "openmemory-memory-extraction",
    "openmemory-source-ingestion",
    `${P}-memory-extraction`,
    `${P}-source-ingestion`,
  ]),
};
const configured = [];
for (const filename of files) {
  const config = JSON.parse(read(filename));
  assert(
    expectedNames.has(config.name),
    `Unexpected Worker name in ${filename}: ${config.name}`,
  );
  config.name = P;
  assert(config.vectorize?.length === 1, "Unexpected Vectorize bindings");
  assert(
    expectedResourceNames.vectorize.has(config.vectorize[0].index_name),
    "Unrecognized vector index",
  );
  config.vectorize[0].index_name = `${P}-vectors`;
  assert(config.r2_buckets?.length === 1, "Unexpected R2 bindings");
  assert(
    expectedResourceNames.r2.has(config.r2_buckets[0].bucket_name),
    "Unrecognized R2 bucket",
  );
  config.r2_buckets[0].bucket_name = `${P}-exports`;
  assert(config.d1_databases?.length === 1, "Unexpected D1 bindings");
  const db = config.d1_databases[0];
  assert(
    expectedResourceNames.d1.has(db.database_name),
    "Unrecognized D1 database",
  );
  assert(
    [SOURCE_D1_ID, D1_ID].includes(db.database_id),
    "Unknown D1 UUID - refusing to overwrite",
  );
  db.database_name = `${P}-auth`;
  db.database_id = D1_ID;
  const expectedDir =
    filename === "wrangler.jsonc" ? "apps/api/drizzle" : "drizzle";
  assert(
    db.migrations_dir === expectedDir,
    `Unexpected migration dir ${db.migrations_dir} in ${filename}`,
  );
  assert(
    config.queues?.producers?.length === 2 &&
      config.queues?.consumers?.length === 2,
    "Unexpected queue count - manual review required",
  );
  for (const item of [...config.queues.producers, ...config.queues.consumers]) {
    assert(
      expectedResourceNames.queues.has(item.queue),
      `Unknown queue: ${item.queue}`,
    );
    item.queue = item.queue.replace(/^openmemory-/, "austin-openmemory-");
    if (item.dead_letter_queue) {
      assert(
        expectedResourceNames.queues.has(item.dead_letter_queue),
        "Unknown DLQ",
      );
      item.dead_letter_queue = item.dead_letter_queue.replace(
        /^openmemory-/,
        "austin-openmemory-",
      );
    }
  }
  assert(config.workflows?.length === 2, "Unexpected workflow count");
  for (const item of config.workflows) {
    assert(expectedResourceNames.workflow.has(item.name), "Unknown Workflow");
    item.name = item.name.replace(/^openmemory-/, "austin-openmemory-");
  }
  assert(
    config.durable_objects?.bindings?.some(
      (x) => x.name === "MEMORY_GRAPHS" && x.class_name === "MemoryGraph",
    ),
    "Missing durable object binding",
  );
  assert(
    config.migrations?.some((x) =>
      x.new_sqlite_classes?.includes("MemoryGraph"),
    ),
    "Missing sqlite Durable Object migration",
  );
  assert(
    [ENV, "@cf/baai/bge-small-en-v1.5"].includes(config.vars.EMBEDDING_MODEL),
    "Unknown embedding model",
  );
  config.vars.EMBEDDING_MODEL = ENV;
  if (config.analytics_engine_datasets?.length === 1) {
    const a = config.analytics_engine_datasets[0];
    assert(
      ["openmemory_events", "austin_openmemory_events"].includes(a.dataset),
      "Unknown analytics dataset",
    );
    a.dataset = "austin_openmemory_events";
  }
  const changed = writeIfChanged(
    filename,
    JSON.stringify(config, null, 2) + "\n",
  );
  configured.push({ filename, changed });
}
const packagePath = "package.json";
const pkg = JSON.parse(read(packagePath));
for (const key of ["db:migrate:local", "db:migrate:remote"]) {
  assert(typeof pkg.scripts[key] === "string", `Missing package script ${key}`);
  assert(
    pkg.scripts[key].includes("openmemory-auth") ||
      pkg.scripts[key].includes("austin-openmemory-auth"),
    `Unexpected DB name in package script: ${key}`,
  );
  pkg.scripts[key] = pkg.scripts[key].replace(
    /(?<!austin-)openmemory-auth/g,
    "austin-openmemory-auth",
  );
}
writeIfChanged(packagePath, JSON.stringify(pkg, null, 2) + "\n");
const alert = "scripts/observability-alert-check.ts";
const script = read(alert);
assert(
  script.includes('const DEFAULT_DATASET = "openmemory_events";') ||
    script.includes('const DEFAULT_DATASET = "austin_openmemory_events";'),
  "Unknown observability dataset default",
);
writeIfChanged(
  alert,
  script.replace(
    'const DEFAULT_DATASET = "openmemory_events";',
    'const DEFAULT_DATASET = "austin_openmemory_events";',
  ),
);
const setup = "scripts/setup-cloudflare.sh";
const s = read(setup);
const guard =
  'echo "Blocked: pre-created Austin resources; do not run upstream setup-cloudflare.sh" >&2\nexit 2\n';
assert(s.startsWith("#!/usr/bin/env bash"), "Unexpected setup script format");
if (!s.includes("Blocked: pre-created Austin resources")) {
  writeIfChanged(
    setup,
    s.replace(/^#!\/usr\/bin\/env bash\n/, "#!/usr/bin/env bash\n" + guard),
  );
}
console.log("Configuration ready:", configured);
console.log("Worker:", P, "D1:", `${P}-auth`, D1_ID, "Embedding:", ENV);
console.log("Run: node austin-openmemory-kit/verify.mjs");
