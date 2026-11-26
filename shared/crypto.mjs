const enc = new TextEncoder();
export const utf8 = value => enc.encode(value);
export function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function importKey(secret) {
  const raw = unbase64(secret);
  if (raw.length !== 32) throw new Error('A 32-byte vault key is required.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(bytes, secret, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(context) }, await importKey(secret), bytes);
  return JSON.stringify({ version: 1, iv: base64(iv), data: base64(new Uint8Array(ciphertext)) });
}
export async function decrypt(envelope, secret, context) {
  const obj = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (obj.version !== 1) throw new Error('Unsupported encrypted file.');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(obj.iv), additionalData: utf8(context) }, await importKey(secret), unbase64(obj.data)));
}
export async function hashCode(productId, code) {
  const bytes = await crypto.subtle.digest('SHA-256', utf8(`${productId}\0${code.trim()}`));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const decode = bytes => new TextDecoder().decode(bytes);
