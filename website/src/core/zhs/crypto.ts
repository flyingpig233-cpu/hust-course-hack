// Zhihuishu protocol cryptography, aligned with `src/zhihuishu/crypto.rs`.
//
// Every API payload is a JSON object encrypted with AES-128-CBC (PKCS#7) and
// base64-encoded into `secretStr`; the AES key itself is delivered by the
// `labc`-equivalent module-key flow: RSAES-PKCS1-v1_5 of `{"module":n}` sent to
// `appcomm-user`, then a raw public-key operation over the returned `rt.sl` blob.
// The RSA helpers use BigInt so they depend neither on WebCrypto support for
// PKCS#1 v1.5 encryption nor on a private key.
import type { ZhsTransport } from './transport.ts';

export const AES_IV = '1g3qqdh4jvbskb9x';
export const MODULE_VIDEO = 11;
export const MODULE_MEET = 9;
/** Module used by the online-service course-list endpoint (`queryShareCourseInfo`). */
export const MODULE_ONLINESERVICE = 13;
export const VIDEO_MODULE_KEY_FALLBACK = 'azp53h0kft7qi78q';
export const XOR_KEY_VIDEO = 'zzpttjd';
export const XOR_KEY_COURSE = 'zhihuishu';
export const XOR_KEY_MEET = 'zhihuishu';
export const MODULE_KEY_TTL_MS = 30 * 60 * 1000;
export const APP_USER_ORIGIN = 'https://appcomm-user.zhihuishu.com';
export const MODULE_KEY_PATH = '/app-commserv-user/c/has';

/** RSA public key (SPKI, base64) shared by every Zhihuishu module. */
export const PUBLIC_KEY_B64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCgfZmpLpPEpEFRKBe+ZjWJUjPe+7qg7pGqcfN3j2egJ8H2mrKwaEqZEnPnpi2O3hN8HRyaFozDOp8gwZiYfiIZjWy0Jr/FNAiiKYh5bq0GsEn+ieMmRyJg/+i1rqizhvCXvFdrdGhFTw5EBwTpsGdwe1utdlrvIJUAFWj9Yh4qbQIDAQAB';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode UTF-8 text to bytes. */
export function utf8ToBytes(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Decode UTF-8 bytes to text. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Encode bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Decode standard base64 to bytes. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** AES-128-CBC/PKCS#7 encrypt with the fixed protocol IV. */
export async function encryptSecret(key: string, plaintext: string): Promise<string> {
  const cipher = await crypto.subtle.importKey('raw', utf8ToBytes(key), { name: 'AES-CBC' }, false, ['encrypt']);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: utf8ToBytes(AES_IV) }, cipher, utf8ToBytes(plaintext));
  return bytesToBase64(new Uint8Array(sealed));
}

/** AES-128-CBC/PKCS#7 decrypt; used by self-checks and tests. */
export async function decryptSecret(key: string, ciphertext: string): Promise<string> {
  const cipher = await crypto.subtle.importKey('raw', utf8ToBytes(key), { name: 'AES-CBC' }, false, ['decrypt']);
  const opened = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: utf8ToBytes(AES_IV) }, cipher, base64ToBytes(ciphertext));
  return bytesToUtf8(new Uint8Array(opened));
}

/**
 * XOR-encode fields the same way the platform does: join with `;`, XOR every
 * UTF-16 code unit with the key, format as lowercase hex padded to at least two
 * characters, then keep the last four characters. Non-ASCII values produce
 * four-character groups, matching the page helper.
 */
export function xorEncode(fields: Array<string | number>, key: string): string {
  const source = fields.map((field) => String(field)).join(';');
  let out = '';
  for (let index = 0; index < source.length; index += 1) {
    const value = source.charCodeAt(index) ^ key.charCodeAt(index % key.length);
    let hex = value.toString(16);
    if (hex.length < 2) hex = `0${hex}`;
    out += hex.slice(-4);
  }
  return out;
}

/** Decode an XOR-encoded string back to text (used to parse study-page URLs). */
export function xorDecode(encoded: string, key: string): string {
  let out = '';
  for (let index = 0; index + 2 <= encoded.length; index += 2) {
    const value = Number.parseInt(encoded.slice(index, index + 2), 16);
    if (Number.isNaN(value)) throw new Error('XOR 解码失败：包含非法字符');
    out += String.fromCharCode(value ^ key.charCodeAt((index / 2) % key.length));
  }
  return out;
}

/** Format seconds as `HH:MM:SS` with two-digit fields. */
export function hms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Parse `HH:MM:SS` (or `MM:SS`) back to seconds; `null` when invalid. */
export function parseHms(value: string): number | null {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((number) => !Number.isInteger(number) || number < 0)) return null;
  return numbers.reduce((total, number) => total * 60 + number, 0);
}

/**
 * Playback heartbeat points used by `ewssw`: `0,1` followed by one entry per
 * simulated two-second tick, mirroring the page's own loop and the verified
 * Rust implementation.
 */
export function watchPoints(durationSecs: number): string {
  const values = ['0', '1'];
  for (let tick = 0; tick * 1.99 < durationSecs; tick += 1) {
    values.push(String(Math.floor((tick * 1.99) / 4.99) + 2));
  }
  return values.join(',');
}

interface DerTlv {
  tag: number;
  valueStart: number;
  valueEnd: number;
  next: number;
}

function readDerTlv(bytes: Uint8Array, offset: number): DerTlv {
  if (offset + 2 > bytes.length) throw new Error('RSA 公钥解析失败：DER 长度不足');
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = bytes[cursor];
  cursor += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error('RSA 公钥解析失败：DER 长度无效');
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[cursor + index];
    cursor += count;
  }
  if (cursor + length > bytes.length) throw new Error('RSA 公钥解析失败：DER 越界');
  return { tag, valueStart: cursor, valueEnd: cursor + length, next: cursor + length };
}

function readBigInt(bytes: Uint8Array, start: number, end: number): bigint {
  let value = 0n;
  for (let index = start; index < end; index += 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

/** Parse modulus/exponent out of an SPKI DER RSA public key. */
export function parsePublicKey(publicKeyB64: string): { modulus: bigint; exponent: bigint } {
  const bytes = base64ToBytes(publicKeyB64);
  const outer = readDerTlv(bytes, 0);
  if (outer.tag !== 0x30) throw new Error('RSA 公钥解析失败：缺少 SPKI 序列');
  const algorithm = readDerTlv(bytes, outer.valueStart);
  const bitString = readDerTlv(bytes, algorithm.next);
  if (bitString.tag !== 0x03) throw new Error('RSA 公钥解析失败：缺少 BIT STRING');
  const keySequence = readDerTlv(bytes, bitString.valueStart + 1);
  if (keySequence.tag !== 0x30) throw new Error('RSA 公钥解析失败：缺少 RSAPublicKey');
  const modulus = readDerTlv(bytes, keySequence.valueStart);
  const exponent = readDerTlv(bytes, modulus.next);
  if (modulus.tag !== 0x02 || exponent.tag !== 0x02) throw new Error('RSA 公钥解析失败：缺少整数');
  return {
    modulus: readBigInt(bytes, modulus.valueStart, modulus.valueEnd),
    exponent: readBigInt(bytes, exponent.valueStart, exponent.valueEnd),
  };
}

/** Modular exponentiation over BigInt. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) throw new Error('RSA 运算失败：模数无效');
  let result = 1n;
  let factor = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    power >>= 1n;
  }
  return result;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array<ArrayBuffer> {
  let hex = value.toString(16);
  while (hex.length < length * 2) hex = `0${hex}`;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * RSAES-PKCS1-v1_5 encrypt. WebCrypto exposes this primitive in browsers but not
 * in Node, so the BigInt construction is the portable fallback (and the only
 * implementation used by tests).
 */
export async function rsaEncryptPkcs1v15(publicKeyB64: string, plaintext: string): Promise<string> {
  const { modulus, exponent } = parsePublicKey(publicKeyB64);
  const message = utf8ToBytes(plaintext);
  const size = Math.ceil(modulus.toString(16).length / 2);
  if (message.length > size - 11) throw new Error('RSA 加密失败：明文过长');
  const padding = randomBytes(size - message.length - 3);
  for (let index = 0; index < padding.length; index += 1) {
    // PKCS#1 v1.5 requires every padding byte to be non-zero.
    padding[index] = (padding[index] % 255) + 1;
  }
  const block = new Uint8Array(size);
  block[1] = 0x02;
  block.set(padding, 2);
  block[padding.length + 2] = 0x00;
  block.set(message, padding.length + 3);
  const encrypted = modPow(bytesToBigInt(block), exponent, modulus);
  return bytesToBase64(bigIntToBytes(encrypted, size));
}

/** Recover `c^e mod n` and strip the PKCS#1 v1.5 type-2 padding. */
export async function rsaPublicUnpad(publicKeyB64: string, blobB64: string): Promise<string> {
  const { modulus, exponent } = parsePublicKey(publicKeyB64);
  const size = Math.ceil(modulus.toString(16).length / 2);
  const blob = base64ToBytes(blobB64);
  if (blob.length !== size) throw new Error('模块密钥 blob 长度与公钥不匹配');
  const decrypted = modPow(bytesToBigInt(blob), exponent, modulus);
  const block = bigIntToBytes(decrypted, size);
  // The platform wraps the module key with EMSA-PKCS1-v1_5 (00 01 FF..FF 00
  // message); accept type 2 as well so both page flavours can be unpacked.
  if (block[0] !== 0x00 || (block[1] !== 0x01 && block[1] !== 0x02)) {
    throw new Error('模块密钥解包失败：PKCS#1 头部无效');
  }
  let separator = 2;
  while (separator < block.length && block[separator] !== 0x00) separator += 1;
  if (separator < 10 || separator >= block.length) throw new Error('模块密钥解包失败：填充无效');
  return bytesToUtf8(block.subarray(separator + 1));
}

/** Fixed-TTL cache for module AES keys (30 minutes, like the page helper). */
export class ModuleKeyCache {
  private readonly entries = new Map<number, { key: string; expiresAt: number }>();

  /** Return a cached key while it is still fresh. */
  get(module: number, now = Date.now()): string | null {
    const entry = this.entries.get(module);
    if (!entry || entry.expiresAt <= now) {
      this.entries.delete(module);
      return null;
    }
    return entry.key;
  }

  /** Cache one module key for the default TTL. */
  set(module: number, key: string, now = Date.now()): void {
    this.entries.set(module, { key, expiresAt: now + MODULE_KEY_TTL_MS });
  }

  /** Drop every cached key (used on disconnect and in tests). */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Resolve the AES key for one module. Module 11 (video course) still prefers the
 * runtime key; the constant is a verified fallback for when the key service is
 * unreachable. Module 9 (meet course) is never hardcoded.
 */
export async function fetchModuleKey(
  module: number,
  transport: ZhsTransport,
  cache: ModuleKeyCache = new ModuleKeyCache(),
  now = Date.now(),
): Promise<string> {
  const cached = cache.get(module, now);
  if (cached) return cached;
  const uid = await rsaEncryptPkcs1v15(PUBLIC_KEY_B64, JSON.stringify({ module }));
  const response = await transport.request({
    url: `${APP_USER_ORIGIN}${MODULE_KEY_PATH}?uid=${encodeURIComponent(uid)}`,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`知到密钥服务返回 HTTP ${response.status}`);
  }
  let payload: { rt?: { sl?: string } };
  try {
    payload = JSON.parse(response.text) as { rt?: { sl?: string } };
  } catch {
    throw new Error('知到密钥服务返回了非 JSON 响应');
  }
  const blob = payload.rt?.sl;
  if (!blob) throw new Error('知到密钥服务未返回 rt.sl');
  const plain = await rsaPublicUnpad(PUBLIC_KEY_B64, blob);
  let parsed: { cKey?: string };
  try {
    parsed = JSON.parse(plain) as { cKey?: string };
  } catch {
    throw new Error('知到模块密钥解包后不是 JSON');
  }
  if (!parsed.cKey) throw new Error('知到模块密钥缺少 cKey');
  cache.set(module, parsed.cKey, now);
  return parsed.cKey;
}

/** Resolve a module key with the verified constant fallback for the video module. */
export async function moduleKey(
  module: number,
  transport: ZhsTransport,
  cache: ModuleKeyCache = new ModuleKeyCache(),
  warn: (message: string) => void = () => undefined,
): Promise<string> {
  try {
    return await fetchModuleKey(module, transport, cache);
  } catch (error) {
    if (module === MODULE_VIDEO) {
      warn('知到模块密钥获取失败，使用视频课常量密钥（平台常量可能已更新）');
      return VIDEO_MODULE_KEY_FALLBACK;
    }
    throw error;
  }
}
