import {open, stat} from 'node:fs/promises';
import {basename} from 'node:path';
import {z} from 'zod';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_EDGE = 8192;
const MAX_IMAGE_PIXELS = 20_000_000;
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < PNG_CRC_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
  PNG_CRC_TABLE[index] = value >>> 0;
}

interface ImageDimensions {width: number; height: number}

export const imageAttachmentSchema = z.strictObject({
  name: z.string(),
  mediaType: z.enum(MEDIA_TYPES),
  data: z.string(),
}).superRefine((image, context) => {
  const bytes = decodeBase64(image.data);
  if (bytes === null) {
    context.addIssue({code: 'custom', path: ['data'], message: '图片 data 必须是规范的标准 base64'});
    return;
  }
  const issue = imageValidationIssue(bytes, image.mediaType);
  if (issue !== undefined) context.addIssue({code: 'custom', path: ['data'], message: issue});
});

export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;

export const imageAttachmentsSchema = z.array(imageAttachmentSchema).max(MAX_IMAGES, '最多附加 4 张图片').superRefine((images, context) => {
  const totalBytes = images.reduce((total, image) => total + decodedBase64Length(image.data), 0);
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) context.addIssue({code: 'custom', message: '图片附件总大小不能超过 8 MiB'});
});

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length > MAX_BASE64_LENGTH || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, 'base64');
  // Buffer 的 base64 解码较宽松；重编码比对可拒绝空白、非法字符和非规范 padding。
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) return null;
  return bytes;
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? -1;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) * 256 + byteAt(bytes, offset + 1);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) + byteAt(bytes, offset + 1) * 256;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) + byteAt(bytes, offset + 1) * 256 + byteAt(bytes, offset + 2) * 65_536;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) * 16_777_216 + byteAt(bytes, offset + 1) * 65_536 + byteAt(bytes, offset + 2) * 256 + byteAt(bytes, offset + 3);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) + byteAt(bytes, offset + 1) * 256 + byteAt(bytes, offset + 2) * 65_536 + byteAt(bytes, offset + 3) * 16_777_216;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = '';
  for (let index = 0; index < length; index++) result += String.fromCharCode(byteAt(bytes, offset + index));
  return result;
}

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index++) {
    const tableIndex = (crc ^ byteAt(bytes, index)) & 0xff;
    crc = (crc >>> 8) ^ (PNG_CRC_TABLE[tableIndex] ?? 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** PNG chunk、CRC 与 IHDR 检查；不展开或解压 IDAT 像素数据。 */
function parsePng(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((byte, index) => byteAt(bytes, index) === byte)) return undefined;
  let offset = PNG_SIGNATURE.byteLength;
  let dimensions: ImageDimensions | undefined;
  let hasPalette = false;
  let sawImageData = false;
  let hasImageData = false;
  let imageDataEnded = false;
  let indexedColor = false;
  let colorType = -1;

  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32BE(bytes, offset);
    if (length > bytes.byteLength - offset - 12) return undefined;
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || (type.charCodeAt(2) >= 97 && type.charCodeAt(2) <= 122)) return undefined;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (pngCrc32(bytes, offset + 4, dataEnd) !== readUint32BE(bytes, dataEnd)) return undefined;
    if (dimensions === undefined && type !== 'IHDR') return undefined;
    if (sawImageData && type !== 'IDAT') imageDataEnded = true;

    if (type === 'IHDR') {
      if (dimensions !== undefined || length !== 13) return undefined;
      const width = readUint32BE(bytes, dataStart);
      const height = readUint32BE(bytes, dataStart + 4);
      const depth = byteAt(bytes, dataStart + 8);
      const color = byteAt(bytes, dataStart + 9);
      const validDepth = color === 0 ? [1, 2, 4, 8, 16].includes(depth)
        : color === 2 ? [8, 16].includes(depth)
          : color === 3 ? [1, 2, 4, 8].includes(depth)
            : color === 4 || color === 6 ? [8, 16].includes(depth)
              : false;
      if (width < 1 || height < 1 || !validDepth || byteAt(bytes, dataStart + 10) !== 0
        || byteAt(bytes, dataStart + 11) !== 0 || ![0, 1].includes(byteAt(bytes, dataStart + 12))) return undefined;
      dimensions = {width, height};
      indexedColor = color === 3;
      colorType = color;
    } else if (type === 'PLTE') {
      if (hasPalette || sawImageData || length === 0 || length > 768 || length % 3 !== 0 || [0, 4].includes(colorType)) return undefined;
      hasPalette = true;
    } else if (type === 'IDAT') {
      if (imageDataEnded || (indexedColor && !hasPalette)) return undefined;
      sawImageData = true;
      hasImageData ||= length > 0;
    } else if (type === 'IEND') {
      if (length !== 0 || !hasImageData || chunkEnd !== bytes.byteLength) return undefined;
      return dimensions;
    } else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90 && !['IHDR', 'PLTE', 'IDAT'].includes(type)) {
      return undefined;
    }
    offset = chunkEnd;
  }
  return undefined;
}

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG marker、SOF/SOS、段长及 EOI 检查；不解码熵编码扫描数据。 */
function parseJpeg(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 10 || byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== 0xd8) return undefined;
  let offset = 2;
  let dimensions: ImageDimensions | undefined;
  let hasQuantizationTable = false;
  let hasHuffmanTable = false;

  while (offset < bytes.byteLength) {
    if (byteAt(bytes, offset) !== 0xff) return undefined;
    while (byteAt(bytes, offset) === 0xff) offset++;
    const marker = byteAt(bytes, offset++);
    if (marker === 0x00 || marker === 0xd8 || marker < 0) return undefined;
    if (marker === 0xd9) return undefined;
    if (marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) return undefined;
    if (offset + 2 > bytes.byteLength) return undefined;
    const length = readUint16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength) return undefined;
    const dataStart = offset + 2;
    const segmentEnd = offset + length;
    if (marker === 0xda) {
      const components = byteAt(bytes, dataStart);
      if (dimensions === undefined || !hasQuantizationTable || !hasHuffmanTable || components < 1
        || length !== 6 + 2 * components || segmentEnd + 2 >= bytes.byteLength) return undefined;
      return byteAt(bytes, bytes.byteLength - 2) === 0xff && byteAt(bytes, bytes.byteLength - 1) === 0xd9 ? dimensions : undefined;
    }
    if (marker === 0xdb) {
      if (length < 67) return undefined;
      hasQuantizationTable = true;
    }
    if (marker === 0xc4) {
      if (length < 20) return undefined;
      hasHuffmanTable = true;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      const components = byteAt(bytes, dataStart + 5);
      if (dimensions !== undefined || components < 1 || length !== 8 + 3 * components) return undefined;
      const height = readUint16BE(bytes, dataStart + 1);
      const width = readUint16BE(bytes, dataStart + 3);
      if (width === 0 || height === 0) return undefined;
      dimensions = {width, height};
    }
    offset = segmentEnd;
  }
  return undefined;
}

interface GifSubBlocks {next: number; hasData: boolean}

function gifSubBlocks(bytes: Uint8Array, start: number): GifSubBlocks | undefined {
  let offset = start;
  let hasData = false;
  while (offset < bytes.byteLength) {
    const length = byteAt(bytes, offset++);
    if (length === 0) return {next: offset, hasData};
    if (length < 0 || offset + length > bytes.byteLength) return undefined;
    hasData = true;
    offset += length;
  }
  return undefined;
}

/** GIF logical screen、block/sub-block 边界检查；不执行 LZW 解码。 */
function parseGif(bytes: Uint8Array): ImageDimensions | undefined {
  const header = ascii(bytes, 0, 6);
  if (bytes.byteLength < 20 || (header !== 'GIF87a' && header !== 'GIF89a')) return undefined;
  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  if (width === 0 || height === 0) return undefined;
  const screenFlags = byteAt(bytes, 10);
  const hasGlobalColorTable = (screenFlags & 0x80) !== 0;
  let offset = 13;
  if (hasGlobalColorTable) offset += 3 * (1 << ((screenFlags & 0x07) + 1));
  if (offset > bytes.byteLength) return undefined;
  let imageCount = 0;

  while (offset < bytes.byteLength) {
    const block = byteAt(bytes, offset++);
    if (block === 0x3b) return imageCount > 0 && offset === bytes.byteLength ? {width, height} : undefined;
    if (block === 0x21) {
      if (offset >= bytes.byteLength) return undefined;
      const label = byteAt(bytes, offset++);
      const expectedHeaderLength = label === 0xf9 ? 4 : label === 0xff ? 11 : label === 0x01 ? 12 : undefined;
      if (expectedHeaderLength !== undefined && byteAt(bytes, offset) !== expectedHeaderLength) return undefined;
      const subBlocks = gifSubBlocks(bytes, offset);
      if (subBlocks === undefined) return undefined;
      offset = subBlocks.next;
      continue;
    }
    if (block !== 0x2c || offset + 9 > bytes.byteLength) return undefined;
    const frameWidth = readUint16LE(bytes, offset + 4);
    const frameHeight = readUint16LE(bytes, offset + 6);
    if (frameWidth === 0 || frameHeight === 0) return undefined;
    const imageFlags = byteAt(bytes, offset + 8);
    const hasLocalColorTable = (imageFlags & 0x80) !== 0;
    if ((!hasGlobalColorTable && !hasLocalColorTable) || frameWidth > width || frameHeight > height) return undefined;
    offset += 9;
    if (hasLocalColorTable) offset += 3 * (1 << ((imageFlags & 0x07) + 1));
    if (offset >= bytes.byteLength) return undefined;
    const lzwMinimumCodeSize = byteAt(bytes, offset++);
    if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) return undefined;
    const subBlocks = gifSubBlocks(bytes, offset);
    if (subBlocks === undefined || !subBlocks.hasData) return undefined;
    offset = subBlocks.next;
    imageCount++;
  }
  return undefined;
}

function parseWebpFrame(bytes: Uint8Array, type: string, start: number, length: number): ImageDimensions | undefined {
  if (type === 'VP8 ') {
    if (length < 10 || (byteAt(bytes, start) & 1) !== 0
      || byteAt(bytes, start + 3) !== 0x9d || byteAt(bytes, start + 4) !== 0x01 || byteAt(bytes, start + 5) !== 0x2a) return undefined;
    const width = readUint16LE(bytes, start + 6) & 0x3fff;
    const height = readUint16LE(bytes, start + 8) & 0x3fff;
    return width > 0 && height > 0 ? {width, height} : undefined;
  }
  if (type === 'VP8L') {
    if (length < 6 || byteAt(bytes, start) !== 0x2f) return undefined;
    const bits = readUint32LE(bytes, start + 1);
    if (((bits >>> 29) & 0x07) !== 0) return undefined;
    return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1};
  }
  return undefined;
}

function parseAnimatedWebpFrame(bytes: Uint8Array, start: number, length: number): ImageDimensions | undefined {
  if (length < 16) return undefined;
  const dimensions = {width: readUint24LE(bytes, start + 6) + 1, height: readUint24LE(bytes, start + 9) + 1};
  let offset = start + 16;
  const end = start + length;
  let hasImage = false;
  while (offset + 8 <= end) {
    const type = ascii(bytes, offset, 4);
    const chunkLength = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const chunkEnd = dataStart + chunkLength + (chunkLength & 1);
    if (chunkEnd > end) return undefined;
    if (type === 'VP8 ' || type === 'VP8L') {
      if (parseWebpFrame(bytes, type, dataStart, chunkLength) === undefined) return undefined;
      hasImage = true;
    }
    offset = chunkEnd;
  }
  return offset === end && hasImage ? dimensions : undefined;
}

/** WebP RIFF/chunk 与 frame header 检查；不解码 VP8/VP8L 图像数据。 */
function parseWebp(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP'
    || readUint32LE(bytes, 4) + 8 !== bytes.byteLength) return undefined;
  let offset = 12;
  let canvas: ImageDimensions | undefined;
  let frame: ImageDimensions | undefined;
  let hasImage = false;
  let hasExtendedHeader = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const length = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const chunkEnd = dataStart + length + (length & 1);
    if (chunkEnd > bytes.byteLength) return undefined;
    if (type === 'VP8X') {
      if (offset !== 12 || hasExtendedHeader || length !== 10 || (byteAt(bytes, dataStart) & 0xc1) !== 0
        || byteAt(bytes, dataStart + 1) !== 0 || byteAt(bytes, dataStart + 2) !== 0 || byteAt(bytes, dataStart + 3) !== 0) return undefined;
      canvas = {width: readUint24LE(bytes, dataStart + 4) + 1, height: readUint24LE(bytes, dataStart + 7) + 1};
      hasExtendedHeader = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      frame = parseWebpFrame(bytes, type, dataStart, length);
      if (frame === undefined || (canvas !== undefined && (frame.width > canvas.width || frame.height > canvas.height))) return undefined;
      hasImage = true;
    } else if (type === 'ANMF') {
      if (canvas === undefined) return undefined;
      frame = parseAnimatedWebpFrame(bytes, dataStart, length);
      if (frame === undefined || (canvas !== undefined && (frame.width > canvas.width || frame.height > canvas.height))) return undefined;
      hasImage = true;
    }
    offset = chunkEnd;
  }
  return offset === bytes.byteLength && hasImage ? canvas ?? frame : undefined;
}

function detectedMediaType(bytes: Uint8Array): ImageAttachment['mediaType'] | undefined {
  if (PNG_SIGNATURE.every((byte, index) => byteAt(bytes, index) === byte)) return 'image/png';
  if (byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8) return 'image/jpeg';
  const gifHeader = ascii(bytes, 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

function dimensionsIssue(dimensions: ImageDimensions): string | undefined {
  if (dimensions.width > MAX_IMAGE_EDGE || dimensions.height > MAX_IMAGE_EDGE || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return '图片尺寸超出限制（最长边 8192 像素，最多 20 MP）';
  }
  return undefined;
}

function imageValidationIssue(bytes: Uint8Array, expectedMediaType: ImageAttachment['mediaType']): string | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return '单张图片大小必须在 1 至 4 MiB 之间';
  const actualMediaType = detectedMediaType(bytes);
  if (actualMediaType === undefined) return '不支持的图片签名或图片文件已损坏';
  if (actualMediaType !== expectedMediaType) return '图片内容签名与 mediaType 不一致';
  const dimensions = actualMediaType === 'image/png' ? parsePng(bytes)
    : actualMediaType === 'image/jpeg' ? parseJpeg(bytes)
      : actualMediaType === 'image/gif' ? parseGif(bytes)
        : actualMediaType === 'image/webp' ? parseWebp(bytes)
          : undefined;
  if (dimensions === undefined) return '图片文件结构不完整或已损坏';
  return dimensionsIssue(dimensions);
}

export function imageAttachmentFromBytes(bytes: Uint8Array, name: string): ImageAttachment {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('单张图片大小必须在 1 至 4 MiB 之间');
  const mediaType = detectedMediaType(bytes);
  if (mediaType === undefined) throw new Error('不支持的图片签名或图片文件已损坏');
  const issue = imageValidationIssue(bytes, mediaType);
  if (issue !== undefined) throw new Error(issue);
  return {name, mediaType, data: Buffer.from(bytes).toString('base64')};
}

export async function loadImageAttachment(path: string): Promise<ImageAttachment> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('图片路径必须是普通文件');
  if (metadata.size < 1 || metadata.size > MAX_IMAGE_BYTES) throw new Error('单张图片大小必须在 1 至 4 MiB 之间');

  const file = await open(path, 'r');
  try {
    const openedMetadata = await file.stat();
    if (!openedMetadata.isFile()) throw new Error('图片路径必须是普通文件');
    if (openedMetadata.size < 1 || openedMetadata.size > MAX_IMAGE_BYTES) throw new Error('单张图片大小必须在 1 至 4 MiB 之间');
    const buffer = Buffer.allocUnsafe(openedMetadata.size + 1);
    let read = 0;
    while (read < buffer.byteLength) {
      const result = await file.read(buffer, read, buffer.byteLength - read, null);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    if (read > MAX_IMAGE_BYTES) throw new Error('单张图片大小不能超过 4 MiB');
    const finalMetadata = await file.stat();
    if (read !== openedMetadata.size || finalMetadata.size !== openedMetadata.size) throw new Error('读取期间图片文件发生变化');
    return imageAttachmentFromBytes(buffer.subarray(0, read), basename(path));
  } finally {
    await file.close();
  }
}

export function imageDataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
