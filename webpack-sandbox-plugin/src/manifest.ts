import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { LibraryPolicy } from "./build-helpers";
import type { BundleIntegrity } from "./proxy-generator";

/**
 * Sandbox manifest produced by the separate sandbox stage
 * (`sandbox-stage/build.mjs`). It pins, for every sandboxed library, the
 * bundle that stage built from lockfile-verified sources and the grant it was
 * built under. The application build consumes it instead of compiling library
 * code itself.
 */
export interface SandboxManifest {
  manifestVersion: 1;
  /** SHA-256 (hex) of the policy file the sandbox stage read. */
  policySha256: string;
  libraries: Record<string, ManifestLibrary>;
}

export interface ManifestLibrary {
  bundle: string;
  /** Subresource-Integrity digest of the bundle (`sha384-<base64>`). */
  integrity: string;
  grant: string[];
  /** Host properties the library may assign (see `LibraryPolicy.writable`). */
  writable?: Record<string, string[]>;
  /** Declared subpaths served by the same bundle. */
  subpaths?: string[];
  packageVersion?: string;
  /** The lockfile's integrity for the package tarball the bundle was built from. */
  lockfileIntegrity?: string;
  workloads?: Record<string, { bundle: string; integrity: string }>;
}

/** Options accepted under `sandboxManifest` in the plugin options. */
export interface ManifestOptions {
  /** Manifest path, resolved from the compiler context. */
  path: string;
  /** Directory holding the bundles the sandbox stage emitted. */
  bundleDir: string;
  /**
   * File holding the expected SHA-256 (hex) of the manifest, kept next to the
   * protected policy and reviewed like a lockfile. When set, a manifest with
   * any other digest is rejected.
   */
  pinPath?: string;
}

/** Reads a pin file: the first 64-hex-digit token, ignoring comments. */
export function readManifestPin(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  const match = text.replace(/#.*$/gm, "").match(/\b[0-9a-f]{64}\b/i);
  if (!match) throw new Error(`[SandboxPlugin] Manifest pin ${file} holds no SHA-256 digest`);
  return match[0].toLowerCase();
}

/** Computes an SRI digest (`sha384-<base64>`). */
export function sriDigest(bytes: Buffer | Uint8Array): string {
  return `sha384-${crypto.createHash("sha384").update(bytes).digest("base64")}`;
}

/** Computes a hex SHA-256 of a file's bytes. */
export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const sameGrant = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * Loads the manifest and checks it against the application's policy. Any
 * divergence fails the build: the manifest, produced from the protected
 * policy, is authoritative, so a policy edited inside the application build
 * cannot widen a grant or add an unsandboxed library silently.
 *
 * @returns The manifest and the verified bundle bytes, keyed by file name.
 */
export function loadAndCheckManifest(
  options: ManifestOptions,
  context: string,
  policyPath: string,
  policy: Record<string, LibraryPolicy>,
): { manifest: SandboxManifest; bundles: Map<string, Buffer> } {
  const manifestPath = path.resolve(context, options.path);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[SandboxPlugin] Sandbox manifest was not found at ${manifestPath}`);
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  if (options.pinPath) {
    const pinPath = path.resolve(context, options.pinPath);
    if (!fs.existsSync(pinPath)) {
      throw new Error(`[SandboxPlugin] Manifest pin was not found at ${pinPath}`);
    }
    const expected = readManifestPin(pinPath);
    const actual = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    if (actual !== expected) {
      throw new Error(
        `[SandboxPlugin] Sandbox manifest ${manifestPath} (sha256 ${actual}) is not the reviewed manifest pinned in ${pinPath} (sha256 ${expected}).`,
      );
    }
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as SandboxManifest;
  if (manifest.manifestVersion !== 1 || typeof manifest.libraries !== "object") {
    throw new Error(`[SandboxPlugin] Unsupported sandbox manifest at ${manifestPath}`);
  }

  const policyHash = sha256File(policyPath);
  if (policyHash !== manifest.policySha256) {
    throw new Error(
      `[SandboxPlugin] Sandbox policy ${policyPath} (sha256 ${policyHash}) differs from the policy the sandbox stage ` +
        `built (sha256 ${manifest.policySha256}). Rebuild the sandbox stage from the protected policy.`,
    );
  }

  const configured = Object.keys(policy).sort();
  const pinned = Object.keys(manifest.libraries).sort();
  if (configured.join("\0") !== pinned.join("\0")) {
    throw new Error(
      `[SandboxPlugin] Sandboxed libraries in the policy (${configured.join(", ")}) differ from the manifest (${pinned.join(", ")}).`,
    );
  }

  const bundleDir = path.resolve(context, options.bundleDir);
  const bundles = new Map<string, Buffer>();
  const check = (file: string, expected: string) => {
    const bytes = fs.readFileSync(path.join(bundleDir, file));
    const actual = sriDigest(bytes);
    if (actual !== expected) {
      throw new Error(`[SandboxPlugin] Sandbox bundle ${file} does not match the manifest (expected ${expected}, got ${actual}).`);
    }
    bundles.set(file, bytes);
  };

  for (const [name, entry] of Object.entries(manifest.libraries)) {
    if (!sameGrant(entry.grant, policy[name].permissions)) {
      throw new Error(
        `[SandboxPlugin] Grant for ${name} in the policy (${policy[name].permissions.join(", ") || "none"}) differs from the ` +
          `manifest (${entry.grant.join(", ") || "none"}).`,
      );
    }
    const canonical = (value: unknown) => JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v);
    const policyWritable = policy[name].writable ?? {};
    if (canonical(entry.writable ?? {}) !== canonical(policyWritable)) {
      throw new Error(
        `[SandboxPlugin] Writable paths for ${name} in the policy (${canonical(policyWritable)}) differ from the manifest ` +
          `(${canonical(entry.writable ?? {})}).`,
      );
    }
    const policySubpaths = [...(policy[name].subpaths ?? [])].sort();
    if (canonical(policySubpaths) !== canonical([...(entry.subpaths ?? [])].sort())) {
      throw new Error(
        `[SandboxPlugin] Subpaths for ${name} in the policy (${policySubpaths.join(", ") || "none"}) differ from the manifest ` +
          `(${(entry.subpaths ?? []).join(", ") || "none"}).`,
      );
    }
    check(entry.bundle, entry.integrity);
    for (const workload of Object.values(entry.workloads ?? {})) check(workload.bundle, workload.integrity);
  }
  return { manifest, bundles };
}

/** Converts a manifest entry into the digests a proxy pins. */
export function integrityFor(entry: ManifestLibrary | undefined): BundleIntegrity | undefined {
  if (!entry) return undefined;
  return {
    library: entry.integrity,
    workloads: Object.fromEntries(Object.entries(entry.workloads ?? {}).map(([name, w]) => [name, w.integrity])),
  };
}
