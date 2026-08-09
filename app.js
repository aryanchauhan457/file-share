(() => {
  'use strict';

  const CONFIG = {
    SIGNALING_URL: 'https://script.google.com/macros/s/AKfycbyyWiAmwxOKAq2pO5MurlZGp1DL9UxON8b_aH3b-MzHG-DdXSx46LG2DTmXhFN_yAWTYg/exec',
    FILE_CHUNK_SIZE: 32 * 1024,
    HEARTBEAT_MS: 20_000,
    INCOMING_POLL_MS: 2_500,
    SESSION_POLL_MS: 1_200,
    REQUEST_TIMEOUT_MS: 20_000,
    ICE_SERVERS: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  const STORAGE_KEY = 'p2p-file-share-device';
  const SESSION_KEY = 'p2p-file-share-session';

  const state = {
    device: null,
    session: null,
    role: null,
    pc: null,
    channel: null,
    incomingTimer: null,
    sessionTimer: null,
    heartbeatTimer: null,
    channelHeartbeatTimer: null,
    localReceivingId: null,
    transferCounter: 0,
    transfers: new Map(),
    remoteReady: false
  };

  const el = {};
  [
    'appStatus',
    'deviceName',
    'deviceCode',
    'deviceId',
    'copyCodeBtn',
    'newDeviceBtn',
    'resetLocalBtn',
    'pairCodeInput',
    'connectBtn',
    'refreshIncomingBtn',
    'incomingList',
    'sessionState',
    'sessionId',
    'peerRole',
    'peerCode',
    'leaveBtn',
    'dropZone',
    'fileInput',
    'transferList',
    'log'
  ].forEach(id => {
    el[id] = document.getElementById(id);
  });

  function log(message, kind = 'info') {
    const row = document.createElement('div');
    row.className = kind;
    row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    el.log.appendChild(row);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function setAppStatus(text, kind = 'info') {
    el.appStatus.textContent = text;
    el.appStatus.style.color =
      kind === 'good' ? 'var(--ok)' :
      kind === 'warn' ? 'var(--warn)' :
      kind === 'bad' ? 'var(--error)' : '#2942a8';
  }

  function setSessionState(text) {
    el.sessionState.textContent = text || 'idle';
  }

  function setText(node, value) {
    node.textContent = value || '—';
  }

  function saveDeviceLocal(device) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
  }

  function loadDeviceLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function saveSessionLocal(sessionId) {
    if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
    else localStorage.removeItem(SESSION_KEY);
  }

  function loadSessionLocal() {
    return localStorage.getItem(SESSION_KEY) || '';
  }

  function safeCallbackName() {
    return `jsonp_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function apiCall(action, params = {}) {
    return new Promise((resolve, reject) => {
      const cb = safeCallbackName();
      const url = new URL(CONFIG.SIGNALING_URL);
      url.searchParams.set('action', action);
      url.searchParams.set('callback', cb);
      url.searchParams.set('_ts', String(Date.now()));

      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }

      const script = document.createElement('script');
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[cb]; } catch {}
      };

      window[cb] = payload => {
        cleanup();
        if (payload && payload.ok === false) {
          reject(new Error(payload.error || `Request failed for ${action}`));
          return;
        }
        resolve(payload);
      };

      script.onerror = () => {
        cleanup();
        reject(new Error(`Request failed for ${action}`));
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Request timed out for ${action}`));
      }, CONFIG.REQUEST_TIMEOUT_MS);

      script.src = url.toString();
      document.head.appendChild(script);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function updateDeviceUI() {
    if (!state.device) {
      setText(el.deviceName, '—');
      setText(el.deviceCode, '—');
      setText(el.deviceId, '—');
      return;
    }
    setText(el.deviceName, state.device.display_name);
    setText(el.deviceCode, state.device.pairing_code);
    setText(el.deviceId, state.device.device_id);
  }

  function updateSessionUI() {
    if (!state.session) {
      setText(el.sessionState, 'idle');
      setText(el.sessionId, '—');
      setText(el.peerRole, '—');
      setText(el.peerCode, '—');
      el.leaveBtn.disabled = true;
      return;
    }

    setText(el.sessionState, state.session.status || 'unknown');
    setText(el.sessionId, state.session.session_id || '—');
    setText(el.peerRole, state.role || '—');
    setText(el.peerCode, state.session.target_code || '—');
    el.leaveBtn.disabled = false;
  }

  function stopTimers() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.incomingTimer) clearInterval(state.incomingTimer);
    if (state.sessionTimer) clearInterval(state.sessionTimer);
    if (state.channelHeartbeatTimer) clearInterval(state.channelHeartbeatTimer);

    state.heartbeatTimer = null;
    state.incomingTimer = null;
    state.sessionTimer = null;
    state.channelHeartbeatTimer = null;
  }

  function startTimers() {
    stopTimers();

    state.heartbeatTimer = setInterval(() => {
      if (!state.device) return;
      apiCall('apiHeartbeat', {
        device_id: state.device.device_id,
        token: state.device.token
      }).catch(err => log(`Heartbeat failed: ${err.message}`, 'warn'));
    }, CONFIG.HEARTBEAT_MS);

    state.incomingTimer = setInterval(() => {
      if (!state.device) return;
      refreshIncoming().catch(() => {});
    }, CONFIG.INCOMING_POLL_MS);

    state.sessionTimer = setInterval(() => {
      if (!state.session) return;
      pollSession().catch(() => {});
    }, CONFIG.SESSION_POLL_MS);
  }

  function renderIncoming(items) {
    if (!items.length) {
      el.incomingList.className = 'list empty';
      el.incomingList.textContent = 'No incoming requests.';
      return;
    }

    el.incomingList.className = 'list';
    el.incomingList.innerHTML = '';

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'request';

      const left = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `Session ${item.session_id}`;
      const meta = document.createElement('div');
      meta.className = 'muted-line';
      meta.textContent = `From device ${item.requester_id} • Status: ${item.status}`;
      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'request-actions';

      const accept = document.createElement('button');
      accept.className = 'btn';
      accept.type = 'button';
      accept.textContent = 'Accept';
      accept.onclick = () => acceptIncoming(item.session_id);

      const reject = document.createElement('button');
      reject.className = 'btn secondary';
      reject.type = 'button';
      reject.textContent = 'Reject';
      reject.onclick = () => rejectIncoming(item.session_id);

      actions.appendChild(accept);
      actions.appendChild(reject);

      card.appendChild(left);
      card.appendChild(actions);
      el.incomingList.appendChild(card);
    });
  }

  async function refreshIncoming() {
    if (!state.device) return;
    const res = await apiCall('apiListIncoming', {
      device_id: state.device.device_id,
      token: state.device.token
    });
    const incoming = (res.incoming || []).filter(item => String(item.status || '') === 'pending');
    renderIncoming(incoming);
  }

  async function acceptIncoming(sessionId) {
    try {
      const res = await apiCall('apiAcceptSession', {
        device_id: state.device.device_id,
        token: state.device.token,
        session_id: sessionId
      });
      log(`Accepted session ${res.session_id}`, 'good');
      await refreshIncoming();
      await beginSession(sessionId, 'receiver');
    } catch (err) {
      log(err.message, 'bad');
    }
  }

  async function rejectIncoming(sessionId) {
    try {
      await apiCall('apiRejectSession', {
        device_id: state.device.device_id,
        token: state.device.token,
        session_id: sessionId
      });
      log(`Rejected session ${sessionId}`, 'warn');
      await refreshIncoming();
    } catch (err) {
      log(err.message, 'bad');
    }
  }

  async function connectByCode() {
    const code = (el.pairCodeInput.value || '').trim().toUpperCase();
    if (!code) {
      log('Enter a pairing code first.', 'warn');
      return;
    }
    if (state.session) {
      log('Leave the current session before starting a new one.', 'warn');
      return;
    }

    try {
      const res = await apiCall('apiCreateConnectRequest', {
        device_id: state.device.device_id,
        token: state.device.token,
        target_code: code
      });
      if (!res || !res.session_id) throw new Error('Session creation failed.');
      log(`Connect request created: ${res.session_id}`, 'good');
      await beginSession(res.session_id, 'requester');
    } catch (err) {
      log(err.message, 'bad');
    }
  }

  function inferRole(session) {
    return session.requester_id === state.device.device_id ? 'requester' : 'receiver';
  }

  async function beginSession(sessionId, roleHint) {
    saveSessionLocal(sessionId);

    const res = await apiCall('apiGetSession', {
      device_id: state.device.device_id,
      token: state.device.token,
      session_id: sessionId
    });

    state.session = res.session;
    state.role = roleHint || inferRole(res.session);
    updateSessionUI();
    setSessionState(state.session.status || 'starting');

    await teardownPeerConnection();
    await setupPeerConnection();

    if (state.role === 'requester') {
      log('Waiting for the other side to accept…', 'info');
      await pollSession();
    } else {
      log('Waiting for offer…', 'info');
      await waitForOfferAndAnswer();
    }
  }

  async function pollSession() {
    if (!state.session) return;

    const res = await apiCall('apiGetSession', {
      device_id: state.device.device_id,
      token: state.device.token,
      session_id: state.session.session_id
    });

    state.session = res.session;
    updateSessionUI();

    const st = res.session.status;
    if (st === 'rejected' || st === 'closed' || st === 'expired') {
      log(`Session ${res.session.session_id} ended: ${st}`, 'warn');
      await leaveSession(true);
      return;
    }

    if (state.role === 'requester') {
      if (st === 'accepted' && !state.pc.localDescription) {
        await createAndSendOffer();
      }
      if (res.session.answer_sdp && !state.remoteReady) {
        await applyRemoteAnswer(res.session.answer_sdp);
      }
    } else if (state.role === 'receiver') {
      if (res.session.offer_sdp && !state.remoteReady) {
        await handleOfferAndAnswer(res.session.offer_sdp);
      }
    }
  }

  async function waitForOfferAndAnswer() {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (state.session && Date.now() < deadline) {
      const res = await apiCall('apiGetSession', {
        device_id: state.device.device_id,
        token: state.device.token,
        session_id: state.session.session_id
      });

      state.session = res.session;
      updateSessionUI();

      const st = res.session.status;
      if (st === 'rejected' || st === 'closed' || st === 'expired') {
        log(`Session ${res.session.session_id} ended: ${st}`, 'warn');
        await leaveSession(true);
        return;
      }

      if (res.session.offer_sdp) {
        await handleOfferAndAnswer(res.session.offer_sdp);
        return;
      }

      await sleep(1200);
    }

    log('Timed out waiting for offer.', 'warn');
  }

  async function createAndSendOffer() {
    if (!state.pc) throw new Error('Peer connection missing.');

    const channel = state.pc.createDataChannel('files');
    attachChannel(channel);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await waitForIceGathering(state.pc, 7000);

    await apiCall('apiSaveOffer', {
      device_id: state.device.device_id,
      token: state.device.token,
      session_id: state.session.session_id,
      sdp: JSON.stringify(state.pc.localDescription)
    });

    log('Offer published.', 'good');
    await waitForAnswer();
  }

  async function waitForAnswer() {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (state.session && Date.now() < deadline) {
      const res = await apiCall('apiGetAnswer', {
        device_id: state.device.device_id,
        token: state.device.token,
        session_id: state.session.session_id
      });

      const sdp = res.sdp || res.answer_sdp || '';
      if (sdp) {
        await applyRemoteAnswer(sdp);
        return;
      }

      await sleep(1200);
    }

    log('Timed out waiting for answer.', 'warn');
  }

  async function handleOfferAndAnswer(offerSdp) {
    if (!state.pc) throw new Error('Peer connection missing.');

    const offer = JSON.parse(offerSdp);
    await state.pc.setRemoteDescription(new RTCSessionDescription(offer));
    state.remoteReady = true;

    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await waitForIceGathering(state.pc, 7000);

    await apiCall('apiSaveAnswer', {
      device_id: state.device.device_id,
      token: state.device.token,
      session_id: state.session.session_id,
      sdp: JSON.stringify(state.pc.localDescription)
    });

    log('Answer published.', 'good');
  }

  async function applyRemoteAnswer(answerSdp) {
    try {
      const answer = JSON.parse(answerSdp);
      await state.pc.setRemoteDescription(new RTCSessionDescription(answer));
      state.remoteReady = true;
      log('Remote answer applied.', 'good');
      setSessionState('connecting');
    } catch (err) {
      log(`Failed to apply answer: ${err.message}`, 'bad');
    }
  }

  async function setupPeerConnection() {
    state.pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
    state.remoteReady = false;

    state.pc.oniceconnectionstatechange = async () => {
      const st = state.pc.iceConnectionState;
      setSessionState(st);

      if (st === 'connected' || st === 'completed') {
        log('WebRTC connected.', 'good');
        await apiCall('apiMarkConnected', {
          device_id: state.device.device_id,
          token: state.device.token,
          session_id: state.session.session_id
        }).catch(() => {});
      } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        log(`ICE state: ${st}`, st === 'failed' ? 'bad' : 'warn');
      }
    };

    state.pc.onconnectionstatechange = () => {
      const st = state.pc.connectionState;
      setSessionState(st);
      if (st === 'connected') {
        log('Peer connection ready.', 'good');
      }
    };

    state.pc.ondatachannel = event => {
      attachChannel(event.channel);
    };
  }

  function attachChannel(channel) {
    state.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 1024 * 1024;

    channel.onopen = () => {
      log('Data channel open.', 'good');
      setSessionState('connected');

      apiCall('apiMarkConnected', {
        device_id: state.device.device_id,
        token: state.device.token,
        session_id: state.session.session_id
      }).catch(() => {});

      if (state.channelHeartbeatTimer) clearInterval(state.channelHeartbeatTimer);
      state.channelHeartbeatTimer = setInterval(() => {
        if (state.channel && state.channel.readyState === 'open') {
          try {
            state.channel.send(JSON.stringify({ type: 'ping', t: Date.now() }));
          } catch {}
        }
      }, CONFIG.HEARTBEAT_MS);
    };

    channel.onclose = () => {
      log('Data channel closed.', 'warn');
      if (state.channelHeartbeatTimer) clearInterval(state.channelHeartbeatTimer);
      state.channelHeartbeatTimer = null;
    };

    channel.onerror = () => {
      log('Data channel error.', 'bad');
    };

    channel.onmessage = event => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          handleControlMessage(msg);
        } catch {
          log(`Message: ${event.data}`, 'info');
        }
        return;
      }

      handleBinaryChunk(event.data);
    };
  }

  function handleControlMessage(msg) {
    switch (msg.type) {
      case 'file-start':
        state.localReceivingId = msg.transferId;
        state.transfers.set(msg.transferId, {
          meta: msg,
          chunks: [],
          bytes: 0
        });
        addTransferUI(msg.transferId, msg.name, msg.size, 'Receiving');
        log(`Receiving ${msg.name}`, 'info');
        break;

      case 'file-end':
        finalizeTransfer(msg.transferId);
        break;

      case 'ping':
        if (state.channel && state.channel.readyState === 'open') {
          try {
            state.channel.send(JSON.stringify({ type: 'pong', t: Date.now() }));
          } catch {}
        }
        break;

      case 'pong':
        break;

      default:
        log(`Control: ${msg.type || 'unknown'}`, 'info');
    }
  }

  function handleBinaryChunk(chunk) {
    const current = state.localReceivingId;
    if (!current) return;
    const transfer = state.transfers.get(current);
    if (!transfer) return;

    transfer.chunks.push(chunk);
    transfer.bytes += chunk.byteLength || chunk.size || 0;
    updateTransferUI(current, transfer.bytes, transfer.meta.size);
  }

  function addTransferUI(id, name, size, label) {
    const wrap = document.createElement('div');
    wrap.className = 'transfer-item';
    wrap.dataset.transferId = id;
    wrap.innerHTML = `
      <div><strong>${escapeHtml(name)}</strong></div>
      <div class="muted-line">${label} • ${formatBytes(size)}</div>
      <div class="progress-wrap"><div class="progress-bar"></div></div>
      <div class="muted-line status-text">0%</div>
    `;
    el.transferList.classList.remove('empty');
    el.transferList.appendChild(wrap);
  }

  function updateTransferUI(id, bytes, total) {
    const item = el.transferList.querySelector(`[data-transfer-id="${CSS.escape(id)}"]`);
    if (!item) return;
    const bar = item.querySelector('.progress-bar');
    const text = item.querySelector('.status-text');
    const pct = total ? Math.min(100, Math.floor((bytes / total) * 100)) : 0;
    bar.style.width = pct + '%';
    text.textContent = `${pct}% • ${formatBytes(bytes)} / ${formatBytes(total)}`;
  }

  function finalizeTransfer(id) {
    const transfer = state.transfers.get(id);
    if (!transfer) return;

    const item = el.transferList.querySelector(`[data-transfer-id="${CSS.escape(id)}"]`);
    if (!item) return;

    const blob = new Blob(transfer.chunks, { type: transfer.meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = transfer.meta.name || 'download.bin';
    link.textContent = `Download ${transfer.meta.name || 'file'}`;
    link.className = 'btn';
    link.style.display = 'inline-block';
    link.style.marginTop = '10px';

    const status = item.querySelector('.status-text');
    status.textContent = 'Completed';
    item.appendChild(link);

    state.transfers.delete(id);
    state.localReceivingId = null;
    log(`Received ${transfer.meta.name}`, 'good');
  }

  async function sendFiles(fileList) {
    if (!state.channel || state.channel.readyState !== 'open') {
      log('Connect first; the data channel is not open.', 'warn');
      return;
    }

    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
      await sendSingleFile(file);
    }
  }

  async function sendSingleFile(file) {
    const transferId = `tx_${++state.transferCounter}_${Date.now()}`;
    addTransferUI(transferId, file.name, file.size, 'Sending');
    log(`Sending ${file.name}`, 'info');

    state.channel.send(JSON.stringify({
      type: 'file-start',
      transferId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      lastModified: file.lastModified || Date.now()
    }));

    let sent = 0;
    while (sent < file.size) {
      await waitForBufferDrain();
      const chunk = file.slice(sent, sent + CONFIG.FILE_CHUNK_SIZE);
      const buffer = await chunk.arrayBuffer();
      state.channel.send(buffer);
      sent += buffer.byteLength;
      updateTransferUI(transferId, sent, file.size);
    }

    state.channel.send(JSON.stringify({ type: 'file-end', transferId }));
    log(`Finished sending ${file.name}`, 'good');
  }

  async function waitForBufferDrain() {
    if (!state.channel) return;
    const ch = state.channel;
    if (ch.bufferedAmount < 4 * 1024 * 1024) return;

    await new Promise(resolve => {
      const onLow = () => {
        ch.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      ch.addEventListener('bufferedamountlow', onLow);
    });
  }

  async function waitForIceGathering(pc, timeoutMs = 6000) {
    if (pc.iceGatheringState === 'complete') return;

    await new Promise(resolve => {
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };

      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };

      pc.addEventListener('icegatheringstatechange', onChange);
      setTimeout(finish, timeoutMs);
    });
  }

  async function teardownPeerConnection() {
    if (state.channel) {
      try { state.channel.close(); } catch {}
      state.channel = null;
    }
    if (state.pc) {
      try { state.pc.close(); } catch {}
      state.pc = null;
    }
    if (state.channelHeartbeatTimer) clearInterval(state.channelHeartbeatTimer);
    state.channelHeartbeatTimer = null;
    state.remoteReady = false;
  }

  async function leaveSession(clearRemote = true) {
    if (state.session) {
      try {
        await apiCall('apiCloseSession', {
          device_id: state.device.device_id,
          token: state.device.token,
          session_id: state.session.session_id
        });
      } catch (err) {
        log(err.message, 'warn');
      }
    }

    await teardownPeerConnection();
    if (clearRemote) saveSessionLocal('');

    state.session = null;
    state.role = null;
    updateSessionUI();
    setSessionState('idle');
    log('Left session.', 'warn');
    await refreshIncoming();
  }

  async function tryRestoreSession(sessionId) {
    try {
      const res = await apiCall('apiGetSession', {
        device_id: state.device.device_id,
        token: state.device.token,
        session_id: sessionId
      });

      state.session = res.session;
      state.role = inferRole(res.session);
      updateSessionUI();
      log(`Restored session ${sessionId}`, 'info');

      await setupPeerConnection();

      if (state.role === 'requester') {
        if (res.session.status === 'accepted' || res.session.status === 'offer_saved') {
          if (!state.pc.localDescription) {
            await createAndSendOffer();
          }
        }
        if (res.session.answer_sdp) {
          await applyRemoteAnswer(res.session.answer_sdp);
        }
      } else {
        if (res.session.offer_sdp) {
          await handleOfferAndAnswer(res.session.offer_sdp);
        }
      }
    } catch (err) {
      saveSessionLocal('');
      log(`Could not restore session: ${err.message}`, 'warn');
    }
  }

  async function createDevice() {
    const result = await apiCall('apiCreateDevice', {});
    if (!result || !result.device) {
      throw new Error(result && result.error ? result.error : 'apiCreateDevice returned no device');
    }
    return result.device;
  }

  async function resumeDevice(device) {
    const result = await apiCall('apiResumeDevice', {
      device_id: device.device_id,
      token: device.token
    });
    if (!result || !result.device) {
      throw new Error(result && result.error ? result.error : 'apiResumeDevice returned no device');
    }
    return result.device;
  }

  async function bootstrap() {
    setAppStatus('Bootstrapping…');

    try {
      const status = await apiCall('status');
      if (!status || !status.ok) {
        throw new Error('Signal API did not return ok.');
      }
      log(status.message || 'Signal API reachable.', 'good');
    } catch (err) {
      setAppStatus('Signal API failed', 'bad');
      log(err.message, 'bad');
      return;
    }

    let cached = loadDeviceLocal();
    try {
      let device;
      if (cached && cached.device_id && cached.token) {
        try {
          device = await resumeDevice(cached);
          log(`Resumed device: ${device.display_name} (${device.pairing_code})`, 'good');
        } catch (err) {
          log(`Resume failed: ${err.message}`, 'warn');
          localStorage.removeItem(STORAGE_KEY);
          cached = null;
          device = await createDevice();
          log(`Created device: ${device.display_name} (${device.pairing_code})`, 'good');
        }
      } else {
        device = await createDevice();
        log(`Created device: ${device.display_name} (${device.pairing_code})`, 'good');
      }

      state.device = device;
      saveDeviceLocal(device);
      updateDeviceUI();
      setAppStatus('Online', 'good');

      await refreshIncoming();
      startTimers();

      const savedSessionId = loadSessionLocal();
      if (savedSessionId) {
        await tryRestoreSession(savedSessionId);
      }
    } catch (err) {
      setAppStatus('Device setup failed', 'bad');
      log(err.message, 'bad');
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  el.copyCodeBtn.addEventListener('click', async () => {
    if (!state.device) return;
    try {
      await navigator.clipboard.writeText(state.device.pairing_code);
      log('Pairing code copied.', 'good');
    } catch {
      log('Clipboard copy failed.', 'warn');
    }
  });

  el.newDeviceBtn.addEventListener('click', async () => {
    await teardownPeerConnection();
    saveSessionLocal('');
    localStorage.removeItem(STORAGE_KEY);
    state.device = null;
    state.session = null;
    state.role = null;
    updateDeviceUI();
    updateSessionUI();
    await bootstrap();
  });

  el.resetLocalBtn.addEventListener('click', async () => {
    await teardownPeerConnection();
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SESSION_KEY);
    state.device = null;
    state.session = null;
    state.role = null;
    updateDeviceUI();
    updateSessionUI();
    el.log.textContent = '';
    log('Local state cleared.', 'warn');
    await bootstrap();
  });

  el.connectBtn.addEventListener('click', connectByCode);
  el.refreshIncomingBtn.addEventListener('click', () => refreshIncoming());
  el.leaveBtn.addEventListener('click', () => leaveSession(true));

  el.fileInput.addEventListener('change', e => {
    sendFiles(e.target.files).catch(err => log(err.message, 'bad'));
    el.fileInput.value = '';
  });

  const dropZone = el.dropZone;
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    sendFiles(e.dataTransfer.files).catch(err => log(err.message, 'bad'));
  });

  window.addEventListener('beforeunload', () => {
    try {
      if (state.session && state.device) {
        apiCall('apiHeartbeat', {
          device_id: state.device.device_id,
          token: state.device.token
        }).catch(() => {});
      }
    } catch {}
  });

  window.addEventListener('error', event => {
    console.error('Global JavaScript error:', event.error || event.message);
    if (el.log) {
      log(`JavaScript error: ${event.message || 'Unknown error'}`, 'bad');
    }
  });

  window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled promise rejection:', event.reason);
    if (el.log) {
      const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason);
      log(`Unhandled error: ${reason}`, 'bad');
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.activeElement === el.pairCodeInput) {
      connectByCode();
    }
  });

  function init() {
    log('JavaScript loaded.', 'good');
    updateDeviceUI();
    updateSessionUI();
    bootstrap().catch(err => {
      setAppStatus('Startup failed', 'bad');
      log(err.message, 'bad');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
