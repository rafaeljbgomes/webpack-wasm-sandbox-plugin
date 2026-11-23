// The one application change the case study needs. The generated proxy loads
// the sandbox with top-level await, so a module that imports a sandboxed
// library finishes evaluating after the window "load" event; the app's
// load listener would never fire. Start immediately if the page has loaded.
// Applied in every mode, so native and sandbox run the same application code.
module.exports = function (source) {
  const before = 'window.addEventListener("load", () => {\n    init();\n});';
  if (!source.includes(before)) throw new Error("start-after-load-loader: pattern not found");
  return source.replace(before, 'if (document.readyState === "complete") { init(); } else { window.addEventListener("load", () => { init(); }); }');
};
