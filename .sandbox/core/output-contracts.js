// Output contracts: developer-declared types for what a sandboxed export
// returns. The capability grant limits what a library can reach; it says
// nothing about the values the library hands back. A contract closes part of
// that gap on the host side of the membrane, where the library has no code:
//
//   html     the returned string is passed through a host sanitizer the
//            developer names (a trusted, non-sandboxed module), and, when a
//            Trusted Types policy name is given and the browser supports
//            Trusted Types, returned as TrustedHTML from that policy;
//   string   must be a string (optional maxLength, pattern);
//   boolean  must be a boolean;
//   bytes    must be a Uint8Array (optional exact length);
//   check    any of the above may name a host check function that receives
//            (result, args) and must return true (e.g. verify a signature
//            with Web Crypto); anything else is a violation.
//
// Structural violations fail closed: the call throws SandboxOutputError and
// the application never receives the value. Contracts bind to declared
// export paths ("marked.parse", "default", "sign.detached"); a path that is
// not declared is not checked. Results that are promises are checked when
// they settle.

/** Thrown when a sandboxed export returns a value that breaks its contract. */
export class SandboxOutputError extends TypeError {
  constructor(path, reason) {
    super(`[Sandbox] output of ${path} violates its contract: ${reason}`);
    this.name = "SandboxOutputError";
    this.path = path;
  }
}

const isThenable = (v) => v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";

/** Resolves a sanitizer module's export to a string -> string function. */
function sanitizerFunction(mod, path) {
  const m = mod && mod.default !== undefined ? mod.default : mod;
  if (typeof m === "function" && typeof m.sanitize !== "function") return (s) => m(s);
  if (m && typeof m.sanitize === "function") return (s) => m.sanitize(s);
  throw new Error(`[Sandbox] sanitizer for ${path} must be a function or expose sanitize()`);
}

function checkFunction(mod, path) {
  const m = mod && mod.default !== undefined ? mod.default : mod;
  if (typeof m !== "function") throw new Error(`[Sandbox] check for ${path} must export a function`);
  return m;
}

/**
 * Builds the enforcement function of one contract.
 * @param {string} path Declared export path.
 * @param {object} contract Normalized contract from the policy.
 * @param {object} modules Host modules the generated proxy imported: { sanitizer?, check? }.
 * @returns {(value: unknown, args: unknown[]) => unknown}
 */
export function compileContract(path, contract, modules = {}) {
  const check = modules.check ? checkFunction(modules.check, path) : null;
  const runCheck = (value, args) => {
    if (check && check(value, args) !== true) throw new SandboxOutputError(path, "host check rejected the value");
  };
  switch (contract.type) {
    case "html": {
      const sanitize = sanitizerFunction(modules.sanitizer, path);
      let policy = null;
      const tt = contract.trustedTypes && globalThis.trustedTypes;
      return (value, args) => {
        if (typeof value !== "string") throw new SandboxOutputError(path, `expected an HTML string, got ${typeof value}`);
        const clean = String(sanitize(value));
        runCheck(clean, args);
        if (tt) {
          policy ??= globalThis.trustedTypes.createPolicy(contract.trustedTypes, { createHTML: (s) => s });
          // The policy only wraps strings this function has just sanitized.
          return policy.createHTML(clean);
        }
        return clean;
      };
    }
    case "string":
      return (value, args) => {
        if (typeof value !== "string") throw new SandboxOutputError(path, `expected a string, got ${typeof value}`);
        if (contract.maxLength !== undefined && value.length > contract.maxLength) throw new SandboxOutputError(path, `longer than ${contract.maxLength}`);
        if (contract.pattern !== undefined && !new RegExp(contract.pattern, "u").test(value)) throw new SandboxOutputError(path, `does not match ${contract.pattern}`);
        runCheck(value, args);
        return value;
      };
    case "boolean":
      return (value, args) => {
        if (typeof value !== "boolean") throw new SandboxOutputError(path, `expected a boolean, got ${typeof value}`);
        runCheck(value, args);
        return value;
      };
    case "bytes":
      return (value, args) => {
        if (!(value instanceof Uint8Array)) throw new SandboxOutputError(path, "expected a Uint8Array");
        if (contract.length !== undefined && value.length !== contract.length) throw new SandboxOutputError(path, `expected ${contract.length} bytes, got ${value.length}`);
        runCheck(value, args);
        return value;
      };
    default:
      throw new Error(`[Sandbox] unknown output contract type for ${path}`);
  }
}

/**
 * Wraps a host-side export view so that calls on the declared paths below
 * `name` pass their results through the compiled contracts.
 * @param {string} name Export name ("default" or a named export).
 * @param {unknown} value The export as the proxy would otherwise expose it.
 * @param {Record<string, Function>} enforcers Compiled contracts keyed by full path.
 */
export function withOutputContracts(name, value, enforcers) {
  const own = Object.keys(enforcers).filter((p) => p === name || p.startsWith(name + "."));
  if (own.length === 0 || (typeof value !== "function" && (typeof value !== "object" || value === null))) return value;
  return wrapAt(name, value, enforcers);
}

function enforce(path, enforcer, result, args) {
  if (isThenable(result)) return Promise.resolve(result).then((v) => enforcer(v, args));
  return enforcer(result, args);
}

function wrapAt(path, value, enforcers) {
  const below = Object.keys(enforcers).some((p) => p.startsWith(path + "."));
  const here = enforcers[path];
  if (!below && !here) return value;
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return value;
  const cache = new Map();
  return new Proxy(value, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args);
      return here ? enforce(path, here, result, args) : result;
    },
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || !below) return v;
      const sub = `${path}.${key}`;
      if (!enforcers[sub] && !Object.keys(enforcers).some((p) => p.startsWith(sub + "."))) return v;
      // Cache per path and target so repeated reads return the same function.
      const hit = cache.get(sub);
      if (hit && hit.orig === v) return hit.wrapped;
      const wrapped = wrapAt(sub, v, enforcers);
      cache.set(sub, { orig: v, wrapped });
      return wrapped;
    },
  });
}
