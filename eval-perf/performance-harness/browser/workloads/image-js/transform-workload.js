import { decode } from "sandbox-real/image-js";

export function transformImage(
  pngBytes,
  {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    blurSigma,
    histogramMaxSlots,
  },
) {
  const sourceImage = decode(pngBytes);
  const cropped = sourceImage.crop({
    x: cropX,
    y: cropY,
    width: cropWidth,
    height: cropHeight,
  });
  const grey = cropped.grey();
  const blurred = grey.gaussianBlur({ sigma: blurSigma });
  const histogram = blurred.histogram({ maxSlots: histogramMaxSlots });
  const mean = blurred.mean();

  return {
    sourceWidth: sourceImage.width,
    sourceHeight: sourceImage.height,
    croppedWidth: cropped.width,
    croppedHeight: cropped.height,
    mean: mean[0],
    histogramLength: histogram.length,
  };
}
