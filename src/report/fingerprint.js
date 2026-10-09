// Short identifier of the input data of a document

// 64-bit FNV-1a as a fallback when SubtleCrypto is unavailable (insecure context)
function fnv1a(text) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Hex digest of the text and its algorithm name: SHA-256 (64 characters) or FNV-1a (16 characters)
export async function digestHex(text) {
  if (globalThis.crypto && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return { hex: [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join(''), name: 'SHA-256' };
  }
  return { hex: fnv1a(text), name: 'FNV-1a 64' };
}
