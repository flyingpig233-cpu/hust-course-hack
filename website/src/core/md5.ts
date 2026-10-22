/** RFC 1321 MD5. Used only to reproduce the platform's video signature. */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input), size = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(size); buffer.set(bytes); buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(size - 8, bytes.length * 8 >>> 0, true);
  view.setUint32(size - 4, Math.floor(bytes.length / 0x20000000), true);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < size; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = 7 * i % 16; }
      const sum = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + g * 4, true)) | 0;
      const shift = shifts[Math.floor(i / 16) * 4 + i % 4];
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d; d = c; c = b; b = next;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].flatMap((n) => [0, 8, 16, 24].map((shift) => ((n >>> shift) & 255).toString(16).padStart(2, '0'))).join('');
}
