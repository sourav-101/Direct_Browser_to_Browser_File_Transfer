import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Peer from 'simple-peer';
import {
  Link2, Share2, Copy, Check, Wifi, Lock,
  UploadCloud, Download, CheckCircle2, XCircle, File as FileIcon,
} from 'lucide-react';
import {
  sendFile,
  hashArrayBuffer,
  formatBytes,
  formatSpeed,
  generateKey,
  exportKeyToBase64,
  importKeyFromBase64,
  unpackChunk,
} from './lib/fileTransfer';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function App() {
  const [roomId, setRoomId] = useState(null);
  const [status, setStatus] = useState('Connecting to server...');
  const [connected, setConnected] = useState(false);
  const [encryptionReady, setEncryptionReady] = useState(false);
  const [copied, setCopied] = useState(false);

  const [selectedFile, setSelectedFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState(null);

  const [receiveMeta, setReceiveMeta] = useState(null);
  const [receiveProgress, setReceiveProgress] = useState(null);
  const [receiveStatus, setReceiveStatus] = useState(null);

  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const roomIdRef = useRef(null);
  const keyRef = useRef(null);
  const pendingSignalsRef = useRef([]);
  const fileInputRef = useRef(null);
  const incomingRef = useRef({ meta: null, chunks: [], received: 0, startTime: 0 });

  const resetTransferState = () => {
    setSelectedFile(null);
    setSending(false);
    setSendProgress(null);
    setReceiveMeta(null);
    setReceiveProgress(null);
    setReceiveStatus(null);
    incomingRef.current = { meta: null, chunks: [], received: 0, startTime: 0 };
  };

  const handleIncomingData = async (data) => {
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
      // Not JSON/UTF-8 -> this is an encrypted binary chunk
    }

    const incoming = incomingRef.current;
    if (!incoming.meta || !keyRef.current) return;

    try {
      const { index, plaintext } = await unpackChunk(keyRef.current, data);
      incoming.chunks[index] = plaintext;
      incoming.received += plaintext.byteLength;

      const elapsedSec = (Date.now() - incoming.startTime) / 1000;
      const speed = elapsedSec > 0 ? incoming.received / elapsedSec : 0;
      setReceiveProgress({ received: incoming.received, total: incoming.meta.size, speed });
    } catch (err) {
      console.error('Failed to decrypt chunk:', err);
      setReceiveStatus('mismatch');
    }
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

    socket.on('room-created', async ({ roomId }) => {
      roomIdRef.current = roomId;

      const key = await generateKey();
      keyRef.current = key;
      const base64Key = await exportKeyToBase64(key);
      window.history.replaceState(null, '', `?room=${roomId}#key=${base64Key}`);
      setEncryptionReady(true);

      setRoomId(roomId);
      setStatus('Room created. Share the link below. Waiting for peer...');
    });

    socket.on('joined-room', async ({ roomId }) => {
      roomIdRef.current = roomId;

      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const base64Key = hashParams.get('key');

      if (!base64Key) {
        setStatus('Error: this link is missing its encryption key.');
        return;
      }

      keyRef.current = await importKeyFromBase64(base64Key);
      setEncryptionReady(true);

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

    await sendFile(peerRef.current, selectedFile, keyRef.current, ({ sent, total, elapsedMs }) => {
      const speed = elapsedMs > 0 ? sent / (elapsedMs / 1000) : 0;
      setSendProgress({ sent, total, speed });
    });

    setSending(false);
    setStatus('File sent successfully!');
  };

  const shareLink = roomId
    ? `${window.location.origin}${window.location.pathname}?room=${roomId}${window.location.hash}`
    : '';

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sendPct = sendProgress ? Math.min(100, Math.round((sendProgress.sent / sendProgress.total) * 100)) : 0;
  const receivePct = receiveMeta
    ? Math.min(100, Math.round(((receiveProgress?.received || 0) / receiveMeta.size) * 100))
    : 0;

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 relative overflow-hidden flex items-center justify-center p-4">
      {/* decorative glow */}
      <div className="absolute -top-32 -left-32 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-violet-600/20 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 w-full max-w-md flex flex-col items-center gap-5">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
            <Link2 className="w-5 h-5 text-white" />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">PeerLink</h1>
        </div>
        <p className="text-sm text-slate-400 text-center -mt-3">
          Direct, end-to-end encrypted file transfer between browsers
        </p>

        {/* status pill */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/80 border border-slate-800 text-xs text-slate-300">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
          {status}
        </div>

        {!roomId && (
          <button
            onClick={createRoom}
            className="flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 transition-all shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 active:scale-[0.98]"
          >
            <Share2 className="w-4 h-4" /> Create room
          </button>
        )}

        {roomId && !connected && (
          <div className="w-full bg-slate-900/60 border border-slate-800 rounded-2xl p-4 backdrop-blur-sm">
            <p className="text-xs text-slate-400 mb-2 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Share this link with your peer
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-slate-300 bg-slate-950/60 rounded-lg px-3 py-2 truncate font-mono">
                {shareLink}
              </code>
              <button
                onClick={handleCopyLink}
                className="shrink-0 p-2 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
                aria-label="Copy link"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-slate-300" />}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-3 animate-pulse">Waiting for peer to join...</p>
          </div>
        )}

        {connected && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
              <Wifi className="w-3.5 h-3.5" /> Connected to peer
            </div>
            {encryptionReady && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-medium">
                <Lock className="w-3.5 h-3.5" /> End-to-end encrypted
              </div>
            )}
          </div>
        )}

        {connected && !selectedFile && !receiveMeta && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current.click()}
            className="w-full border-2 border-dashed border-slate-700 rounded-2xl p-10 text-center cursor-pointer bg-slate-900/40 hover:border-indigo-500/50 hover:bg-slate-900/60 transition-colors group"
          >
            <UploadCloud className="w-8 h-8 mx-auto mb-3 text-slate-500 group-hover:text-indigo-400 transition-colors" />
            <p className="text-sm text-slate-300">Drag & drop a file, or click to browse</p>
            <p className="text-xs text-slate-500 mt-1">Maximum file size: 50MB</p>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              onChange={(e) => handleFile(e.target.files[0])}
            />
          </div>
        )}

        {connected && selectedFile && !sendProgress && (
          <div className="w-full bg-slate-900/60 border border-slate-800 rounded-2xl p-4 backdrop-blur-sm flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400">
              <FileIcon className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{selectedFile.name}</p>
              <p className="text-xs text-slate-500">{formatBytes(selectedFile.size)}</p>
            </div>
            <button
              onClick={handleSendFile}
              className="shrink-0 px-4 py-2 rounded-xl font-medium text-sm text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 transition-all"
            >
              Send
            </button>
          </div>
        )}

        {connected && sendProgress && (
          <div className="w-full bg-slate-900/60 border border-slate-800 rounded-2xl p-4 backdrop-blur-sm space-y-2">
            <div className="flex items-center justify-between text-sm gap-2">
              <span className="flex items-center gap-2 text-slate-300 truncate">
                <UploadCloud className="w-4 h-4 text-indigo-400 shrink-0" /> {selectedFile.name}
              </span>
              <span className="text-slate-500 text-xs shrink-0">{sendPct}%</span>
            </div>
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-all duration-150"
                style={{ width: `${sendPct}%` }}
              />
            </div>
            <p className="text-xs text-slate-500">
              {formatBytes(sendProgress.sent)} / {formatBytes(sendProgress.total)} · {formatSpeed(sendProgress.speed)}
            </p>
          </div>
        )}

        {connected && receiveMeta && (
          <div className="w-full bg-slate-900/60 border border-slate-800 rounded-2xl p-4 backdrop-blur-sm space-y-2">
            <div className="flex items-center justify-between text-sm gap-2">
              <span className="flex items-center gap-2 text-slate-300 truncate">
                <Download className="w-4 h-4 text-emerald-400 shrink-0" /> {receiveMeta.name}
              </span>
              <span className="text-slate-500 text-xs shrink-0">{receivePct}%</span>
            </div>
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-150"
                style={{ width: `${receivePct}%` }}
              />
            </div>
            <p className="text-xs text-slate-500">
              {formatBytes(receiveProgress?.received || 0)} / {formatBytes(receiveMeta.size)} · {formatSpeed(receiveProgress?.speed || 0)}
            </p>
            {receiveStatus === 'verified' && (
              <p className="flex items-center gap-1.5 text-emerald-400 text-sm font-medium pt-1">
                <CheckCircle2 className="w-4 h-4" /> Verified — download started
              </p>
            )}
            {receiveStatus === 'mismatch' && (
              <p className="flex items-center gap-1.5 text-red-400 text-sm font-medium pt-1">
                <XCircle className="w-4 h-4" /> Verification failed — file may be corrupted
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-slate-600 text-center max-w-sm">
          Files transfer directly between browsers and are never stored on a server.
        </p>
      </div>
    </div>
  );
}

export default App;