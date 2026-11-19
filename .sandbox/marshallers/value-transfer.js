/**
 * Shared by-value transfer for marshallers that copy a QuickJS value graph to
 * the host (or the host graph into QuickJS) in a single crossing.
 *
 * The Arena's default object unmarshaller registers the host copy of a mutable
 * value by VM identity and reuses it on later crossings, which both loses
 * array properties beyond the indices and serves a stale copy when the VM
 * value changes after it was first seen. It also turns Set and Map into empty,
 * non-functional proxies. A marshaller that claims such a value makes the
 * Arena skip that registration and hand the value here to be copied fresh.
 *
 * A value is \emph{transferable} when its whole reachable graph consists only
 * of JSON primitives, plain objects (with enumerable data properties), arrays,
 * Set, and Map, with no cycles. The encoding is a tagged tree that preserves
 * array elements and extra properties, Set and Map contents, and null
 * prototypes:
 *   [0, primitive]
 *   [1, [[key, enc], ...], nullProtoFlag]   plain object
 *   [2, [enc, ...], [[key, enc], ...]]      array (elements, extra properties)
 *   [3, [enc, ...]]                          Set
 *   [4, [[enc, enc], ...]]                   Map
 */

// VM-side `__plain(v, seen)` and `__enc(v)`; inlined into compiled helpers so
// nothing is added to the sandbox's global object.
export const VM_TRANSFER_SRC = `
  var __isIndex = function (k, len) {
    var n = +k;
    return Number.isInteger(n) && n >= 0 && n < len && String(n) === k;
  };
  var __plain = function (v, seen) {
    if (v === null) return true;
    var t = typeof v;
    if (t === "string" || t === "boolean") return true;
    if (t === "number") return Number.isFinite(v) && !Object.is(v, -0);
    if (t !== "object") return false;
    if (seen.has(v)) return false;
    seen.add(v);
    var ok = true;
    if (v instanceof Set) {
      for (var e of v) { if (!__plain(e, seen)) { ok = false; break; } }
    } else if (v instanceof Map) {
      for (var pair of v) { if (!__plain(pair[0], seen) || !__plain(pair[1], seen)) { ok = false; break; } }
    } else {
      var isArr = Array.isArray(v);
      var proto = Object.getPrototypeOf(v);
      if (isArr ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) {
        ok = false;
      } else {
        for (var kk = Reflect.ownKeys(v), j = 0; j < kk.length; j++) {
          var key = kk[j];
          if (typeof key !== "string") { ok = false; break; }
          if (isArr && key === "length") continue;
          var d = Object.getOwnPropertyDescriptor(v, key);
          if (!("value" in d) || !d.enumerable || !__plain(d.value, seen)) { ok = false; break; }
        }
      }
    }
    seen.delete(v);
    return ok;
  };
  var __enc = function (v) {
    if (v === null || typeof v !== "object") return [0, v];
    if (v instanceof Set) {
      var se = []; for (var e of v) se.push(__enc(e)); return [3, se];
    }
    if (v instanceof Map) {
      var me = []; for (var pair of v) me.push([__enc(pair[0]), __enc(pair[1])]); return [4, me];
    }
    if (Array.isArray(v)) {
      var els = []; for (var i = 0; i < v.length; i++) els.push(__enc(v[i]));
      var extra = [];
      for (var ks = Object.keys(v), a = 0; a < ks.length; a++) {
        if (!__isIndex(ks[a], v.length)) extra.push([ks[a], __enc(v[ks[a]])]);
      }
      return [2, els, extra];
    }
    var entries = [];
    for (var ok2 = Object.keys(v), m = 0; m < ok2.length; m++) entries.push([ok2[m], __enc(v[ok2[m]])]);
    return [1, entries, Object.getPrototypeOf(v) === null ? 1 : 0];
  };
`;

/**
 * Builds a self-contained VM predicate string: the root passes `rootTest` and
 * its whole graph is transferable.
 *
 * @param {string} rootTest A boolean expression over `h`.
 * @returns {string} Expression suitable as a marshaller `handleTest`.
 */
export function transferTest(rootTest) {
  return `(function () {${VM_TRANSFER_SRC}
    return (${rootTest}) && __plain(h, new Set());
  })()`;
}

/** Source of a VM function that JSON-encodes a transferable value graph. */
export const SERIALIZER_SRC = `(function () {${VM_TRANSFER_SRC}
  return function (h) { return JSON.stringify(__enc(h)); };
})()`;

/** Rebuilds a host value from the tagged encoding produced in the VM. */
export function decode(node) {
  switch (node[0]) {
    case 0:
      return node[1];
    case 1: {
      const obj = node[2] ? Object.create(null) : {};
      for (const [k, v] of node[1]) obj[k] = decode(v);
      return obj;
    }
    case 2: {
      const arr = node[1].map(decode);
      for (const [k, v] of node[2]) arr[k] = decode(v);
      return arr;
    }
    case 3:
      return new Set(node[1].map(decode));
    case 4:
      return new Map(node[1].map(([k, v]) => [decode(k), decode(v)]));
    default:
      return undefined;
  }
}

/** Encodes a transferable host value graph to the tagged tree (host side). */
export function encodeHost(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return [0, value];
  if (seen.has(value)) throw new TypeError("cycle");
  seen.add(value);
  let out;
  if (value instanceof Set) {
    out = [3, [...value].map((e) => encodeHost(e, seen))];
  } else if (value instanceof Map) {
    out = [4, [...value].map(([k, v]) => [encodeHost(k, seen), encodeHost(v, seen)])];
  } else if (Array.isArray(value)) {
    const els = value.map((e) => encodeHost(e, seen));
    const extra = [];
    for (const k of Object.keys(value)) {
      const n = +k;
      if (!(Number.isInteger(n) && n >= 0 && n < value.length && String(n) === k)) {
        extra.push([k, encodeHost(value[k], seen)]);
      }
    }
    out = [2, els, extra];
  } else {
    const entries = Object.keys(value).map((k) => [k, encodeHost(value[k], seen)]);
    out = [1, entries, Object.getPrototypeOf(value) === null ? 1 : 0];
  }
  seen.delete(value);
  return out;
}

/** Source of a VM function that rebuilds a value graph from the tagged tree. */
export const VM_DECODER_SRC = `(function () {
  var dec = function (node) {
    switch (node[0]) {
      case 0: return node[1];
      case 1: {
        var obj = node[2] ? Object.create(null) : {};
        for (var e = node[1], i = 0; i < e.length; i++) obj[e[i][0]] = dec(e[i][1]);
        return obj;
      }
      case 2: {
        var arr = node[1].map(dec);
        for (var x = node[2], j = 0; j < x.length; j++) arr[x[j][0]] = dec(x[j][1]);
        return arr;
      }
      case 3: {
        var s = new Set();
        for (var se = node[1], k = 0; k < se.length; k++) s.add(dec(se[k]));
        return s;
      }
      case 4: {
        var m = new Map();
        for (var me = node[1], n = 0; n < me.length; n++) m.set(dec(me[n][0]), dec(me[n][1]));
        return m;
      }
    }
  };
  return function (str) { return dec(JSON.parse(str)); };
})()`;

/** JSON-encodes a transferable host value graph; throws if not transferable. */
export function serializeHost(value) {
  return JSON.stringify(encodeHost(value));
}
