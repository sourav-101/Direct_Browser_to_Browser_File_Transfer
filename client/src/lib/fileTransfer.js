export const CHUNK_SIZE = 16 * 1024; // 16KB of plaintext per chunk
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;
const IV_LENGTH = 12; // AES-GCM standard IV size in bytes

// ---------- Hashing ----------

export function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashArrayBuffer(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return bufferToHex(digest);
}

// ---------- Key management (Zero-Knowledge Encryption) ----------

export async function generateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportKeyToBase64(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return base64UrlEncode(raw);
}

export async function importKeyFromBase64(base64) {
  const raw = base64UrlDecode(base64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

function base64UrlEncode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------- Encrypted chunk framing ----------
// Wire format per chunk: [4 bytes index][12 bytes IV][ciphertext + 16-byte auth tag]
// The index is included now so the next step (auto-resume) can use it too.


export async function packChunk(index, key, plaintextChunk) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  console.log(
    "🔒 Plaintext:",
    Array.from(new Uint8Array(plaintextChunk).slice(0, 10))
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextChunk)
  );

  console.log(
    "🔐 Ciphertext:",
    Array.from(ciphertext.slice(0, 10))
  );

  const frame = new Uint8Array(4 + IV_LENGTH + ciphertext.length);
  frame[0] = (index >>> 24) & 0xff;
  frame[1] = (index >>> 16) & 0xff;
  frame[2] = (index >>> 8) & 0xff;
  frame[3] = index & 0xff;
  frame.set(iv, 4);
  frame.set(ciphertext, 4 + IV_LENGTH);
  return frame;
}

export async function unpackChunk(key, frame) {
  const index = ((frame[0] << 24) | (frame[1] << 16) | (frame[2] << 8) | frame[3]) >>> 0;
  const iv = frame.slice(4, 4 + IV_LENGTH);
  const ciphertext = frame.slice(4 + IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  console.log(
    "🔓 Decrypted:",
    Array.from(new Uint8Array(plaintext).slice(0, 10))
  );
  return { index, plaintext };
}

// ---------- Sending ----------

function waitForDrain(channel) {
  return new Promise((resolve) => {
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      resolve();
      return;
    }
    channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT / 2;
    const onLow = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', onLow);
  });
}

export async function sendFile(peer, file, key, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const hash = await hashArrayBuffer(arrayBuffer);
  const totalSize = arrayBuffer.byteLength;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  peer.send(JSON.stringify({
    type: 'file-meta',
    name: file.name,
    size: totalSize,
    mimeType: file.type || 'application/octet-stream',
    hash,
    totalChunks,
  }));

  const channel = peer._channel;
  let sent = 0;
  const startTime = Date.now();

  for (let i = 0; i < totalChunks; i++) {
    await waitForDrain(channel);
    const offset = i * CHUNK_SIZE;
    const chunk = arrayBuffer.slice(offset, Math.min(offset + CHUNK_SIZE, totalSize));
    const frame = await packChunk(i, key, chunk);
    peer.send(frame);
    sent += chunk.byteLength;
    onProgress({ sent, total: totalSize, elapsedMs: Date.now() - startTime });
  }

  peer.send(JSON.stringify({ type: 'file-end' }));
}

// ---------- Formatting ----------

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSpeed(bytesPerSecond) {
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}