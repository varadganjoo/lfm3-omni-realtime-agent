export function mediaSocketURL(location) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live/media`;
}

export class LiveCall {
  constructor({ api, onEvent, onStream, onClose }) {
    Object.assign(this, { api, onEvent, onStream, onClose });
    this.version = 0;
    this.sources = new Set();
    this.playAt = 0;
    this.blocked = true;
    this.minimumGeneration = 0;
    this.lastGeneration = 0;
  }

  async connect(camera) {
    const version = ++this.version;
    try {
      this.captureContext = new AudioContext({ sampleRate: 16000 });
      this.playContext = new AudioContext({ sampleRate: 24000 });
      await Promise.all([this.captureContext.resume(), this.playContext.resume()]);
      if (version !== this.version) return;
      this.gain = this.playContext.createGain(); this.gain.connect(this.playContext.destination);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: camera ? { width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 10, max: 15 } } : false
      });
      if (version !== this.version) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.onStream(this.stream);
      const socket = this.socket = new WebSocket(mediaSocketURL(location));
      socket.binaryType = 'arraybuffer';
      socket.onmessage = event => {
        if (version !== this.version) return;
        this.receive(event.data);
      };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The local media connection timed out.')), 10000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('Could not connect to the Pipecat media service.')); };
        socket.onclose = () => {
          clearTimeout(timer);
          reject(new Error('The live connection closed. Another live session may already be active.'));
          if (version === this.version) this.disconnect();
        };
      });
      if (version !== this.version) return;
      await this.captureContext.audioWorklet.addModule('/capture.js');
      if (version !== this.version) return;
      this.source = this.captureContext.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.captureContext, 'capture');
      const silent = this.captureContext.createGain(); silent.gain.value = 0;
      this.node.port.onmessage = event => {
        if (version !== this.version || !this.ready || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 512000) {
          this.onEvent({ type: 'error', message: 'The media connection fell behind. Reconnect to continue.' }); this.disconnect(); return;
        }
        socket.send(event.data);
      };
      this.source.connect(this.node); this.node.connect(silent); silent.connect(this.captureContext.destination);
      this.cameraEnabled = camera;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const preview = document.getElementById('camera');
      this.videoTimer = setInterval(() => {
        if (!this.ready || !this.cameraEnabled || !preview.videoWidth || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 200000) return;
        canvas.getContext('2d').drawImage(preview, 0, 0, 320, 240);
        socket.send(JSON.stringify({ type: 'video', image: canvas.toDataURL('image/jpeg', 0.7).split(',')[1] }));
      }, 500);
    } catch (error) {
      if (version === this.version) { await this.disconnect(); throw error; }
    }
  }

  receive(data) {
    if (data instanceof ArrayBuffer) { this.play(data); return; }
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'flush') { this.blocked = true; this.clearPlayback(); }
    if (message.type === 'interrupted') this.minimumGeneration = Math.max(this.minimumGeneration, message.generation || 0);
    if (message.type === 'answer') {
      if (message.generation < this.minimumGeneration) return;
      this.lastGeneration = message.generation;
      this.blocked = false;
    }
    if (message.type === 'state' && message.state === 'ready') this.ready = true;
    this.onEvent(message);
  }

  play(bytes) {
    if (this.blocked || !this.playContext || this.playContext.state === 'closed' || bytes.byteLength % 2) return;
    const pcm = new Int16Array(bytes), context = this.playContext;
    const buffer = context.createBuffer(1, pcm.length, 24000), samples = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    this.playAt = Math.max(this.playAt, context.currentTime + 0.025);
    if (this.playAt - context.currentTime > 1) { this.clearPlayback(); this.playAt = context.currentTime + 0.025; }
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source); source.start(this.playAt); this.playAt += buffer.duration;
  }

  clearPlayback() {
    for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.playAt = 0;
  }

  command(message) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.ready) throw new Error('The live connection is not ready yet.');
    if (['interrupt', 'text', 'mute'].includes(message.type)) {
      this.minimumGeneration = Math.max(this.minimumGeneration, this.lastGeneration + 1);
      this.blocked = true; this.clearPlayback();
    }
    this.socket.send(JSON.stringify(message));
  }
  interrupt() { this.blocked = true; this.clearPlayback(); this.command({ type: 'interrupt' }); }
  mute(enabled) { this.command({ type: 'mute', enabled }); this.stream?.getAudioTracks().forEach(track => { track.enabled = !enabled; }); }
  camera(enabled) { this.command({ type: 'camera', enabled }); this.cameraEnabled = enabled; this.stream?.getVideoTracks().forEach(track => { track.enabled = enabled; }); }
  volume(value) { if (this.gain) this.gain.gain.value = value; }

  async disconnect() {
    const version = ++this.version;
    this.ready = false; this.blocked = true; this.minimumGeneration = this.lastGeneration = 0;
    clearInterval(this.videoTimer); this.clearPlayback();
    this.socket?.close(); this.socket = null;
    this.node?.disconnect(); this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    for (const context of [this.captureContext, this.playContext]) if (context && context.state !== 'closed') await context.close();
    if (version === this.version) { this.onStream(null); this.onClose(); }
  }
}
