import { LiveCall } from './live.js';

const $ = id => document.getElementById(id);
const welcome = $('conversation').querySelector('.welcome').cloneNode(true);
let ready = false, liveReady = false, live = false, connecting = false, busy = false, muted = false, cameraEnabled = true;
let request, minimumGeneration = 0, stopping = false;
const audioUrls = [];
const phaseLabels = { offline: 'Ready to connect', connecting: 'Connecting', ready: 'Listening', listening: 'You are speaking', thinking: 'Working on your request', speaking: 'Speaking', reconnecting: 'Reconnecting' };

function phase(state, detail) {
  document.body.dataset.state = state;
  $('phase').textContent = phaseLabels[state] || state;
  $('status').textContent = detail || (state === 'ready' ? 'Speak to interrupt, or use the controls.' : state === 'offline' ? 'Start a call or send a message.' : '');
}
function controls() {
  $('start-live').disabled = !ready || !liveReady || live || connecting || busy || stopping;
  $('disconnect').disabled = stopping || (!live && !connecting && !busy && !document.querySelector('audio'));
  $('interrupt').disabled = !live && !busy;
  $('mute').disabled = !live;
  $('toggle-camera').disabled = !live || !call.stream?.getVideoTracks().length;
  $('use-camera').disabled = live || connecting;
  $('new-chat').disabled = live || connecting || busy || stopping;
  $('send').disabled = !ready || connecting || busy || stopping;
  $('mute').textContent = muted ? 'Unmute mic' : 'Mute mic';
  $('mute').setAttribute('aria-pressed', String(muted));
  $('toggle-camera').textContent = cameraEnabled ? 'Hide camera' : 'Show camera';
  $('toggle-camera').setAttribute('aria-pressed', String(cameraEnabled));
}
function message(who, text, kind = '') {
  $('conversation').querySelector('.welcome')?.remove();
  const item = document.createElement('div'); item.className = 'message ' + kind;
  const label = document.createElement('span'); label.className = 'who'; label.textContent = who;
  const p = document.createElement('p'); p.textContent = text;
  item.append(label, p); $('conversation').append(item);
  $('conversation').scrollTop = $('conversation').scrollHeight;
  return item;
}
async function api(path, data, signal) {
  const response = await fetch('/api/' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal
  });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'The request failed.'); error.events = result.events; throw error; }
  return result;
}
function showTool(event) {
  message('Activity', event.error ? event.tool + ': ' + event.error : event.saved ? 'Saved note: ' + event.title : 'Remembered: ' + event.value, event.error ? 'error' : 'action');
  refresh();
}
function liveEvent(event) {
  if (event.type === 'state') {
    if (connecting && event.state === 'ready') { connecting = false; live = true; controls(); }
    if (!muted) phase(event.state);
  } else if (event.type === 'level') $('input-level').value = event.value;
  else if (event.type === 'vision') $('video-window').textContent = cameraEnabled ? `${event.frames} recent frames at ${event.fps} fps` : 'Camera hidden';
  else if (event.type === 'interrupted') {
    minimumGeneration = event.generation ?? minimumGeneration;
    call.clearPlayback();
    message('Session', 'Reply interrupted. Any note already saved stays in your notes.', 'action');
    phase('ready');
  } else if (event.type === 'user') message('You', event.text + (event.videoFrames ? ` with ${event.videoFrames} video frames` : ''));
  else if (event.type === 'answer' && event.generation >= minimumGeneration) {
    message('Companion', event.text);

  } else if (event.type === 'tool') showTool(event.event);
  else if (event.type === 'latency') $('latency').textContent = (event.ms / 1000).toFixed(1) + ' s to first audio';
  else if (event.type === 'error') { message('Status', event.message, 'error'); phase('ready', event.message); refresh(); }

}
const call = new LiveCall({ api, onEvent: liveEvent, onStream: stream => {
  $('camera').srcObject = stream;
  $('camera').classList.toggle('active', !!stream?.getVideoTracks().length);
  $('camera-empty').hidden = !!stream?.getVideoTracks().length;
  $('camera-state').textContent = stream?.getVideoTracks().length ? 'Camera on' : 'Camera off';
}, onClose: () => {
  live = connecting = false; muted = false; minimumGeneration = 0;
  $('input-level').value = 0; $('video-window').textContent = 'No video shared';
  phase('offline'); controls(); refresh();
} });

async function refresh() {
  try {
    const state = await api('state'); ready = state.ready; liveReady = state.liveReady;
    $('health').textContent = ready && liveReady ? 'Local services ready' : ready ? 'Starting voice service...' : 'Model unavailable';
    $('health').classList.toggle('ready', ready && liveReady);
    $('memory-count').textContent = state.memories.length + ' facts';
    $('memories').replaceChildren();
    for (const memory of [...state.memories].reverse()) {
      const row = document.createElement('div'); row.className = 'memory';
      const text = document.createElement('div'); const key = document.createElement('strong'); key.textContent = memory.key.replaceAll('_', ' ');
      const value = document.createElement('p'); value.textContent = memory.value; text.append(key, value);
      const forget = document.createElement('button'); forget.className = 'quiet'; forget.textContent = 'Forget'; forget.setAttribute('aria-label', 'Forget ' + memory.key.replaceAll('_', ' '));
      forget.onclick = async () => { try { await api('forget', { key: memory.key }); await refresh(); } catch (error) { $('status').textContent = error.message; } };
      row.append(text, forget); $('memories').append(row);
    }
    $('notes').replaceChildren();
    for (const note of state.notes) {
      const detail = document.createElement('details'); const title = document.createElement('summary'); title.textContent = note.title;
      const content = document.createElement('pre'); content.textContent = note.content;
      detail.append(title, content); $('notes').append(detail);
    }
    for (const [id, text] of [['memories', 'Nothing remembered yet.'], ['notes', 'No notes saved yet.']]) {
      if (!$(id).children.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = text; $(id).append(p); }
    }
    controls();
  } catch (error) {
    ready = liveReady = false;
    $('health').textContent = 'Local app unavailable';
    $('health').classList.remove('ready');
    $('status').textContent = 'Cannot reach the local app: ' + error.message;
    controls();
  }
}
$('start-live').onclick = async () => {
  connecting = true; muted = false; cameraEnabled = $('use-camera').checked; minimumGeneration = 0;
  phase('connecting', 'Allow microphone and camera access to start the local session.'); controls();
  try { await call.connect(cameraEnabled); }
  catch (error) { phase('offline', 'Could not start live: ' + error.message); controls(); }
};
$('disconnect').onclick = async () => {
  stopping = true; controls(); request?.abort();
  document.querySelectorAll('audio').forEach(audio => audio.pause());
  try {
    await call.disconnect();
    await api('cancel', {});
    phase('offline', 'Agent stopped. Microphone and camera are off.');
  } catch (error) { phase('offline', 'Devices stopped. Could not confirm server cancellation: ' + error.message); }
  finally { stopping = false; controls(); }
};
$('interrupt').onclick = async () => {
  try { if (live) call.interrupt(); else { request?.abort(); await api('cancel', {}); } }
  catch (error) { $('status').textContent = error.message; }
};
$('mute').onclick = () => {
  try { muted = !muted; call.mute(muted); phase('ready', muted ? 'Microphone muted.' : 'Microphone on. Speak when you are ready.'); controls(); }
  catch (error) { $('status').textContent = error.message; }
};
$('toggle-camera').onclick = () => {
  try {
    cameraEnabled = !cameraEnabled; call.camera(cameraEnabled);
    $('camera').classList.toggle('active', cameraEnabled); $('camera-empty').hidden = cameraEnabled;
    $('camera-state').textContent = cameraEnabled ? 'Camera on' : 'Camera hidden'; controls();
  } catch (error) { $('status').textContent = error.message; }
};
$('text-form').onsubmit = async event => {
  event.preventDefault(); const text = $('text').value.trim(); if (!text || busy) return;
  $('text').value = '';
  if (live) {
    try { call.command({ type: 'text', text }); message('You', text); }
    catch (error) { $('status').textContent = error.message; }
    return;
  }
  busy = true; request = new AbortController(); controls(); message('You', text); phase('thinking');
  try {
    const result = await api('turn', { text, speak: true }, request.signal);
    result.events.forEach(showTool); const item = message('Companion', result.answer);
    if (result.speech) {
      const bytes = Uint8Array.from(atob(result.speech), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); audioUrls.push(url);
      const audio = document.createElement('audio'); audio.src = url; audio.controls = true; item.append(audio);
      audio.play().catch(() => {});
    }
    if (result.speechError) message('Speech', result.speechError, 'error');
  } catch (error) { message('Status', error.name === 'AbortError' ? 'Reply interrupted.' : error.message, 'error'); }
  finally { busy = false; request = null; phase('offline'); await refresh(); }
};
$('new-chat').onclick = async () => {
  try { await api('reset', {}); $('conversation').replaceChildren(welcome.cloneNode(true)); audioUrls.splice(0).forEach(URL.revokeObjectURL); phase('offline', 'New chat. Notes and memories stay saved.'); controls(); }
  catch (error) { $('status').textContent = error.message; }
};
document.addEventListener('keydown', event => { if (event.key === 'Escape' && live) { event.preventDefault(); try { call.interrupt(); } catch {} } });
window.addEventListener('pagehide', () => { call.disconnect(); request?.abort(); audioUrls.forEach(URL.revokeObjectURL); });
$('volume').oninput = () => call.volume(Number($('volume').value));
phase('offline'); refresh(); setInterval(refresh, 10000);
