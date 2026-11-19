// Response headers a deployment of sandboxed libraries must serve (prototype).
//
// They state the sandbox's two deployment assumptions so that a server can
// enforce them, rather than leaving them implicit:
//   1. Sandbox bundles are data, never scripts. The host fetches their bytes,
//      checks the pinned digest, and evaluates them only inside QuickJS. Served
//      as text/plain with `nosniff`, a browser refuses to run them through a
//      <script> element, so injected markup cannot run library code natively.
//   2. The host page needs WebAssembly compilation ('wasm-unsafe-eval') but no
//      JavaScript eval: QuickJS evaluates the library inside Wasm memory.
//
// The document policy is the minimum the sandbox requires. It is meant to be
// merged with the application's own policy (connect-src, img-src, ...), which
// this tool cannot infer.

/**
 * @param {{bundles: string[], basePath?: string}} options Pinned bundle files and the URL prefix they are served under.
 * @returns {{document: Record<string,string>, paths: Record<string, Record<string,string>>}} Header sets.
 */
export function deploymentHeaders({ bundles, basePath = "/dist/" }) {
  const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const paths = {};
  for (const bundle of [...bundles].sort()) {
    paths[`${prefix}${bundle}`] = {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    };
  }
  return {
    document: {
      "Content-Security-Policy": [
        "script-src 'self' 'wasm-unsafe-eval'",
        "object-src 'none'",
        "base-uri 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
    },
    paths,
  };
}

/** Renders header sets in the `_headers` format used by several static hosts. */
export function toHeadersFile(headers) {
  const lines = ["/*"];
  for (const [name, value] of Object.entries(headers.document)) lines.push(`  ${name}: ${value}`);
  for (const [route, set] of Object.entries(headers.paths)) {
    lines.push("", route);
    for (const [name, value] of Object.entries(set)) lines.push(`  ${name}: ${value}`);
  }
  return lines.join("\n") + "\n";
}
