// Ulearning (优学院) request-body cipher, aligned with the page helper:
// `CryptoJS.DES.encrypt(JSON.stringify(payload), Utf8.parse("12345678"),
//  { mode: ECB, padding: Pkcs7 }).toString()`.
//
// DES is implemented locally (no dependency): bit-level tables from FIPS 46-3,
// ECB block mode, PKCS#7 padding and base64 output. Only `payload` bodies are
// encrypted; query strings and headers stay plaintext.

const KEY = '12345678';

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13,
  12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOXES: number[][][] = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
  ],
];

type Bits = number[];

function bytesToBits(bytes: Uint8Array): Bits {
  const bits: number[] = [];
  for (const byte of bytes) {
    for (let index = 7; index >= 0; index -= 1) bits.push((byte >> index) & 1);
  }
  return bits;
}

function bitsToBytes(bits: Bits): Uint8Array {
  const bytes = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bytes.length; index += 1) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) value = (value << 1) | bits[index * 8 + offset];
    bytes[index] = value;
  }
  return bytes;
}

/** Apply a 1-based permutation table (FIPS style). */
export function permute(bits: Bits, table: readonly number[]): Bits {
  return table.map((position) => bits[position - 1]);
}

function leftShift(bits: Bits, count: number): Bits {
  return [...bits.slice(count), ...bits.slice(0, count)];
}

function xorBits(left: Bits, right: Bits): Bits {
  return left.map((bit, index) => bit ^ right[index]);
}

/** Build the 16 48-bit round subkeys from one 8-byte key. */
export function keySchedule(keyBytes: Uint8Array): Bits[] {
  const keyBits = permute(bytesToBits(keyBytes), PC1);
  let left = keyBits.slice(0, 28);
  let right = keyBits.slice(28);
  const subkeys: Bits[] = [];
  for (const shift of SHIFTS) {
    left = leftShift(left, shift);
    right = leftShift(right, shift);
    subkeys.push(permute([...left, ...right], PC2));
  }
  return subkeys;
}

function feistel(right: Bits, subkey: Bits): Bits {
  const expanded = permute(right, E);
  const mixed = xorBits(expanded, subkey);
  const output: number[] = [];
  for (let box = 0; box < 8; box += 1) {
    const group = mixed.slice(box * 6, box * 6 + 6);
    const row = (group[0] << 1) | group[5];
    const column = (group[1] << 3) | (group[2] << 2) | (group[3] << 1) | group[4];
    const value = SBOXES[box][row][column];
    for (let bit = 3; bit >= 0; bit -= 1) output.push((value >> bit) & 1);
  }
  return permute(output, P);
}

function cryptBlock(block: Uint8Array, subkeys: Bits[], decrypt: boolean): Uint8Array {
  const ordered = decrypt ? [...subkeys].reverse() : subkeys;
  const bits = permute(bytesToBits(block), IP);
  let left = bits.slice(0, 32);
  let right = bits.slice(32);
  for (const subkey of ordered) {
    const next = xorBits(left, feistel(right, subkey));
    left = right;
    right = next;
  }
  const output = permute([...right, ...left], FP);
  return bitsToBytes(output);
}

/** Encrypt one 8-byte block; exported for the FIPS test vector. */
export function desEncryptBlock(block: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  return cryptBlock(block, keySchedule(keyBytes), false);
}

/** Decrypt one 8-byte block (tests / round-trips). */
export function desDecryptBlock(block: Uint8Array, keyBytes: Uint8Array): Uint8Array {
  return cryptBlock(block, keySchedule(keyBytes), true);
}

/** DES-ECB + PKCS#7 + base64, the exact shape the page sends. */
export function desEncryptEcbBase64(plaintext: string, key = KEY): string {
  const keyBytes = new TextEncoder().encode(key);
  if (keyBytes.length !== 8) throw new Error('DES 密钥必须为 8 字节');
  const data = new TextEncoder().encode(plaintext);
  const pad = 8 - (data.length % 8);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const subkeys = keySchedule(keyBytes);
  for (let offset = 0; offset < padded.length; offset += 8) {
    padded.set(cryptBlock(padded.subarray(offset, offset + 8), subkeys, false), offset);
  }
  return bytesToBase64(padded);
}

/** Decrypt a DES-ECB/PKCS#7/base64 payload (tests / self-check). */
export function desDecryptEcbBase64(ciphertext: string, key = KEY): string {
  const keyBytes = new TextEncoder().encode(key);
  if (keyBytes.length !== 8) throw new Error('DES 密钥必须为 8 字节');
  const data = base64ToBytes(ciphertext);
  if (data.length === 0 || data.length % 8 !== 0) throw new Error('DES 密文长度无效');
  const subkeys = keySchedule(keyBytes);
  const plain = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 8) {
    plain.set(cryptBlock(data.subarray(offset, offset + 8), subkeys, true), offset);
  }
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 8 || pad > plain.length) throw new Error('DES 填充无效');
  return new TextDecoder().decode(plain.subarray(0, plain.length - pad));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Hex helpers used by the FIPS/KAT tests. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Format bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
