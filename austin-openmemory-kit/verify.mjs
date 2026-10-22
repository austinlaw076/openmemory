#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const P = "austin-openmemory";
const D1 = "8818d6e4-f8e0-4549-862e-578938df0242";
const expectedQ = [`${P}-memory-extraction`, `${P}-source-ingestion`];
const expectedW = [`${P}-memory-extraction`, `${P}-source-ingestion`];
for (const loc of ["wrangler.jsonc", "apps/api/wrangler.jsonc"]) {
  const x = JSON.parse(fs.readFileSync(loc, "utf8"));
  assert.equal(x.name, P, loc + " worker name");
  assert.equal(x.vars.EMBEDDING_MODEL, "@cf/baai/bge-m3");
  assert.equal(x.vectorize[0].index_name, `${P}-vectors`);
  assert.equal(x.r2_buckets[0].bucket_name, `${P}-exports`);
  assert.equal(x.d1_databases[0].database_name, `${P}-auth`);
  assert.equal(x.d1_databases[0].database_id, D1);
  assert.equal(
    x.d1_databases[0].migrations_dir,
    loc === "wrangler.jsonc" ? "apps/api/drizzle" : "drizzle",
  );
  assert.deepEqual(
    x.queues.producers.map((q) => q.queue).sort(),
    [...expectedQ].sort(),
  );
  assert.deepEqual(
    x.queues.consumers.map((q) => q.queue).sort(),
    [...expectedQ].sort(),
  );
  assert.deepEqual(
    x.workflows.map((w) => w.name).sort(),
    [...expectedW].sort(),
  );
  assert.equal(
    x.analytics_engine_datasets?.[0]?.dataset,
    "austin_openmemory_events",
  );
  assert(
    x.migrations.some((m) => m.new_sqlite_classes?.includes("MemoryGraph")),
  );
  assert(
    x.durable_objects.bindings.some(
      (b) => b.name === "MEMORY_GRAPHS" && b.class_name === "MemoryGraph",
    ),
  );
  for (const q of x.queues.consumers) {
    assert.equal(q.dead_letter_queue, q.queue + "-dlq");
  }
  console.log("PASS", loc);
}
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert(pkg.scripts["db:migrate:remote"].includes(`${P}-auth`));
assert(
  fs
    .readFileSync("scripts/setup-cloudflare.sh", "utf8")
    .includes("Blocked: pre-created Austin resources"),
);
console.log("PASS package migration scripts + setup safety guard");
console.log(
  "Configuration checks passed; does NOT substitute for bun check/build/integration/cloud health tests.",
);
