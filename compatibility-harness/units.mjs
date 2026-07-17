import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const strategies = ["suite", "per-file", "batch"];

export function normalizeTestPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

export function discoverTestFiles(harnessDir, discovery) {
  if (!discovery) {
    return [];
  }

  const searchRoot = resolve(harnessDir, discovery.root);
  const excluded = new Set(
    (discovery.exclude ?? []).map((filePath) => normalizeTestPath(filePath)),
  );
  const suffixes = discovery.suffixes ?? (discovery.suffix ? [discovery.suffix] : []);

  return walkFiles(searchRoot)
    .map((filePath) => normalizeTestPath(relative(harnessDir, filePath)))
    .filter((filePath) => {
      if (excluded.has(filePath)) {
        return false;
      }
      if (discovery.fileName) {
        return filePath.split("/").at(-1) === discovery.fileName;
      }
      if (suffixes.length) {
        return suffixes.some((suffix) => filePath.endsWith(suffix));
      }
      return true;
    })
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function selectTestFiles(discoveredFiles, requestedFiles) {
  if (!requestedFiles.length) {
    return discoveredFiles;
  }

  const discovered = new Set(discoveredFiles);
  const selected = [];
  for (const requestedFile of requestedFiles) {
    if (isAbsolute(requestedFile)) {
      throw new Error(`--test-file must be relative: ${requestedFile}`);
    }

    const normalized = normalizeTestPath(requestedFile);
    if (
      normalized === ".." ||
      normalized.startsWith(`..${sep}`) ||
      normalized.startsWith("../")
    ) {
      throw new Error(`--test-file must stay inside the harness: ${requestedFile}`);
    }
    if (!discovered.has(normalized)) {
      throw new Error(
        `Test file "${requestedFile}" is not part of the configured test set.`,
      );
    }
    if (!selected.includes(normalized)) {
      selected.push(normalized);
    }
  }
  return selected;
}

export function chunkFiles(files, batchSize) {
  const chunks = [];
  for (let index = 0; index < files.length; index += batchSize) {
    chunks.push(files.slice(index, index + batchSize));
  }
  return chunks;
}

export function createExecutionUnits({
  strategy,
  batchSize,
  files,
  commandCount,
}) {
  if (strategy === "suite") {
    return Array.from({ length: commandCount }, (_, index) => ({
      kind: "suite",
      commandIndex: index,
      files: commandCount === 1 ? files : [],
    }));
  }
  if (!files.length) {
    throw new Error(`Strategy "${strategy}" requires at least one test file.`);
  }
  if (commandCount !== 1) {
    throw new Error(
      `Strategy "${strategy}" requires exactly one command per mode.`,
    );
  }
  if (strategy === "per-file") {
    return files.map((file) => ({
      kind: "file",
      commandIndex: 0,
      files: [file],
    }));
  }
  if (strategy === "batch") {
    return chunkFiles(files, batchSize).map((batch) => ({
      kind: "batch",
      commandIndex: 0,
      files: batch,
    }));
  }
  throw new Error(`Unknown execution strategy: ${strategy}`);
}

export function fingerprintFiles({ strategy, testFilePattern, files }) {
  const source = files.length
    ? files.join("\n")
    : `${strategy}:${testFilePattern}`;
  return createHash("sha256").update(source).digest("hex");
}

export function unitSlug(sequence, files, kind) {
  const hash = createHash("sha256")
    .update(files.length ? files.join("\n") : `${kind}:${sequence}`)
    .digest("hex")
    .slice(0, 10);
  return `${String(sequence).padStart(4, "0")}-${hash}`;
}

export function shouldFallbackUnit(unit, status, fallback) {
  return (
    unit.kind === "batch" &&
    fallback === "per-file" &&
    (status === "crashed" || status === "parse_error")
  );
}
