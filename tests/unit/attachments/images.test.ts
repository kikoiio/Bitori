import {mkdtemp, rm, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {imageAttachmentFromBytes, imageAttachmentSchema, imageAttachmentsSchema, imageDataUrl, loadImageAttachment} from '../../../src/attachments/images.js';

const directories: string[] = [];
const ONE_PIXEL_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

function gifWithComment(targetBytes = ONE_PIXEL_GIF.byteLength + 3): Uint8Array {
  const prefix = ONE_PIXEL_GIF.subarray(0, 19);
  const image = ONE_PIXEL_GIF.subarray(19);
  let payloadBytes = Math.max(0, targetBytes - prefix.byteLength - image.byteLength - 3);
  while (true) {
    const blocks = Math.ceil(payloadBytes / 255);
    const next = targetBytes - prefix.byteLength - image.byteLength - 3 - blocks;
    if (next === payloadBytes) break;
    payloadBytes = next;
  }
  const output = new Uint8Array(targetBytes);
  output.set(prefix);
  let offset = prefix.byteLength;
  output[offset++] = 0x21;
  output[offset++] = 0xfe;
  let remaining = payloadBytes;
  while (remaining > 0) {
    const blockLength = Math.min(255, remaining);
    output[offset++] = blockLength;
    offset += blockLength;
    remaining -= blockLength;
  }
  output[offset++] = 0;
  output.set(image, offset);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function onePixelPng(width = 1, height = 1): Uint8Array {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

function onePixelJpeg(): Uint8Array {
  const segment = (marker: number, data: Uint8Array): Buffer => {
    const header = Buffer.alloc(4);
    header.set([0xff, marker]);
    header.writeUInt16BE(data.byteLength + 2, 2);
    return Buffer.concat([header, data]);
  };
  const quantizationTable = Buffer.from([0, ...Array.from({length: 64}, () => 1)]);
  const huffmanTable = (id: number) => Buffer.from([id, 1, ...Array.from({length: 15}, () => 0), 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, quantizationTable),
    segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xc4, huffmanTable(0)),
    segment(0xc4, huffmanTable(0x10)),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x3f, 0xff, 0xd9]),
  ]);
}

describe('本地图片附件边界', () => {
  it('由真实文件签名识别 PNG、JPEG、GIF 并生成纯 base64 data URL', () => {
    const examples = [
      {bytes: onePixelPng(), mediaType: 'image/png'},
      {bytes: onePixelJpeg(), mediaType: 'image/jpeg'},
      {bytes: ONE_PIXEL_GIF, mediaType: 'image/gif'},
    ] as const;

    for (const example of examples) {
      const image = imageAttachmentFromBytes(example.bytes, 'image.bin');
      expect(image).toMatchObject({name: 'image.bin', mediaType: example.mediaType});
      expect(image.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(imageDataUrl(image)).toBe(`data:${example.mediaType};base64,${image.data}`);
      expect(imageAttachmentSchema.safeParse(image).success).toBe(true);
    }
  });

  it('拒绝 MIME 伪造、非规范 base64 和截断图像', () => {
    const gif = imageAttachmentFromBytes(ONE_PIXEL_GIF, 'one.gif');
    expect(imageAttachmentSchema.safeParse({...gif, mediaType: 'image/png'}).success).toBe(false);
    expect(imageAttachmentSchema.safeParse({...gif, mediaType: 'image/webp'}).success).toBe(false);
    expect(imageAttachmentSchema.safeParse({...gif, data: `${gif.data}\n`}).success).toBe(false);
    expect(() => imageAttachmentFromBytes(ONE_PIXEL_GIF.subarray(0, ONE_PIXEL_GIF.length - 1), 'broken.gif')).toThrow();
    const brokenSubBlock = ONE_PIXEL_GIF.slice();
    brokenSubBlock[30] = 0xff;
    expect(() => imageAttachmentFromBytes(brokenSubBlock, 'broken-block.gif')).toThrow();
  });

  it('拒绝只有 WebP 签名而 RIFF chunk 被截断的文件', () => {
    const truncatedWebp = Buffer.from('RIFF\x0c\x00\x00\x00WEBPVP8L');
    expect(() => imageAttachmentFromBytes(truncatedWebp, 'broken.webp')).toThrow();
  });

  it('拒绝边长超过 8192 或像素超过 20 MP 的图片', () => {
    expect(() => imageAttachmentFromBytes(onePixelPng(8193, 1), 'wide.png')).toThrow('8192');
    expect(() => imageAttachmentFromBytes(onePixelPng(5000, 4001), 'large.png')).toThrow('20 MP');
  });

  it('限制单张 4 MiB、最多四张及总量 8 MiB', () => {
    const small = imageAttachmentFromBytes(ONE_PIXEL_GIF, 'small.gif');
    expect(imageAttachmentsSchema.safeParse([small, small, small, small]).success).toBe(true);
    expect(imageAttachmentsSchema.safeParse([small, small, small, small, small]).success).toBe(false);

    const imageAtLimit = imageAttachmentFromBytes(gifWithComment(4 * 1024 * 1024), 'limit.gif');
    expect(imageAttachmentSchema.safeParse(imageAtLimit).success).toBe(true);
    const threeMegabyteImage = imageAttachmentFromBytes(gifWithComment(3 * 1024 * 1024), 'large.gif');
    expect(imageAttachmentsSchema.safeParse([threeMegabyteImage, threeMegabyteImage, threeMegabyteImage]).success).toBe(false);

    const overLimit = {name: 'large.gif', mediaType: 'image/gif', data: Buffer.from(gifWithComment(4 * 1024 * 1024 + 1)).toString('base64')};
    expect(imageAttachmentSchema.safeParse(overLimit).success).toBe(false);
  });

  it('读取前检查常规文件及 stat 大小，再按签名加载', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bitori-images-'));
    directories.push(directory);
    const path = join(directory, 'renamed.dat');
    await writeFile(path, ONE_PIXEL_GIF);
    await expect(loadImageAttachment(path)).resolves.toMatchObject({name: 'renamed.dat', mediaType: 'image/gif'});
    await expect(loadImageAttachment(directory)).rejects.toThrow();
    const oversizedPath = join(directory, 'oversized.dat');
    await writeFile(oversizedPath, new Uint8Array());
    await truncate(oversizedPath, 4 * 1024 * 1024 + 1);
    await expect(loadImageAttachment(oversizedPath)).rejects.toThrow('4 MiB');
  });
});
