// Short identifier of the input data of a document

// 64-bit FNV-1a as a fallback when SubtleCrypto is unavailable (insecure context)
function fnv1a(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Hex digest of a string or bytes and its algorithm name: SHA-256 (64 characters) or FNV-1a (16 characters)
export async function digestHex(content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  if (globalThis.crypto && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', bytes);
    return { hex: [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join(''), name: 'SHA-256' };
  }
  return { hex: fnv1a(bytes), name: 'FNV-1a 64' };
}
