import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/core/image.ts';

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/** A JPEG with a metadata segment before the frame header, as real files have. */
function jpeg(width: number, height: number, frameMarker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x01, 0x02,
    0xff, frameMarker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  ]);
}

describe('sniffImage', () => {
  it('reads a PNG', () => {
    expect(sniffImage(png(800, 600))).toEqual({ format: 'png', width: 800, height: 600 });
  });

  it('reads baseline and progressive JPEGs past their metadata', () => {
    expect(sniffImage(jpeg(1200, 400))).toEqual({ format: 'jpg', width: 1200, height: 400 });
    expect(sniffImage(jpeg(640, 480, 0xc2))).toEqual({ format: 'jpg', width: 640, height: 480 });
  });

  it('takes an image inside a larger buffer', () => {
    const source = jpeg(700, 700);
    const buffer = new Uint8Array(source.length + 10);
    buffer.set(source, 10);
    expect(sniffImage(buffer.subarray(10))).toEqual({ format: 'jpg', width: 700, height: 700 });
  });

  it('refuses a web page served at an image URL', () => {
    expect(sniffImage(new TextEncoder().encode('<!DOCTYPE html><html></html>'))).toBeNull();
  });

  it('refuses empty, truncated and zero-sized files', () => {
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(png(800, 600).subarray(0, 20))).toBeNull();
    expect(sniffImage(jpeg(800, 600).subarray(0, 14))).toBeNull();
    expect(sniffImage(png(0, 600))).toBeNull();
  });

  it('refuses a JPEG that declares a segment past its end', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toBeNull();
  });
});
