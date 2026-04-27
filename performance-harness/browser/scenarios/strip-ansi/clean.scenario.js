import stripAnsi from "strip-ansi";

const logLines = Array.from({ length: 80 }, (_, index) => {
  const color = index % 2 === 0 ? "\u001B[32m" : "\u001B[31m";
  return `${color}task-${index + 1}\u001B[0m completed in \u001B[1m${10 + index}ms\u001B[22m`;
});

export default function run() {
  const cleanLines = logLines.map((line) => stripAnsi(line));
  const summary = cleanLines.join("\n");

  if (
    cleanLines.length !== logLines.length ||
    summary.includes("\u001B[") ||
    !summary.includes("task-1 completed in 10ms")
  ) {
    throw new Error("strip-ansi scenario produced invalid clean output.");
  }
}
