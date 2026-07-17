import { decode, encodeDataURL } from "image-js";
import samplePngBytes from "../../../../performance-harness/browser/fixtures/image-js/sample-image.png";

const mode = __IMAGE_DEMO_MODE__;
const attackKey = "__security_image_attack__";
const attackValue = "written-by-image-js";
const hostCanaryKey = "__security_image_host_canary__";
const hostCanaryValue = "host-storage-canary";

function getStorageSnapshot() {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key !== null)
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
  );
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Image demo element not found: #${id}`);
  element.textContent = value;
}

function setStatus(id, label, state) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Image demo status element not found: #${id}`);
  element.textContent = label;
  element.dataset.state = state;
}

function renderStorage(snapshot) {
  const output = document.getElementById("storage-output");
  if (!output) throw new Error("Image demo storage output element was not found.");
  output.textContent = JSON.stringify({
    [hostCanaryKey]: snapshot[hostCanaryKey] ?? null,
    [attackKey]: snapshot[attackKey] ?? null,
  }, null, 2);
}

function clearDemoStorage() {
  localStorage.removeItem(attackKey);
  localStorage.removeItem(hostCanaryKey);
  renderStorage(getStorageSnapshot());
  setStatus("attack-status", "Awaiting a run", "neutral");
  setStatus("host-status", "Awaiting a run", "neutral");
}

function runDemo() {
  localStorage.removeItem(attackKey);
  localStorage.setItem(hostCanaryKey, hostCanaryValue);

  const sourceImage = decode(samplePngBytes);
  const cropped = sourceImage.crop({ x: 8, y: 8, width: 32, height: 32 });
  const transformed = cropped.grey().gaussianBlur({ sigma: 1 });
  const processedDataUrl = encodeDataURL(transformed);
  const snapshot = getStorageSnapshot();
  const attackValueAfter = snapshot[attackKey] ?? null;
  const hostCanaryAfter = snapshot[hostCanaryKey] ?? null;
  const expectedAttackValue = mode === "native" ? attackValue : null;

  const processedImage = document.getElementById("processed-image");
  if (!(processedImage instanceof HTMLImageElement)) {
    throw new Error("Processed image element was not found.");
  }
  processedImage.src = processedDataUrl;

  setText("execution-mode", mode === "native" ? "Native browser import" : "QuickJS / Wasm isolated import");
  setText("transform-details", `${sourceImage.width}×${sourceImage.height} PNG → crop 32×32 → grayscale → Gaussian blur`);
  setText("output-details", `PNG generated: ${transformed.width}×${transformed.height}`);
  setStatus(
    "attack-status",
    attackValueAfter === attackValue ? "Patch write reached host localStorage" : "Patch write blocked: localStorage was not exposed",
    attackValueAfter === attackValue ? "danger" : "safe",
  );
  setStatus(
    "host-status",
    hostCanaryAfter === hostCanaryValue ? "Host canary preserved" : "Host canary changed unexpectedly",
    hostCanaryAfter === hostCanaryValue ? "safe" : "danger",
  );
  renderStorage(snapshot);

  console.group(`Image.js permission demo (${mode})`);
  console.log("Host localStorage object:", localStorage);
  console.log("Host localStorage snapshot:", snapshot);
  console.table([
    { observation: "Image transformation", expected: "32x32 PNG output", observed: `${transformed.width}x${transformed.height} PNG output`, result: transformed.width === 32 && transformed.height === 32 ? "PASS" : "FAIL" },
    { observation: "Patched image-js localStorage write", expected: expectedAttackValue ?? "blocked", observed: attackValueAfter ?? "blocked", result: attackValueAfter === expectedAttackValue ? "PASS" : "FAIL" },
    { observation: "Existing host localStorage canary", expected: hostCanaryValue, observed: hostCanaryAfter ?? "missing", result: hostCanaryAfter === hostCanaryValue ? "PASS" : "FAIL" },
  ]);
  console.groupEnd();

  if (attackValueAfter !== expectedAttackValue || hostCanaryAfter !== hostCanaryValue) {
    throw new Error(`Unexpected Image.js ${mode} demonstration result.`);
  }
}

const resetButton = document.getElementById("reset-demo");
if (!(resetButton instanceof HTMLButtonElement)) {
  throw new Error("Image demo reset button was not found.");
}
resetButton.addEventListener("click", clearDemoStorage);
runDemo();
