import { Image, encodeDataURL } from "image-js";
import { renderScenarioResult } from "./reporter.js";

const mode = __SECURITY_MODE__;
const attackKey = "__security_image_attack__";
const attackValue = "written-by-image-js";
const hostCanaryKey = "__security_image_host_canary__";
const hostCanaryValue = "host-storage-canary";

localStorage.removeItem(attackKey);
localStorage.setItem(hostCanaryKey, hostCanaryValue);

try {
  const image = new Image(4, 4, { kind: "RGB" });

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      image.setPixel(x, y, [x * 40, y * 40, (x + y) * 20]);
    }
  }

  const transformed = image.grey().gaussianBlur({ sigma: 1 });
  const dataUrl = encodeDataURL(transformed);
  const attackValueAfter = localStorage.getItem(attackKey);
  const hostCanaryAfter = localStorage.getItem(hostCanaryKey);
  const expectedAttackValue =
    mode === "native" ? attackValue : null;

  renderScenarioResult(
    `image-js Granular Permissions (${mode})`,
    [
      {
        observation: "Image transformation",
        expected: "4x4 output",
        observed: `${transformed.width}x${transformed.height}`,
        pass: transformed.width === 4 && transformed.height === 4,
      },
      {
        observation: "PNG Data URL encoding through TextDecoder",
        expected: "created",
        observed: dataUrl.startsWith("data:image/png;base64,")
          ? "created"
          : "not created",
        pass: dataUrl.startsWith("data:image/png;base64,"),
      },
      {
        observation: "Patched image-js localStorage write",
        expected: expectedAttackValue ?? "blocked",
        observed: attackValueAfter ?? "blocked",
        pass: attackValueAfter === expectedAttackValue,
      },
      {
        observation: "Existing host localStorage canary",
        expected: hostCanaryValue,
        observed: hostCanaryAfter,
        pass: hostCanaryAfter === hostCanaryValue,
      },
    ],
    [
      "The installed image-js package contains a harmless evaluation patch in encodeDataURL that attempts to write a localStorage canary.",
      mode === "native"
        ? "Native execution completed the normal image operation and the additional localStorage write."
        : "The configured TextDecoder capability allowed encoding, while the unconfigured localStorage capability remained unavailable.",
    ],
  );
} finally {
  localStorage.removeItem(attackKey);
  localStorage.removeItem(hostCanaryKey);
}
