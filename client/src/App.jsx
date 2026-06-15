import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Peer from 'simple-peer';
import { sendFile, hashArrayBuffer, formatBytes, formatSpeed } from './lib/fileTransfer';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function App() {
  const [roomId, setRoomId] = useState(null);
  const [status, setStatus] = useState('Connecting to server...');
  const [connected, setConnected] = useState(false);

  const [selectedFile, setSelectedFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState(null);

  const [receiveMeta, setReceiveMeta] = useState(null);
  const [receiveProgress, setReceiveProgress] = useState(null);
  const [receiveStatus, setReceiveStatus] = useState(null); // 'receiving' | 'verified' | 'mismatch'

  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const roomIdRef = useRef(null);
  const pendingSignalsRef = useRef([]);
  const fileInputRef = useRef(null);
  const incomingRef = useRef({ meta: null, chunks: [], received: 0, startTime: 0 });

  const handleIncomingData = async (data) => {
    // simple-peer always delivers Buffers, even for JSON strings we sent.
    // Try to decode + parse as a control message first; if that fails
    // (invalid UTF-8 / not JSON), treat it as a raw binary chunk.
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      const msg = JSON.parse(text);

      if (msg.type === 'file-meta') {
        incomingRef.current = { meta: msg, chunks: [], received: 0, startTime: Date.now() };
        setReceiveMeta(msg);
        setReceiveProgress({ received: 0, total: msg.size, speed: 0 });
        setReceiveStatus('receiving');
        return;
      }

      if (msg.type === 'file-end') {
        const incoming = incomingRef.current;
        const blob = new Blob(incoming.chunks, { type: incoming.meta.mimeType });
        const buffer = await blob.arrayBuffer();
        const hash = await hashArrayBuffer(buffer);

        if (hash === incoming.meta.hash) {
          setReceiveStatus('verified');
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = incoming.meta.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          setReceiveStatus('mismatch');
        }
        return;
      }
    } catch (e) {
      // Not valid JSON/UTF-8 -> this is a binary file chunk, fall through
    }

    // Binary chunk
    const incoming = incomingRef.current;
    const resetTransferState = () => {
      setSelectedFile(null);
      setSending(false);
      setSendProgress(null);
      setReceiveMeta(null);
      setReceiveProgress(null);
      setReceiveStatus(null);
      incomingRef.current = { meta: null, chunks: [], received: 0, startTime: 0 };
    };
    if (!incoming.meta) return; // safety guard: ignore stray chunks before meta arrives

    incoming.chunks.push(data);
    incoming.received += data.length;
    const elapsedSec = (Date.now() - incoming.startTime) / 1000;
    const speed = elapsedSec > 0 ? incoming.received / elapsedSec : 0;
    setReceiveProgress({ received: incoming.received, total: incoming.meta.size, speed });
  };

  const createPeer = (initiator) => {
    const peer = new Peer({
      initiator,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    });

    peer.on('signal', (data) => {
      socketRef.current.emit('signal', { roomId: roomIdRef.current, data });
    });

    peer.on('connect', () => {
      setStatus('Peer-to-peer connection established!');
      setConnected(true);
    });

    peer.on('data', handleIncomingData);


    peer.on('close', () => {
      setStatus('Connection closed. Refresh and create a new room to start over.');
      setConnected(false);
      resetTransferState();
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      setStatus('Connection error - the peer may have disconnected. Refresh to start over.');
      setConnected(false);
      resetTransferState();
    });

    peerRef.current = peer;
    pendingSignalsRef.current.forEach((data) => peer.signal(data));
    pendingSignalsRef.current = [];
  };

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on('connect', () => setStatus('Connected to signaling server'));

    socket.on('room-created', ({ roomId }) => {
      roomIdRef.current = roomId;
      setRoomId(roomId);
      setStatus('Room created. Share the link below. Waiting for peer...');
      window.history.replaceState(null, '', `?room=${roomId}`);
    });

    socket.on('joined-room', ({ roomId }) => {
      roomIdRef.current = roomId;
      setRoomId(roomId);
      setStatus('Joined room. Connecting to peer...');
      createPeer(false);
    });

    socket.on('peer-joined', () => {
      setStatus('Peer joined! Establishing connection...');
      createPeer(true);
    });

    socket.on('peer-left', () => {
      setStatus('Peer disconnected. Refresh and create a new room to start over.');
      setConnected(false);
      resetTransferState();
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
    });

    socket.on('signal', ({ data }) => {
      if (peerRef.current) {
        peerRef.current.signal(data);
      } else {
        pendingSignalsRef.current.push(data);
      }
    });

    socket.on('room-error', ({ message }) => setStatus(`Error: ${message}`));

    const existingRoom = new URLSearchParams(window.location.search).get('room');
    if (existingRoom) socket.emit('join-room', { roomId: existingRoom });

    return () => {
      socket.disconnect();
      if (peerRef.current) peerRef.current.destroy();
    };
  }, []);

  const createRoom = () => socketRef.current.emit('create-room');

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setStatus(`File too large (max 50MB). Selected file is ${formatBytes(file.size)}.`);
      return;
    }
    setSelectedFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files[0]);
  };

  const handleSendFile = async () => {
    setSending(true);
    setSendProgress({ sent: 0, total: selectedFile.size, speed: 0 });

    await sendFile(peerRef.current, selectedFile, ({ sent, total, elapsedMs }) => {
      const speed = elapsedMs > 0 ? sent / (elapsedMs / 1000) : 0;
      setSendProgress({ sent, total, speed });
    });

    setSending(false);
    setStatus('File sent successfully!');
  };

  const shareLink = roomId
    ? `${window.location.origin}${window.location.pathname}?room=${roomId}`
    : '';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-100 p-4">
      <h1 className="text-2xl font-bold">P2P Web Share</h1>
      <p className="text-gray-600 text-center">{status}</p>

      {!roomId && (
        <button onClick={createRoom} className="px-4 py-2 bg-blue-600 text-white rounded-lg">
          Create Room
        </button>
      )}

      {roomId && !connected && (
        <div className="bg-white p-4 rounded-lg shadow text-sm break-all max-w-md">
          <p className="font-medium mb-1">Share this link:</p>
          <code>{shareLink}</code>
        </div>
      )}

      {connected && (
        <div className="bg-green-100 text-green-800 px-4 py-2 rounded-lg font-medium">
          Connected directly to peer
        </div>
      )}

      {connected && !selectedFile && !receiveMeta && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current.click()}
          className="w-full max-w-md border-2 border-dashed border-gray-400 rounded-lg p-8 text-center text-gray-500 cursor-pointer bg-white hover:border-blue-400"
        >
          Drag & drop a file here, or click to browse
          <div className="text-xs mt-1">Max 50MB</div>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={(e) => handleFile(e.target.files[0])}
          />
        </div>
      )}

      {connected && selectedFile && !sendProgress && (
        <div className="bg-white p-4 rounded-lg shadow w-full max-w-md">
          <p className="text-sm mb-2">
            Selected: <span className="font-medium">{selectedFile.name}</span> ({formatBytes(selectedFile.size)})
          </p>
          <button onClick={handleSendFile} className="px-4 py-2 bg-blue-600 text-white rounded-lg w-full">
            Send File
          </button>
        </div>
      )}

      {connected && sendProgress && (
        <div className="bg-white p-4 rounded-lg shadow w-full max-w-md">
          <p className="text-sm mb-1">Sending: {selectedFile.name}</p>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all"
              style={{ width: `${(sendProgress.sent / sendProgress.total) * 100}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {formatBytes(sendProgress.sent)} / {formatBytes(sendProgress.total)} — {formatSpeed(sendProgress.speed)}
          </p>
        </div>
      )}

      {connected && receiveMeta && (
        <div className="bg-white p-4 rounded-lg shadow w-full max-w-md">
          <p className="text-sm mb-1">Receiving: {receiveMeta.name}</p>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className="bg-green-600 h-3 rounded-full transition-all"
              style={{ width: `${((receiveProgress?.received || 0) / receiveMeta.size) * 100}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {formatBytes(receiveProgress?.received || 0)} / {formatBytes(receiveMeta.size)} — {formatSpeed(receiveProgress?.speed || 0)}
          </p>
          {receiveStatus === 'verified' && (
            <p className="text-green-700 text-sm mt-2 font-medium">✓ Verified — download started</p>
          )}
          {receiveStatus === 'mismatch' && (
            <p className="text-red-700 text-sm mt-2 font-medium">✗ Hash mismatch — file may be corrupted</p>
          )}
        </div>
      )}
    </div>
  );
}

export default App;