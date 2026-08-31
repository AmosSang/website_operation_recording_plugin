// Journey Recorder - offscreen 录音模块（S7.5 路线 C：只录不转写）
// 由 SW 以 reason=USER_MEDIA 创建（getUserMedia 的正当理由）；生命周期独立于 popup/页面跳转。
// MediaRecorder(audio/webm;codecs=opus) → chunk 每 ~2s（timeslice）经 SW 入 IDB audio store。
// 时钟契约 D10：全链 Date.now()；首个 chunk 落地时刻 = t0（SW 侧记录，导出写 timeline.json）。
// 授权拒绝/设备异常 → AUDIO_UNAVAILABLE 降级，其余功能不受影响。
(() => {
  let recorder = null;
  let stream = null;
  let chunkSeq = 0;

  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch((e) => console.warn('[JR audio] send failed:', e));

  function stopAll() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* */ }
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* */ }
    recorder = null;
    stream = null;
    console.log('[JR audio] recorder stopped & tracks released');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== 'jr-sw') return;

    if (msg.type === 'JR_AUDIO_START') {
      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mime = 'audio/webm;codecs=opus';
          if (!MediaRecorder.isTypeSupported(mime)) {
            send({ type: 'AUDIO_UNAVAILABLE', error: 'mime not supported: ' + mime });
            sendResponse({ ok: false, error: 'mime' });
            return;
          }
          recorder = new MediaRecorder(stream, { mimeType: mime });
          recorder.ondataavailable = (e) => {
            if (!e.data || e.data.size === 0) return;
            chunkSeq++;
            // Blob 转 ArrayBuffer → 再转普通数字数组后才能过 chrome.runtime.sendMessage。
            // 坑：扩展消息通道默认 JSON 序列化，ArrayBuffer 会被变回 {}（丢失二进制）。
            // 故发送侧用 bufArr（数字数组），SW 收到后 new Uint8Array(bufArr).buffer 还原。
            // t0 由 SW 在收到首 chunk 时盖戳（D10）。
            e.data.arrayBuffer().then((buf) => {
              send({ type: 'AUDIO_CHUNK', seq: chunkSeq, ts: Date.now(), bufArr: Array.from(new Uint8Array(buf)) }).catch(() => {});
            });
          };
          recorder.start(2000); // 每 2s 一个 chunk（R7：offscreen 被回收最多丢最后 2s）
          console.log('[JR audio] recording started (opus, 2s chunks)');
          sendResponse({ ok: true });
        } catch (e) {
          const errName = e && e.name;
          console.warn('[JR audio] getUserMedia 失败:', errName, e.message);
          send({ type: 'AUDIO_UNAVAILABLE', error: (errName || '') + ': ' + e.message });
          sendResponse({ ok: false, error: errName || 'getUserMedia failed' });
        }
      })();
      return true; // 异步应答
    }

    if (msg.type === 'JR_AUDIO_STOP') {
      stopAll();
      sendResponse({ ok: true, chunks: chunkSeq });
      return;
    }
  });

  console.log('[JR audio] offscreen audio module ready');
})();
