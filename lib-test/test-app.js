import { SandboxManager } from "./sandbox-manager.js";

// This acts as the auto-generated Proxy module for strip-ansi
// It exposes exactly the same API as the original library
let librarySandbox = null;

async function getSandbox(libraryName) {
  if (!librarySandbox) {
    // 1. Fetch the actual compiled library from the virtual path or dist folder
    const response = await fetch(`/dist/${libraryName}.bundle.js`);
    const libraryCode = await response.text();

    // 2. Create the sandbox environment
    librarySandbox = await SandboxManager.createSandbox(
      libraryName,
      libraryCode,
    );
  }
  return librarySandbox;
}

// Proxied default export
export default async function stripAnsi(...args) {
  const sandbox = await getSandbox("strip-ansi");

  // Here we directly call the exported library method inside the QuickJS Sandbox.
  // The 'Arena' syncing mechanism automatically intercepts the arguments, marshals them,
  // evaluates the code safely in Wasm, and then automatically unmarshals the result back
  // into standard JS, skipping manual JSON stringification or parameter extraction entirely!
  // This maintains total transparency for the developer.
  return sandbox.exports.default(...args);
}

// Ensure sandbox disposal when not needed (mock hook for library lifecycle management)
export function disposeLibrary() {
  if (librarySandbox) {
    librarySandbox.dispose();
    librarySandbox = null;
  }
}

async function main() {
  const output = document.getElementById("output");
  if (!output) return;

  output.innerText +=
    "Host: Testing real strip-ansi proxy loaded from node_modules...\n";
  const testString = "\u001B[4mUnicorn\u001B[0m";

  // Output without stringification to prove it behaves like a normal string
  output.innerText += "Host: Original string format: " + testString + "\n";
  output.innerText += "Host: Original object type: " + typeof testString + "\n";

  const clean = await stripAnsi(testString);

  output.innerText += "Host: Cleaned string format: " + clean + "\n";
  output.innerText += "Host: Cleaned object type: " + typeof clean + "\n";

  try {

    // Test WebAPI restriction
    output.innerText +=
      "\n[Security Test]: Attempting to access localStorage in sandbox...\n";
    try {
      librarySandbox.arena.evalCode(`localStorage.setItem('hacked', 'yes');`);
      output.innerText += "FAIL: Sandbox was able to access localStorage!\n";
    } catch (secErr) {
      output.innerText +=
        "SUCCESS: localStorage access correctly blocked by SandboxManager!\n";
      console.log("Blocked API Access:", secErr.message);
    }

    output.innerText +=
      "\n[Security Test]: Attempting to use console in sandbox...\n";
    librarySandbox.arena.evalCode(
      `console.log("SUCCESS: Console API access is working properly in the sandbox!");`,
    );
    output.innerText +=
      "SUCCESS: Console output generated successfully! (Check devtools)\n";

    console.log("Stripped:", clean);
  } catch (err) {
    output.innerText += "Host: An error occurred: " + err.message + "\n";
    console.error("Error in main:", err);
  } finally {
    // Cleanup afterwards
    disposeLibrary();
    output.innerText += "Host: Disposed sandbox to prevent memory leaks.\n";
  }
}

main();
