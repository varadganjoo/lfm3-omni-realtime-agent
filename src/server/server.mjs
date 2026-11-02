import http from 'node:http';
import https from 'node:https';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Store, runTurn } from './agent.mjs';
import { lanPolicy, browserOrigin } from './network.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const store = new Store(join(root, 'data'));
const upstream = 'http://127.0.0.1:8081';
const origin = 'http://127.0.0.1:8787';
const lanPath = join(root, 'runtime', 'lan.json');
const lan = existsSync(lanPath) ? lanPolicy(JSON.parse(readFileSync(lanPath, 'utf8'))) : null;
const apiKey = readFileSync(join(root, 'runtime', 'api-key'), 'utf8').trim();
const sessions = new Map();
let busy = false;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6_000_000) throw new Error('Request is too large. Record at most 20 seconds.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function model(path, data, signal) {
  const response = await fetch(upstream + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey }, body: JSON.stringify(data), signal
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model request failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return response;
}

function sessionFor(req, res) {
  const cookie = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  let session = sessions.get(cookie);
  if (!session) {
    const id = randomBytes(32).toString('hex');
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
    session = { id, messages: [], controller: null, done: null };
    sessions.set(id, session);
    res.setHeader('Set-Cookie', `session=${id}; HttpOnly; SameSite=Strict; Path=/${req.socket.encrypted ? '; Secure' : ''}`);
  }
  return session;
}

async function handleRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  const pageOrigin = browserOrigin(req, lan);
  if (!pageOrigin) return json(res, 403, { error: 'Open the app using its configured local address.' });
  const pathname = new URL(req.url, pageOrigin).pathname;
  if (req.method === 'POST' && (req.headers.origin !== pageOrigin || !req.headers['content-type']?.startsWith('application/json'))) {
    return json(res, 403, { error: 'This request must come from the local assistant page.' });
  }
  const session = sessionFor(req, res);
  try {
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/live.js': ['live.js', 'text/javascript'], '/capture.js': ['capture.js', 'text/javascript'] };
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      return res.end(readFileSync(join(root, 'src', 'web', file)));
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      const health = await fetch(upstream + '/health', { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false);
      const notes = readdirSync(join(root, 'data', 'notes')).filter(f => /^[a-f0-9-]+\.md$/.test(f)).map(filename => {
        const content = readFileSync(join(root, 'data', 'notes', filename), 'utf8');
        return { filename, title: content.split('\n')[0].replace(/^# /, ''), content };
      });
      const liveReady = await fetch('http://127.0.0.1:8788/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);
      return json(res, 200, { ready: health, liveReady, memories: store.memories, notes });
    }
    if (req.method === 'POST' && pathname === '/api/cancel') {
      await body(req);
      session.controller?.abort(new Error('This reply was interrupted. Any completed notes remain saved.'));
      if (session.done) await session.done;
      return json(res, 200, { cancelled: true });
    }
    if (req.method === 'POST' && pathname === '/api/forget') {
      const { key } = await body(req);
      store.forget(key);
      return json(res, 200, { forgotten: true });
    }
    if (req.method === 'POST' && pathname === '/api/reset') {
      if (busy) return json(res, 409, { error: 'Wait for the current reply before starting a new chat.' });
      session.messages = [];
      return json(res, 200, { reset: true });
    }
    if (req.method === 'POST' && pathname === '/api/turn') {
      if (busy) return json(res, 409, { error: 'The model is answering another request. Try again when it finishes.' });
      const input = await body(req);
      if (busy) return json(res, 409, { error: 'The model is answering another request. Try again when it finishes.' });
      if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 4000)) throw new Error('Text must be at most 4,000 characters.');
      const content = [];
      if (input.video) {
        if (req.headers['x-local-engine-key'] !== apiKey) return json(res, 403, { error: 'Video clips must come from the local Pipecat capture service.' });
        // ASVS 2.2.1/5.2.1: accept bounded inline WebM, never model-selected paths or URLs.
        if (typeof input.video !== 'string' || input.video.length > 4_000_000 || !/^[A-Za-z0-9+/]+=*$/.test(input.video)) throw new Error('The video must be a short WebM clip.');
        const video = Buffer.from(input.video, 'base64');
        if (video.length < 32 || video.readUInt32BE(0) !== 0x1a45dfa3) throw new Error('The video is not a WebM clip.');
        content.push({ type: 'input_video', input_video: { data: input.video } });
      }
      if (input.image) {
        if (typeof input.image !== 'string' || input.image.length > 800000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(input.image)) throw new Error('The camera snapshot must be a JPEG image.');
        content.push({ type: 'image_url', image_url: { url: input.image } });
      }
      if (input.audio) {
        if (typeof input.audio !== 'string' || input.audio.length > 900000 || !/^[A-Za-z0-9+/]+=*$/.test(input.audio)) throw new Error('The recording must be a short WAV file.');
        const wav = Buffer.from(input.audio, 'base64');
        if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('The recording is not a WAV file.');
        content.push({ type: 'input_audio', input_audio: { data: input.audio, format: 'wav' } });
      }
      if (input.text?.trim()) content.push({ type: 'text', text: input.text.trim() });
      if (!content.some(part => part.type !== 'image_url')) throw new Error('Say or type a request first.');
      busy = true;
      const events = [];
      const controller = new AbortController();
      session.controller = controller;
      let finish;
      session.done = new Promise(resolve => { finish = resolve; });
      const timer = setTimeout(() => controller.abort(new Error('The model took more than three minutes. Check the activity before retrying.')), 180000);
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      // Interrupted requests remain context so a continuation does not lose the user's intent.
      const messages = [...session.messages, { role: 'user', content }];
      session.messages = messages;
      try {
        const answer = await runTurn({ messages, store, events, signal: controller.signal, complete: async (history, tools, signal) => {
          const response = await model('/v1/chat/completions', { model: 'local-omni', messages: history, tools, tool_choice: 'auto', parallel_tool_calls: false, temperature: 0, max_tokens: 400, stream: false }, signal);
          const result = await response.json();
          if (result.choices?.[0]?.finish_reason === 'length') throw new Error('The answer hit its length limit. Try a shorter request.');
          return result.choices?.[0]?.message;
        } });
        let speech = null;
        let speechError = null;
        if (input.speak !== false) {
          try {
            const response = await model('/tts', { input: answer, lang: 'en', voice: 'female', n_predict: 512, response_format: 'wav' }, controller.signal);
            speech = Buffer.from(await response.arrayBuffer()).toString('base64');
          } catch (error) { speechError = 'The text reply is ready, but speech failed: ' + error.message; }
        }
        return json(res, 200, { answer, speech, speechError, events });
      } catch (error) {
        return json(res, 502, { error: error.message, events });
      } finally {
        // shortcut: retain two turns, including interrupted ones; add summaries for longer context.
        const starts = messages.flatMap((message, i) => message.role === 'user' ? [i] : []);
        session.messages = messages.slice(starts[Math.max(0, starts.length - 2)]);
        clearTimeout(timer); busy = false; session.controller = null; session.done = null; finish();
      }
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) { json(res, 400, { error: error.message }); }
}

function upgradeMedia(req, socket, head) {
  const id = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const key = req.headers['sec-websocket-key'];
  // ASVS 3.5.1/4.4.2: validate origin and bind an existing browser session before proxying media.
  const pageOrigin = browserOrigin(req, lan);
  if (req.url !== '/api/live/media' || !pageOrigin || req.headers.origin !== pageOrigin ||
      !sessions.has(id) || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const target = net.connect(8788, '127.0.0.1', () => {
    target.write(`GET /media HTTP/1.1\r\nHost: 127.0.0.1:8788\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\nAuthorization: Bearer ${apiKey}\r\nX-Local-Session: ${id}\r\n\r\n`);
    if (head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
  socket.on('close', () => target.destroy());
  target.on('close', () => socket.destroy());
}
const server = http.createServer(handleRequest);
server.requestTimeout = 200000;
server.on('upgrade', upgradeMedia);
server.listen(8787, '127.0.0.1', () => console.log('Local assistant: ' + origin));

if (lan) {
  const tls = https.createServer({
    key: readFileSync(join(root, 'runtime', 'tls', 'server-key.pem')),
    cert: readFileSync(join(root, 'runtime', 'tls', 'server.pem')),
    minVersion: 'TLSv1.2'
  }, handleRequest);
  tls.requestTimeout = 200000;
  tls.on('upgrade', upgradeMedia);
  tls.listen(8443, lan.address, () => console.log('Home network assistant: ' + lan.origin));
  http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!lan.allows(req, true)) return json(res, 403, { error: 'Home network only.' });
    if (req.method === 'GET' && req.url === '/companion-ca.cer') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="companion-ca.cer"' });
      return res.end(readFileSync(join(root, 'runtime', 'tls', 'companion-ca.cer')));
    }
    if (req.method !== 'GET' || req.url !== '/') return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(root, 'src', 'web', 'network.html'), 'utf8').replaceAll('{{ORIGIN}}', lan.origin).replaceAll('{{FINGERPRINT}}', lan.certificateSha256.match(/.{2}/g).join(':')));
  }).listen(8789, lan.address, () => console.log('Device setup: ' + lan.setupOrigin));
}
