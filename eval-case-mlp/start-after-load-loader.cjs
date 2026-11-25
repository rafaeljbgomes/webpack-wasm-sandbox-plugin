// The one application change the case study needs. The generated proxy loads
// the sandbox with top-level await, so a module that imports a sandboxed
// library finishes evaluating after the window "load" event; the app's
// load listener would never fire. Start immediately if the page has loaded.
// Applied in every mode, so native and sandbox run the same application code.
module.exports = function (source) {
  const before = 'window.addEventListener("load", () => {\n    init();\n});';
  if (!source.includes(before)) throw new Error("start-after-load-loader: pattern not found");
  // Output-integrity study: a variant of the app that forgets to sanitize.
  if (this.getOptions?.().forget) {
    const sanitize = "let sanitized = DOMPurify.sanitize(html);";
    if (!source.includes(sanitize)) throw new Error("start-after-load-loader: sanitize call not found");
    source = source.replace(sanitize, "let sanitized = html;");
  }
  // ...and one that calls marked() itself, a path with no declared contract.
  if (this.getOptions?.().bypass) {
    const call = "let html = marked.parse(markdown, options);";
    if (!source.includes(call)) throw new Error("start-after-load-loader: parse call not found");
    source = source.replace(call, "let html = marked(markdown, options);");
  }
  return source.replace(before, 'if (document.readyState === "complete") { init(); } else { window.addEventListener("load", () => { init(); }); }');
};
