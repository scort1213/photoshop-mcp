/** Read JPEG SOF dimensions without decoding pixels or trusting script metadata. */
export function jpegDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) {
    throw new Error('invalid_preview: incomplete JPEG');
  }
  let offset = 2;
  while (offset < data.length - 2) {
    if (data[offset++] !== 0xff) break;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) break;
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) break;
      return { width, height };
    }
    offset += length;
  }
  throw new Error('invalid_preview: missing JPEG dimensions');
}
