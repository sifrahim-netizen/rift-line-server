// Minimal, dependency-free WebSocket server implementation (RFC 6455).
// Supports text frames, fragmentation, ping/pong, close handshake, payload limits
// and back-pressure detection. Binary frames and extensions are not used by the game.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WSConn extends EventEmitter {
  constructor(socket, { maxPayload = 16 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.frags = null;
    this.fragOp = 0;
    this.open = true;
    this.closing = false;
    this.lastPong = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish(1006, ''));
    socket.on('error', () => this._finish(1006, ''));
    socket.on('end', () => this._finish(1006, ''));
  }

  get buffered() { return this.socket.writableLength; }

  _finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch {}
    this.emit('close', code, reason);
  }

  _onData(d) {
    if (!this.open) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > this.maxPayload * 4 + 64) return this.close(1009, 'too big');
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv) return this.close(1002, 'rsv');
      if (!masked) return this.close(1002, 'unmasked');
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        if (hi !== 0) return this.close(1009, 'too big');
        len = lo; off = 10;
      }
      if (len > this.maxPayload) return this.close(1009, 'too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    if (op >= 8) {
      if (!fin || payload.length > 125) return this.close(1002, 'bad control');
      if (op === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closing) { this.closing = true; this._write(8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)); }
        try { this.socket.end(); } catch {}
        return this._finish(code, payload.length > 2 ? payload.subarray(2).toString('utf8') : '');
      }
      if (op === 9) return this._write(10, payload);
      if (op === 10) { this.lastPong = Date.now(); return; }
      return this.close(1002, 'bad op');
    }
    if (op === 0) {
      if (!this.frags) return this.close(1002, 'unexpected continuation');
      this.frags.push(payload);
      if (this.frags.reduce((a, p) => a + p.length, 0) > this.maxPayload) return this.close(1009, 'too big');
      if (!fin) return;
      const all = Buffer.concat(this.frags); const fop = this.fragOp; this.frags = null;
      return this._deliver(fop, all);
    }
    if (this.frags) return this.close(1002, 'expected continuation');
    if (op !== 1 && op !== 2) return this.close(1002, 'bad op');
    if (!fin) { this.frags = [payload]; this.fragOp = op; return; }
    this._deliver(op, payload);
  }

  _deliver(op, payload) {
    if (op === 2) return this.close(1003, 'text only');
    this.emit('message', payload.toString('utf8'));
  }

  _write(op, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { return false; }
    return true;
  }

  send(text) { if (this.closing) return false; return this._write(1, Buffer.from(text, 'utf8')); }
  ping() { return this._write(9, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    if (!this.closing) {
      this.closing = true;
      const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
      const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
      this._write(8, p);
    }
    setTimeout(() => this._finish(code, reason), 1500).unref?.();
    try { this.socket.end(); } catch {}
  }

  terminate() { this._finish(1006, 'terminated'); }
}

// Performs the HTTP upgrade handshake. Returns a WSConn or null when the request is invalid.
export function acceptUpgrade(req, socket, head, opts) {
  const key = req.headers['sec-websocket-key'];
  const ver = req.headers['sec-websocket-version'];
  const upg = String(req.headers.upgrade || '').toLowerCase();
  if (req.method !== 'GET' || upg !== 'websocket' || !key || ver !== '13' || !/^[A-Za-z0-9+/=]{24}$/.test(key)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new WSConn(socket, opts);
  if (head && head.length) ws._onData(head);
  return ws;
}

export function rejectUpgrade(socket, status, text) {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
}
