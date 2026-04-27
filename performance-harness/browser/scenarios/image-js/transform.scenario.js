import { Image } from "image-js";

function createSampleImage() {
  const image = new Image(48, 48, { kind: "RGB" });

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      image.setPixel(x, y, [
        (x * 5 + y) % 256,
        (y * 7 + x) % 256,
        ((x + y) * 3) % 256,
      ]);
    }
  }

  return image;
}

const sourceImage = createSampleImage();

export default function run() {
  const cropped = sourceImage.crop({ x: 8, y: 8, width: 32, height: 32 });
  const grey = cropped.grey();
  const blurred = grey.gaussianBlur({ sigma: 1 });
  const histogram = blurred.histogram({ maxSlots: 32 });
  const mean = blurred.mean();

  if (
    cropped.width !== 32 ||
    cropped.height !== 32 ||
    !Array.isArray(mean) ||
    mean[0] <= 0 ||
    histogram.length === 0
  ) {
    throw new Error("Image.js scenario produced invalid transform output.");
  }
}
