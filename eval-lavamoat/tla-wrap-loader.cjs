// Wraps a scenario module's body (after its import lines) in an async
// function, because LavaMoat's runtime does not support webpack async modules
// (top-level await). The scenario logic is unchanged.
module.exports = function (source) {
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length && (/^\s*import\s/.test(lines[i]) || lines[i].trim() === "")) i++;
  const head = lines.slice(0, i).join("\n");
  const body = lines.slice(i).join("\n");
  return `${head}\n(async () => {\n${body}\n})().catch((e) => { const o = document.getElementById("output"); if (o && !o.querySelector("table")) o.textContent = "SCENARIO ERROR: " + (e && e.message); console.error("SCENARIO ERROR", e && e.message); });\n`;
};
