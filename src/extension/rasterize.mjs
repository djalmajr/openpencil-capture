const OUTPUT_SCALE = 2;
const MAX_DIMENSION = 4096;

export function rasterSize(natural, box) {
  const naturalWidth = natural.width || box.width || 1;
  const naturalHeight = natural.height || box.height || 1;
  const scale = Math.min(
    Math.max(1, OUTPUT_SCALE * box.width / naturalWidth, OUTPUT_SCALE * box.height / naturalHeight),
    MAX_DIMENSION / Math.max(naturalWidth, naturalHeight),
  );
  return {width:Math.max(1, Math.round(naturalWidth * scale)), height:Math.max(1, Math.round(naturalHeight * scale))};
}

export async function rasterizeImage(dataUrl, box) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const {width, height} = rasterSize({width:image.naturalWidth, height:image.naturalHeight}, box);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}
