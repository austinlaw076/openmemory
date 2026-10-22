import fs from "node:fs";
import path from "node:path";

const replacements = [
  {
    file: "apps/api/src/better-auth.ts",
    old: "${authBaseUrl}/.well-known/oauth-authorization-server/api/auth",
    next: "${authBaseUrl}/api/auth",
    count: 1,
  },
  {
    file: "apps/api/src/readiness.ts",
    old: "${authBaseUrl}/.well-known/oauth-authorization-server/api/auth",
    next: "${authBaseUrl}/api/auth",
    count: 1,
  },
  {
    file: "apps/api/test/http.integration.test.ts",
    old: "${worker.baseUrl}/.well-known/oauth-authorization-server/api/auth",
    next: "${worker.baseUrl}/api/auth",
    count: 2,
  },
  {
    file: "apps/web/src/dashboard-model.test.ts",
    old: "http://127.0.0.1:8787/.well-known/oauth-authorization-server/api/auth",
    next: "http://127.0.0.1:8787/api/auth",
    count: 1,
  },
];

const base = process.cwd();
const edits = [];
for (const item of replacements) {
  const filePath = path.join(base, item.file);
  if (!fs.existsSync(filePath))
    throw new Error(
      `Required source missing: ${item.file}. Run inside OpenMemory repository root.`,
    );
  const content = fs.readFileSync(filePath, "utf8");
  const found = content.split(item.old).length - 1;
  const alreadyFixed = content.split(item.next).length - 1;
  if (found === 0 && alreadyFixed >= item.count) {
    console.log(`UNCHANGED (already patched): ${item.file}`);
    continue;
  }
  if (found !== item.count)
    throw new Error(
      `Unexpected source pattern: ${item.file}: expected ${item.count}, found ${found}. Aborting.`,
    );
  edits.push({
    filePath,
    file: item.file,
    content: content.replaceAll(item.old, item.next),
  });
}
// All preconditions are checked before any file is written.
for (const edit of edits) {
  fs.writeFileSync(edit.filePath, edit.content);
  console.log(`PATCHED: ${edit.file}`);
}
console.log(`Completed; changed ${edits.length} source/test files.`);
