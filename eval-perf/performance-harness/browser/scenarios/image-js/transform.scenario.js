import { decode } from "image-js";
import samplePngBytes from "../../fixtures/image-js/sample-image.png";

export default function run() {
  const sourceImage = decode(samplePngBytes);
  const cropped = sourceImage.crop({ x: 8, y: 8, width: 32, height: 32 });
  const grey = cropped.grey();
  const blurred = grey.gaussianBlur({ sigma: 1 });
  const histogram = blurred.histogram({ maxSlots: 32 });
  const mean = blurred.mean();

  if (
    sourceImage.width !== 48 ||
    sourceImage.height !== 48 ||
    cropped.width !== 32 ||
    cropped.height !== 32 ||
    !Array.isArray(mean) ||
    mean[0] <= 0 ||
    histogram.length === 0
  ) {
    throw new Error("Image.js scenario produced invalid transform output.");
  }
}
