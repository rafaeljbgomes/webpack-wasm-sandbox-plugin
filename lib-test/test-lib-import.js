import stripAnsi from "strip-ansi";
import stripAnsiNative from "strip-ansi-native";
import { marked } from "marked";
import { marked as markedNative } from "marked-native";

async function runBenchmark(name, fn, iterations = 100) {
  const testString = "\u001B[4mUnicorn\u001B[0m";
  const markdown = "# Test\n\nThis is **bold** and *italic* and `code` with a [link](https://example.com).\n\n" + 
                   "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10);
  
  // Warmup
  for (let i = 0; i < 10; i++) {
    await fn(testString, markdown);
  }
  
  performance.mark(`${name}-start`);
  for (let i = 0; i < iterations; i++) {
    await fn(testString, markdown);
  }
  performance.mark(`${name}-end`);
  performance.measure(name, `${name}-start`, `${name}-end`);
  
  const measure = performance.getEntriesByName(name).pop();
  return measure.duration / iterations;
}

async function main() {
  const output = document.getElementById("output") || document.body;
  
  const resultsDiv = document.createElement('div');
  resultsDiv.style.fontFamily = 'monospace';
  resultsDiv.style.whiteSpace = 'pre';
  resultsDiv.innerHTML = "<h1>Performance Benchmark</h1>\nRunning benchmarks (100 iterations)...\n";
  output.appendChild(resultsDiv);

  try {
    // --- Strip Ansi ---
    const stripAnsiNativeAvg = await runBenchmark("StripAnsi Native", (s) => stripAnsiNative(s));
    resultsDiv.innerHTML += `StripAnsi Native Average: ${stripAnsiNativeAvg.toFixed(4)}ms\n`;

    const stripAnsiSandboxedAvg = await runBenchmark("StripAnsi Sandboxed", (s) => stripAnsi(s));
    resultsDiv.innerHTML += `StripAnsi Sandboxed Average: ${stripAnsiSandboxedAvg.toFixed(4)}ms\n`;

    const stripAnsiOverhead = (stripAnsiSandboxedAvg / stripAnsiNativeAvg).toFixed(2);
    resultsDiv.innerHTML += `StripAnsi Overhead: <b>${stripAnsiOverhead}x slower</b>\n\n`;

    // --- Marked ---
    const markedNativeAvg = await runBenchmark("Marked Native", (_, m) => markedNative.parse(m));
    resultsDiv.innerHTML += `Marked Native Average: ${markedNativeAvg.toFixed(4)}ms\n`;

    const markedSandboxedAvg = await runBenchmark("Marked Sandboxed", (_, m) => marked.parse(m));
    resultsDiv.innerHTML += `Marked Sandboxed Average: ${markedSandboxedAvg.toFixed(4)}ms\n`;

    const markedOverhead = (markedSandboxedAvg / markedNativeAvg).toFixed(2);
    resultsDiv.innerHTML += `Marked Overhead: <b>${markedOverhead}x slower</b>\n\n`;

    // Memory usage info if available
    if (performance.memory) {
      const usedMemory = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2);
      resultsDiv.innerHTML += `JS Heap Usage: ${usedMemory} MB\n`;
    }

  } catch (err) {
    resultsDiv.innerHTML += "\nAn error occurred: " + err.message + "\n";
    console.error("Error in main:", err);
  } finally {
    resultsDiv.innerHTML += "\nBenchmarks completed.\n";
  }
}

main();
