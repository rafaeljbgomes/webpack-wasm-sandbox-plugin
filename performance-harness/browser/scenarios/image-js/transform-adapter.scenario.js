import { transformImage } from "sandbox-workload/image-js/transform";
import samplePngBytes from "../../fixtures/image-js/sample-image.png";

const options = {
  cropX: 8,
  cropY: 8,
  cropWidth: 32,
  cropHeight: 32,
  blurSigma: 1,
  histogramMaxSlots: 32,
};

export default function run() {
  const result = transformImage(samplePngBytes, options);

  if (
    result.sourceWidth !== 48 ||
    result.sourceHeight !== 48 ||
    result.croppedWidth !== 32 ||
    result.croppedHeight !== 32 ||
    result.mean <= 0 ||
    result.histogramLength === 0
  ) {
    throw new Error("Image.js adapter scenario produced invalid transform output.");
  }
}
