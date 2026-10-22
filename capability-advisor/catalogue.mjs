/** Versioned candidate set; exposure eligibility is a local decision, never a model decision. */
export const CATALOGUE_VERSION = 1;
export const MODEL = "subq-snap-1.1";
export const THRESHOLD = 0.90;
export const CLASSIFICATIONS = ["core_required", "optional_feature", "no_demonstrated_need", "insufficient_evidence"];

const supported = {
  Intl: "Host internationalization constructors and locale data.",
  TextEncoder: "Host UTF-8 text encoding constructor.",
  TextDecoder: "Host text decoding constructor.",
  crypto: "Constrained randomness facade: getRandomValues and optional randomUUID only; no subtle, keys, or host Crypto object.",
};
const sensitive = {
  fetch: "Network requests and response access.",
  XMLHttpRequest: "Network requests through XMLHttpRequest.",
  WebSocket: "Persistent network connections.",
  EventSource: "Server-sent event connections.",
  localStorage: "Persistent origin storage.",
  sessionStorage: "Session origin storage.",
  indexedDB: "Origin databases.",
  document: "Host DOM, cookies and reachable page authority.",
  navigator: "Browser identity and device/service interfaces.",
  location: "Page URL and navigation authority.",
};
const additional = {
  URL: "URL parsing constructor.", URLSearchParams: "URL query parsing constructor.",
  Blob: "Binary blob constructor.", File: "File constructor.", FileReader: "File/blob reading.",
  atob: "Base64 decoding.", btoa: "Base64 encoding.", console: "Host logging.",
  performance: "Host timing and performance interfaces.",
  setTimeout: "Schedule delayed callbacks.", clearTimeout: "Cancel delayed callbacks.",
  setInterval: "Schedule repeated callbacks.", clearInterval: "Cancel repeated callbacks.",
  requestAnimationFrame: "Schedule animation callbacks.", cancelAnimationFrame: "Cancel animation callbacks.",
};

/** Catalogue descriptions describe authority, not a guarantee that an API works through Arena. */
export const CATALOGUE = Object.freeze(Object.entries({ ...supported, ...sensitive, ...additional }).map(([name, description]) => ({
  name,
  description,
  aliases: name === "crypto" ? ["msCrypto"] : [],
  exposure: name in supported ? "supported" : name in sensitive ? "sensitive_review" : "unvalidated",
  coveredMembers: name === "crypto" ? ["getRandomValues", "randomUUID"] : null,
})));
