export const CHUNK_SIZE = 16 * 1024; // 16KB per chunk
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // pause sending above 1MB buffered

export function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashArrayBuffer(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return bufferToHex(digest);
}

// Pauses sending if the data channel's internal buffer is too full,
// resuming once it drains. Prevents the connection from choking on large files.
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

export async function sendFile(peer, file, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const hash = await hashArrayBuffer(arrayBuffer);
  const totalSize = arrayBuffer.byteLength;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

  // 1. Send metadata first, so the receiver knows what's coming
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

  // 2. Send the file in chunks
  for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
    await waitForDrain(channel);
    const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
    peer.send(chunk);
    sent += chunk.byteLength;
    onProgress({ sent, total: totalSize, elapsedMs: Date.now() - startTime });
  }

  // 3. Signal completion
  peer.send(JSON.stringify({ type: 'file-end' }));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSpeed(bytesPerSecond) {
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}