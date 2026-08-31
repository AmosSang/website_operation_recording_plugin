// Journey Recorder - popup（S1：录制状态机 UI）
const $ = (id) => document.getElementById(id);
const btnRecord = $('btn-record');
const stepCountEl = $('step-count');
const durationEl = $('duration');
const staleBar = $('stale-bar');
const staleText = $('stale-text');
const errorMsg = $('error-msg');

let state = null;      // SW 下发的会话状态
let tickTimer = null;  // 时长刷新

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    // SW 旧版未刷新 / 扩展刚 reload 旧上下文失效时，翻译成人话
    if (/Receiving end does not exist|Extension context invalidated/i.test(e.message)) {
      throw new Error('扩展后台未就绪：请到 chrome://extensions 点 Journey Recorder 的刷新按钮，再重开弹窗');
    }
    throw e;
  }
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function render() {
  const rec = !!state.recording;
  btnRecord.disabled = false;
  btnRecord.textContent = rec ? '■ 停止录制' : '● 开始录制';
  btnRecord.classList.toggle('recording', rec);
  $('btn-manual-anchor').disabled = !rec; // S7：仅录制中可用
  // S7.5：录音开关录制中锁定（开始时决定，中途不可改——改语义留给 v0.2 暂停/恢复）
  const micEl = $('mic-toggle');
  micEl.disabled = rec;
  if (rec) micEl.checked = !!state.micEnabled;
  stepCountEl.textContent = String(state.stepCount || 0);
  durationEl.textContent = rec ? fmtDuration(Date.now() - state.startedAt) : '00:00';
  if (rec && !tickTimer) {
    tickTimer = setInterval(() => {
      if (state.recording) durationEl.textContent = fmtDuration(Date.now() - state.startedAt);
    }, 500);
  } else if (!rec && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function refresh() {
  try {
    const res = await send({ type: 'GET_STATE' });
    state = res.state;
    if (res.stale) {
      const d = new Date(res.stale.startedAt);
      staleText.textContent =
        `上次旅程（${d.toLocaleString('zh-CN', { hour12: false })}）未导出，已随浏览器关闭丢失`;
      staleBar.hidden = false;
    }
    render();
  } catch (e) {
    // SW 未就绪：展示错误并保留可点击的开始按钮（用户修复后可直接重试）
    errorMsg.textContent = e.message;
    state = state || { recording: false, stepCount: 0 };
    render();
  }
}

btnRecord.addEventListener('click', async () => {
  errorMsg.textContent = '';
  btnRecord.disabled = true;
  try {
    if (state.recording) {
      // S8：停止并导出
      btnRecord.textContent = '导出中…';
      const res = await send({ type: 'STOP_RECORDING' });
      state = res.state;
      if (res.ok && res.export) {
        errorMsg.textContent = '✅ 已导出：' + (res.export.name || '旅程') + '（已下载，见下载栏）';
      } else if (res.export && !res.export.ok) {
        errorMsg.textContent = '⚠️ 导出失败: ' + (res.export.error || '未知');
      } else {
        errorMsg.textContent = '✅ 已停止（未导出）';
      }
    } else {
      let micEnabled = $('mic-toggle').checked;
      // S7.5 修复：授权弹窗只能由可见上下文（popup）触发；offscreen 里弹会直接
      // Permission dismissed。popup 先行探针：授权授给扩展 origin（一次性），
      // 之后 offscreen 的 getUserMedia 静默放行。
      if (micEnabled) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
          probe.getTracks().forEach((t) => t.stop()); // 立刻释放，不占麦克风
        } catch (e) {
          errorMsg.textContent = '麦克风授权失败（' + (e.name || e.message) + '），本次将不录音';
          micEnabled = false;
          $('mic-toggle').checked = false;
        }
      }
      // activeTab 已随 popup 打开授予，可读 url；传给 SW 免二次授权
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await send({
        type: 'START_RECORDING',
        tabId: tab?.id,
        url: tab?.url ?? tab?.pendingUrl ?? null,
        micEnabled,
      });
      if (!res.ok) {
        errorMsg.textContent = res.error || '启动失败';
      } else {
        state = res.state;
      }
    }
  } catch (e) {
    errorMsg.textContent = '通信异常: ' + e.message;
  }
  render();
});

$('btn-ack-stale').addEventListener('click', async () => {
  await send({ type: 'ACK_STALE' });
  staleBar.hidden = true;
});

// ---------- S7：手动锚点（S7.1 起对录制链中任意 tab 可用） ----------
$('btn-manual-anchor').addEventListener('click', async () => {
  errorMsg.textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await send({ type: 'MANUAL_ANCHOR', tabId: tab?.id }); // 归属校验在 SW（tabIds 链）
    if (!res.ok) errorMsg.textContent = res.error || '加锚失败';
    else state.stepCount = res.stepCount ?? state.stepCount;
    render();
  } catch (e) {
    errorMsg.textContent = '加锚失败: ' + e.message;
  }
});

// ---------- S6：每步 DOM 快照开关 ----------
const domToggle = $('dom-snapshot-toggle');

async function loadSettings() {
  try {
    const res = await send({ type: 'GET_SETTINGS' });
    domToggle.checked = !!res.settings.per_step_dom_snapshot;
  } catch (e) { /* SW 未就绪时保持默认勾选 */ }
}

domToggle.addEventListener('change', async () => {
  try {
    await send({ type: 'SET_SETTINGS', patch: { per_step_dom_snapshot: domToggle.checked } });
  } catch (e) {
    errorMsg.textContent = '设置保存失败: ' + e.message;
    domToggle.checked = !domToggle.checked; // 回滚 UI
  }
});

// ---------- S7.5：麦克风授权状态自查（permissions API 只读查询，不加权限） ----------
navigator.permissions.query({ name: 'microphone' }).then((st) => {
  const label = { granted: '已授权', denied: '已拒绝', prompt: '待询问' };
  const el = document.createElement('div');
  el.style.cssText = 'font-size:11px;color:#999;margin-top:4px;';
  // 只保留状态标签，去掉「🎤 麦克风权限: 」前缀（用户要求精简），denied 附重置提示
  el.textContent = (label[st.state] || st.state) +
    (st.state === 'denied' ? '（去 chrome://settings/content/microphone 重置）' : '');
  $('mic-toggle').parentElement.parentElement.appendChild(el);
  if (st.state === 'denied') {
    $('mic-toggle').checked = false;
    $('mic-toggle').disabled = true; // 已拒状态下勾了也没用，置灰防误导
  }
}).catch(() => { /* 查询失败不影响主流程 */ });

refresh();
loadSettings();
