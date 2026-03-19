import * as fs from "fs";
import * as path from "path";
import { findAllDtsFiles } from "./utils/file-utils.js";
import { Parser } from "./core/parser.js";
import { ProxyGenerator } from "./proxy-generator.js";

// --- EXECUTION ---
async function main() {
  try {
    const args = process.argv.slice(2);
    const targetDirArg = args[0];

    if (!targetDirArg) {
      console.error("Usage: node dist/generator.js <path-to-library>");
      process.exit(1);
    }

    const TARGET_DIR = path.resolve(process.cwd(), targetDirArg);
    const OUTPUT_PROXY = path.join(TARGET_DIR, "sandbox-proxy.js");

    // Derive Library Name from the directory name
    const libraryName = path.basename(TARGET_DIR);

    console.log("--> Starting Sandbox Proxy Generation...");
    console.log(`--> Target Directory: ${TARGET_DIR}`);
    console.log(`--> Library Name: ${libraryName}`);

    // 1. Find all .d.ts files
    const dtsFiles = findAllDtsFiles(TARGET_DIR);
    if (dtsFiles.length === 0) {
      console.error("No .d.ts files found in target directory.");
      process.exit(1);
    }
    console.log(`--> Found ${dtsFiles.length} files to analyze:`);
    dtsFiles.forEach((f) =>
      console.log(`    - ${path.relative(TARGET_DIR, f)}`),
    );

    // 2. Parse Files
    console.log("--> Parsing TypeScript definitions...");
    const parser = new Parser(dtsFiles);
    const libraryData = parser.parse();

    console.log(`--> Extracted:`);
    console.log(`    - ${libraryData.functions.length} Functions`);
    console.log(`    - ${libraryData.classes.length} Classes`);

    // 3. Generate Output
    console.log("--> Generating proxy code (Top-Level Await)...");

    const generator = new ProxyGenerator();
    const proxyContent = generator.generate(libraryData, libraryName);

    fs.writeFileSync(OUTPUT_PROXY, proxyContent);
    console.log(
      `--> Generated Sandbox Proxy: ${path.relative(process.cwd(), OUTPUT_PROXY)}`,
    );

    console.log("--> Success!");
  } catch (e) {
    console.error("Error:", e);
    process.exit(1);
  }
}

main();
