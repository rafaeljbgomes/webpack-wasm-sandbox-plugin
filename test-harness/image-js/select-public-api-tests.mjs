// Selects the image-js test files that use only the package's public API.
//
// A test file qualifies when every value it imports from the library's source
// tree (relative imports) is a name the installed image-js package exports.
// Files importing internal functions, default exports, or namespaces are left
// out: no consumer of the package, sandboxed or not, can import those.
//
// Run from the repository root: node test-harness/image-js/select-public-api-tests.mjs
import fs from "node:fs";
import path from "node:path";
import * as imageJs from "image-js";

const harness = "test-harness/image-js";
const publicNames = new Set(Object.keys(imageJs));
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full);
    } else if (/__tests__\/.*\.test\.ts$/.test(full)) {
      files.push(full);
    }
  }
})(path.join(harness, "src"));

const selected = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const named = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']+)'/g;
  let publicOnly = true;
  let match;
  while ((match = named.exec(source))) {
    if (match[1]) continue; // type-only import
    for (let name of match[2].split(",")) {
      name = name.trim();
      if (!name || name.startsWith("type ")) continue;
      if (!publicNames.has(name.split(" as ")[0].trim())) publicOnly = false;
    }
  }
  if (/import\s+\*\s+as|import\s+\w+\s+from\s+'\./.test(source)) publicOnly = false;
  if (publicOnly) selected.push(path.relative(harness, file));
}

selected.sort();
fs.writeFileSync(path.join(harness, "public-api-tests.json"), JSON.stringify(selected, null, 1));
console.log(`${selected.length} of ${files.length} test files use only the public API`);
