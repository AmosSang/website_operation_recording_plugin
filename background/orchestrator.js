// Journey Recorder - Service Worker（S1 状态机 + S2 注入与三路通路）
// 状态存 chrome.storage.session：SW 休眠不丢，浏览器关闭即清 —— F1 语义。
// IndexedDB 单一写入口收敛于此（D6，见 stores.js）。

// importScripts 的相对路径相对于 SW 自身位置（background/）解析，
// 用前导斜杠锚定扩展根目录，避免拼成 background/background/...
importScripts('/background/stores.js');
importScripts('/background/naming.js');

const SESSION_KEY = 'jr_state';
const LOCAL_KEY = 'jr_last_journey';

const DEFAULT_STATE = {
  recording: false, journeyId: null, startedAt: null, stepCount: 0, tabIds: [],
  micEnabled: false, audioT0: null, audioEndedAt: null, audioUnavailable: false,
  newlyOpenedTabs: [], // S7.1 补强：本次录制期间「从被录 tab 新打开」的 tab（供补 tab_open 初始快照）
};

function isRecordedTab(state, tabId) {
  return Array.isArray(state.tabIds) && state.tabIds.includes(tabId);
}

// F6 journey.name：从入口 URL 的 hostname 首段 + 时间生成默认名（导出时可由 AI/用户改名）
function makeJourneyName(url, startedAt) {
  let app = '旅程';
  try {
    if (url) {
      const host = new URL(url).hostname;
      if (host) app = host.split('.')[0] || host;
    }
  } catch (e) { /* 保留默认 */ }
  const d = new Date(startedAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `Journey_${app}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

// 导出文件名清洗（URL 保留字符 → _）
function fileNameSafe(name) {
  return String(name || '未命名旅程').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

// 导出日期戳 YYYYMMDD
function fmtStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ---------- S7.5 offscreen 生命周期（R7：被回收后由 SW 唤醒重建） ----------
const OFFSCREEN_PATH = 'offscreen/audio.html';
let creatingOffscreen = null; // 并发创建防抖

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: '录制口述轨音频（仅本地，随 zip 导出）',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function startAudioIfNeeded() {
  const s = await getState();
  if (!s.recording || !s.micEnabled) return;
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ source: 'jr-sw', type: 'JR_AUDIO_START' });
  console.log('[JR] audio start request →', r && r.ok ? 'ok' : (r && r.error));
}

async function getState() {
  const bag = await chrome.storage.session.get(SESSION_KEY);
  return bag[SESSION_KEY] || { ...DEFAULT_STATE };
}

async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await chrome.storage.session.set({ [SESSION_KEY]: next });
  return next;
}

// ---------- 会话丢失检测（F1） ----------
async function getStaleJourney() {
  const bag = await chrome.storage.local.get(LOCAL_KEY);
  const j = bag[LOCAL_KEY];
  if (!j || j.exported) return null;
  const s = await getState();
  if (s.recording && s.journeyId === j.journeyId) return null; // 还在录，不算丢
  return j;
}

async function ackStaleJourney() {
  await chrome.storage.local.remove(LOCAL_KEY);
}

// ---------- 降级告警角标 ----------
function setWarnBadge() {
  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  chrome.action.setBadgeText({ text: '!' });
}

// ---------- 视口截图（S5：结算时刻，D8；S6 起依赖 tabs 权限，整页导航后仍可用） ----------
// 仅截 recorded tabId 且其当前可见（用户切走标签页 → 不截别的页面，隐私硬约束）。
async function captureViewport(tabId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true });
    if (!tab || tab.id !== tabId) return { dataUrl: null, tag: 'viewport_missing' };
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // F3.1：单图 >5MB 降级 JPEG(85)
    if (png.length > 5 * 1024 * 1024 / 0.75) {
      try {
        const jpeg = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
        return { dataUrl: jpeg, tag: null };
      } catch (e) { return { dataUrl: png, tag: null }; }
    }
    return { dataUrl: png, tag: null };
  } catch (e) {
    console.warn('[JR] captureVisibleTab 失败:', e.message);
    return { dataUrl: null, tag: 'viewport_missing' };
  }
}

// ---------- 设置（S6）：per_step_dom_snapshot 开关，存 sync 跨设备缺省本地 ----------
const SETTINGS_KEY = 'jr_settings';
const DEFAULT_SETTINGS = { per_step_dom_snapshot: true }; // PRD F4：默认开

async function getSettings() {
  const bag = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, bag[SETTINGS_KEY] || {});
}

async function setSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// ---------- 注入（S2：三路通路） ----------
// ISOLATED：rrweb 库 + recorder（分两次注入，rrweb 失败可降级继续）
// MAIN world：net-hook
async function injectRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/rrweb.min.js'] });
  } catch (e) {
    console.error('[JR] rrweb 注入失败 → replay_stream_failed 降级:', e);
    setWarnBadge();
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/domsig.js', 'content/recorder.js'], // domsig 先于 recorder（recorder 依赖 JourneyDomsig）
    });
  } catch (e) {
    console.error('[JR] recorder 注入失败:', e);
    setWarnBadge();
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      // sanitizer 先于 net-hook（net-hook 依赖 window.JourneySanitizer 就地脱敏）
      files: ['content/sanitizer.js', 'content/net-hook-main.js'],
    });
  } catch (e) {
    console.error('[JR] net-hook 注入失败 → net_hook_failed 降级:', e);
    setWarnBadge();
  }
}

// 整页导航后 content script 随页面销毁，complete 后重注入（SPA hash 跳转不会触发此路径，无需重注）
// S7.1 兼职：新纳入 tab 的首次注入也主要靠这里（onCreated 时 URL unknown 无法预判可录性）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  getState().then(async (s) => {
    if (!s.recording || !isRecordedTab(s, tabId)) return;
    // http/https 校验在 complete 时做（此刻 URL 已知）；不满足则移出链并留痕
    const url = tab.url ?? '';
    if (!/^https?:/i.test(url)) {
      setState({
        tabIds: s.tabIds.filter((id) => id !== tabId),
        newlyOpenedTabs: (s.newlyOpenedTabs || []).filter((id) => id !== tabId),
      });
      console.log('[JR] 新 tab 非 http/https，移出录制链:', url || '(unknown)');
      return;
    }
    console.log('[JR] page complete, injecting into tab', tabId, url.slice(0, 80));
    await injectRecorder(tabId);
    // S7.1 补强：若此 tab 是「本次录制中新打开」的（非录制起点初始 tab），
    // 注入完成后补一次 tab_open 初始快照（新 tab 自身的初始画面截图/DOM），
    // 并从标记移除（后续 SPA 内刷新/导航不再重复触发）。
    const wasNewlyOpened = (s.newlyOpenedTabs || []).includes(tabId);
    if (wasNewlyOpened) {
      await setState({ newlyOpenedTabs: (s.newlyOpenedTabs || []).filter((id) => id !== tabId) });
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'JR_TAB_OPENED' });
        console.log('[JR] 新 tab 初始快照锚点已触发:', tabId);
      } catch (e) {
        console.warn('[JR] tab_open 触发失败（页面可能尚未就绪）:', e.message);
      }
    }
  });
});

// ---------- S7.1 标签页链：录制中从被录 tab 打开的新 tab 自动纳入 ----------
chrome.tabs.onCreated.addListener((tab) => {
  (async () => {
    const s = await getState();
    if (!s.recording) return;
    const opener = tab.openerTabId;
    // 只有「被录 tab 打开的」新 tab 才纳入（用户手动开的其他 tab 不录）。
    // 注意：onCreated 时 tab.url 通常是 unknown（尚未开始加载），URL 校验推迟到
    // onUpdated complete——此处只认 opener 血缘（2026-08-31 修复：URL 前置校验误杀全部新 tab）。
    if (opener == null || !isRecordedTab(s, opener)) return;
    const state = await setState({
      tabIds: [...s.tabIds, tab.id],
      newlyOpenedTabs: [...(s.newlyOpenedTabs || []), tab.id], // 标记待补 tab_open 初始快照
    });
    console.log('[JR] 新 tab 纳入录制:', tab.id, '→ tabIds:', state.tabIds);
  })();
});

// 被录 tab 关闭 → 从链中移除（数据保留）；链空不打断录制（v0.1 保持停止按钮语义）
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const s = await getState();
    if (!s.recording || !isRecordedTab(s, tabId)) return;
    const state = await setState({
      tabIds: s.tabIds.filter((id) => id !== tabId),
      newlyOpenedTabs: (s.newlyOpenedTabs || []).filter((id) => id !== tabId),
    });
    console.log('[JR] 被录 tab 关闭:', tabId, '→ 剩余 tabIds:', state.tabIds);
  })();
});

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_STATE': {
        const state = await getState();
        const stale = await getStaleJourney();
        sendResponse({ ok: true, state, stale });
        break;
      }

      case 'START_RECORDING': {
        const cur = await getState();
        if (cur.recording) {
          sendResponse({ ok: true, state: cur, alreadyRecording: true });
          break;
        }
        let tabId = msg.tabId ?? null;
        let url = msg.url ?? null;
        if (tabId == null) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) { sendResponse({ ok: false, error: '找不到活跃标签页' }); break; }
          tabId = tab.id;
          url = tab.url ?? tab.pendingUrl ?? null;
        }
        if (!url || !/^https?:/i.test(url)) {
          sendResponse({ ok: false, error: '此页面不可录制（仅支持 http/https 页面）' });
          break;
        }
        const journeyId = 'j_' + Date.now().toString(36);
        const state = await setState({
          recording: true,
          journeyId,
          startedAt: Date.now(),
          stepCount: 0,
          tabIds: [tabId],
          micEnabled: !!msg.micEnabled, // S7.5：popup 🎤 开关（默认关）
          audioT0: null,
          audioEndedAt: null,
          audioUnavailable: false,
          newlyOpenedTabs: [], // 重置新 tab 标记
        });
        await chrome.storage.local.set({
          [LOCAL_KEY]: { journeyId, startedAt: state.startedAt, exported: false },
        });
        // S6 补齐：journey 元数据落 IDB（tabIds 数组 = 标签页链，S7.1）
        await jrPut('journeys', {
          journeyId,
          startedAt: state.startedAt,
          status: 'recording',
          entryUrl: url,
          name: makeJourneyName(url, state.startedAt), // F6：导出文件名/契约名，可人工改
          tabIds: [tabId],
          micEnabled: !!msg.micEnabled,
          settings: await getSettings(),
          stepCount: 0,
        });
        // S2：注入三路通路（失败各自降级告警，不阻塞录制状态）
        await injectRecorder(tabId);
        // S7.5：录音开启则启动 offscreen 录音（异步，不阻塞开始响应）
        if (msg.micEnabled) {
          startAudioIfNeeded().catch((e) => console.warn('[JR] audio start failed:', e));
        }
        console.log('[JR] recording started', state);
        sendResponse({ ok: true, state });
        break;
      }

      case 'STOP_RECORDING': {
        // S8：停止并导出。关停各流 → offscreen 组包 → downloads 落盘 → journey 标记 completed+exported。
        const cur = await getState();
        if (!cur.recording) {
          sendResponse({ ok: true, state: cur, notRecording: true });
          break;
        }
        // ① 关停所有被录 tab 的 content（页面可能已导航走，容忍失败）
        for (const tid of cur.tabIds || []) {
          try { await chrome.tabs.sendMessage(tid, { type: 'JR_STOP' }); } catch (e) { /* 已不在，忽略 */ }
        }
        // ② 停止录音（flush 最后 chunk 由 MediaRecorder.stop 触发 ondataavailable）
        if (cur.micEnabled && !cur.audioUnavailable) {
          try {
            if (await hasOffscreen()) {
              await chrome.runtime.sendMessage({ source: 'jr-sw', type: 'JR_AUDIO_STOP' });
            }
          } catch (e) { /* offscreen 已不在，忽略 */ }
        }
        // ③ 确保 offscreen 存在（JSZip/组包依赖它；可能未被录音创建过）
        await ensureOffscreen();
        // ③.5 读取 journey 记录，取导出名（START_RECORDING 时已生成 name，保持一致）
        let journeyName = '未命名旅程';
        try {
          const jMeta = await jrGet('journeys', cur.journeyId);
          if (jMeta && jMeta.name) journeyName = jMeta.name;
        } catch (e) { /* 取不到就用默认 */ }
        // ④ offscreen 组包 → 回传 blobUrl（offscreen 无 chrome.downloads，官方文档限定其仅可用 chrome.runtime）；
        //    then SW 用 blobUrl 调 chrome.downloads.download 落盘（下载是 chrome.* API 活，归 SW）
        const exportFileName = 'JourneyRecorder/' + 'Journey_' + fileNameSafe(journeyName) + '_' + fmtStamp() + '.zip';
        const zipRes = await chrome.runtime.sendMessage({
          source: 'jr-sw', type: 'JR_EXPORT', journeyId: cur.journeyId, fileName: exportFileName,
        }).catch((e) => ({ ok: false, error: 'offscreen 通信失败: ' + e.message }));
        let exportRes = zipRes;
        if (zipRes && zipRes.ok && zipRes.blobUrl) {
          try {
            const downloadId = await chrome.downloads.download({
              url: zipRes.blobUrl, filename: exportFileName, conflictAction: 'uniquify', saveAs: false,
            });
            exportRes = { ok: true, downloadId, fileName: exportFileName, name: zipRes.name, blobSize: zipRes.blobSize };
          } catch (e) {
            console.warn('[JR export] SW downloads 失败，尝试 saveAs:', e.message);
            try {
              const downloadId = await chrome.downloads.download({
                url: zipRes.blobUrl, filename: exportFileName, conflictAction: 'uniquify', saveAs: true,
              });
              exportRes = { ok: true, downloadId, fileName: exportFileName, name: zipRes.name, blobSize: zipRes.blobSize };
            } catch (e2) {
              exportRes = { ok: false, error: '下载失败: ' + e2.message };
            }
          }
        } else if (zipRes && !zipRes.ok) {
          exportRes = zipRes;
        } else {
          exportRes = { ok: false, error: 'offscreen 未返回 blobUrl' };
        }
        // ⑤ journey 状态收尾：导出成功 → completed+exported；失败 → discarded（未导出，可重试）
        const exportOk = !!(exportRes && exportRes.ok);
        try {
          const j = await jrGet('journeys', cur.journeyId);
          if (j) {
            j.status = exportOk ? 'completed' : 'discarded';
            j.endedAt = Date.now();
            j.stepCount = cur.stepCount;
            if (exportOk) {
              j.exportedAt = Date.now();
              j.export = { downloadId: exportRes.downloadId, name: exportRes.name, blobSize: exportRes.blobSize };
            }
            await jrPut('journeys', j);
          }
        } catch (e) { /* 元数据收尾失败不阻塞 */ }
        // ⑥ 清空会话状态 + 留痕：仅导出成功才标记 exported（否则下次启动提示未导出丢失）
        const state = await setState({ ...DEFAULT_STATE });
        await chrome.storage.local.set({
          [LOCAL_KEY]: { journeyId: cur.journeyId, startedAt: cur.startedAt, exported: exportOk },
        });
        console.log('[JR] stopped & exported:', exportOk ? ('ok -> ' + exportRes.fileName) : ('FAILED -> ' + (exportRes && exportRes.error || '未知')));
        sendResponse({ ok: exportOk, state, export: exportRes });
        break;
      }

      case 'MANUAL_ANCHOR': {
        // S7.1：popup「＋在此添加锚点」→ 转发给【当前活跃 tab】（须在录制链中）→ 统一锚定通道
        const cur = await getState();
        if (!cur.recording) { sendResponse({ ok: false, error: '当前没有正在进行的录制' }); break; }
        if (!isRecordedTab(cur, msg.tabId)) { sendResponse({ ok: false, error: '当前标签页不在录制链中' }); break; }
        try {
          const r = await chrome.tabs.sendMessage(msg.tabId, { type: 'JR_MANUAL_ANCHOR' });
          sendResponse({ ok: true, stepCount: r ? r.stepCount : undefined });
        } catch (e) {
          sendResponse({ ok: false, error: '页面未就绪（可能刚导航，稍候再试）' });
        }
        break;
      }

      case 'STEP_ANCHORED': {
        // S3：锚点 → 命名（F2）→ 组装 step 元数据 → steps store 落库
        // S7.1：sender.tab.id 信任为锚点来源 tab（content→SW 消息自带），记入 step
        const cur = await getState();
        if (!cur.recording) { sendResponse({ ok: false, error: 'not recording' }); break; }
        if (!sender.tab || !isRecordedTab(cur, sender.tab.id)) { sendResponse({ ok: false, error: 'anchor from unrecorded tab' }); break; }
        const a = msg.anchor || {};
        const stepId = cur.stepCount + 1;
        const name = JourneyNaming.makeStepName(stepId, a.action, a.target, a.value, a.page ? a.page.title : null);
        const prevTs = cur.lastAnchorTs || cur.startedAt;
        await jrPut('steps', {
          key: cur.journeyId + ':' + stepId,
          journeyId: cur.journeyId,
          id: stepId,
          tabId: sender.tab.id,   // S7.1：多 tab 时间线的归属依据
          name,
          action: a.action || 'event',
          timestamp_ms: a.ts || Date.now(),
          rel_prev_ms: a.ts ? Math.max(0, a.ts - prevTs) : null,
          target: a.target || null,
          value: a.value ?? null,
          input_type: a.input_type ?? null,
          page: a.page || null,
          tags: [],          // nochange/modal 等标签由结算侧（S5/S6）依据信号补打
          signals: {},       // D4：原始信号字段，S5 起填充
          artifacts: {},     // 证据引用，S6 起填充
          user_note: '',     // F10 转写后处理回填
        });
        const state = await setState({ stepCount: stepId, lastAnchorTs: a.ts || Date.now() });
        // journeys.stepCount 冗余同步（journey 概览用，S8 组包时以 steps store 实际记录为准）
        jrGet('journeys', cur.journeyId).then((j) => {
          if (j) { j.stepCount = stepId; jrPut('journeys', j); }
        }).catch(() => {});
        console.log('[JR] ANCHOR #' + stepId, name);
        sendResponse({ ok: true, stepId, stepCount: state.stepCount, name, journeyId: cur.journeyId, stepKey: cur.journeyId + ':' + stepId });
        break;
      }

      case 'STEP_SETTLED': {
        // S5/S6：结算取证 → 截图（结算时刻，D8）→ 更新 steps（settle_tag/signals/截图/dom_html）
        // S7.1：截图按步骤所属 tab（sender），非全局唯一 tab
        const cur = await getState();
        if (!cur.recording) { sendResponse({ ok: false, error: 'not recording' }); break; }
        const settleTabId = sender && sender.tab ? sender.tab.id : null;
        if (settleTabId == null || !isRecordedTab(cur, settleTabId)) { sendResponse({ ok: false, error: 'settle from unrecorded tab' }); break; }
        const step = await jrGet('steps', msg.stepKey);
        if (!step) { sendResponse({ ok: false, error: 'step not found: ' + msg.stepKey }); break; }
        const shot = await captureViewport(settleTabId);
        const settings = await getSettings();
        step.settle_tag = msg.settleTag;
        step.signals = msg.signals || {};
        step.settled_at = msg.ts;
        step.viewport_png = shot.dataUrl || null;
        step.artifacts = Object.assign({}, step.artifacts, {
          viewport_png: shot.dataUrl ? 'inline_dataurl' : null,
          dom_html: (settings.per_step_dom_snapshot && msg.domHtml) ? 'inline_field' : null,
        });
        if (shot.tag) step.tags = [...(step.tags || []), shot.tag];        // viewport_missing
        if (msg.settleTag !== 'settled') step.tags = [...(step.tags || []), msg.settleTag];
        if (settings.per_step_dom_snapshot && msg.domHtml) {
          step.dom_html = msg.domHtml;
        } else if (!settings.per_step_dom_snapshot) {
          step.dom_html = null; // F4：开关关闭只留截图+信号
        }
        await jrPut('steps', step);
        // R2 体积预警：50 步黄牌（不阻塞）
        if (step.id === 50) {
          console.warn('[JR] ⚠️ 已录 50 步：双证据体积可能膨胀，长行程可关闭 per-step DOM 快照');
          chrome.notifications.create({
            type: 'basic', iconUrl: 'icons/icon128.png', title: 'Journey Recorder',
            message: '已录 50 步：体积可能膨胀。长行程可在设置中关闭每步 DOM 快照。',
          }, () => chrome.runtime.lastError); // 通知权限缺失则静默（控制台已告警）
        }
        console.log(`[JR] SETTLED #${step.id} [${msg.settleTag}] ${msg.signals ? msg.signals.durationMs + 'ms' : ''} shot:${shot.dataUrl ? 'ok' : (shot.tag || 'none')} dom:${step.dom_html ? 'on' : 'off'}`);
        sendResponse({ ok: true });
        break;
      }

      case 'GET_SETTINGS': {
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      }

      case 'SET_SETTINGS': {
        const next = await setSettings(msg.patch || {});
        console.log('[JR] settings updated:', next);
        sendResponse({ ok: true, settings: next });
        break;
      }

      case 'RR_CHUNK': {
        const cur = await getState();
        if (!cur.recording) { sendResponse({ ok: false, error: 'not recording' }); break; }
        await jrAdd('rrEvents', {
          journeyId: cur.journeyId,
          tabId: sender && sender.tab ? sender.tab.id : null, // S7.1：多 tab 回放时间线归属
          ts: msg.chunkTs,
          events: msg.events,
        });
        const kinds = msg.events.map((e) => e.type);
        console.log(`[JR] RR_CHUNK ${msg.events.length} events → IDB (types: ${kinds.slice(0, 3).join(',')}...)`);
        sendResponse({ ok: true });
        break;
      }

      case 'NET_EVT': {
        // S4：MAIN world 已就地脱敏（红线①），SW 落库 netCalls，step_id = 此刻最新 Step（F5 时间窗）
        const cur = await getState();
        if (!cur.recording) { sendResponse({ ok: false, error: 'not recording' }); break; }
        const c = msg.call || {};
        await jrAdd('netCalls', {
          journeyId: cur.journeyId,
          tabId: sender && sender.tab ? sender.tab.id : null, // S7.1
          stepId: cur.stepCount,
          ts: c.endTs || Date.now(),
          call: c,
        });
        console.log(`[JR] NET_EVT #${cur.stepCount} [${c.kind}] ${c.method} ${c.status} (${(c.endTs || 0) - (c.startTs || 0)}ms) ${String(c.url || '').slice(0, 100)}`);
        sendResponse({ ok: true });
        break;
      }

      case 'PIPE_WARN': {
        console.error(`[JR] 降级告警 [${msg.pipe}]:`, msg.error);
        setWarnBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'PAGE_ASSETS': {
        // S8 资源抓取：每页一套（外链 CSS/字体/图片），按 pageUrl 去重落库。
        // 仅在录制中且 sender tab 属于录制链时接收。
        const cur = await getState();
        if (!cur.recording) { sendResponse({ ok: false, error: 'not recording' }); break; }
        const sid = sender && sender.tab ? sender.tab.id : null;
        if (sid == null || !isRecordedTab(cur, sid)) { sendResponse({ ok: false, error: 'assets from unrecorded tab' }); break; }
        if (!msg.pageUrl) { sendResponse({ ok: false, error: 'no pageUrl' }); break; }
        try {
          // 去重：同一页面（pageKey）只存一份；已存在则跳过（保留先到的）
          const existing = await jrGet('pageAssets', msg.pageUrl);
          if (existing) {
            // 合并 fetched：以已有为准（同 pageUrl）
            sendResponse({ ok: true, deduped: true });
            break;
          }
          await jrPut('pageAssets', {
            pageUrl: msg.pageUrl,
            pageKey: msg.pageUrl,
            pageTitle: msg.pageTitle || '',
            pageHtml: msg.pageHtml || '',
            fetched: msg.fetched || {},
            journeyId: cur.journeyId,
            collectedAt: Date.now(),
          });
          console.log(`[JR] PAGE_ASSETS ${String(msg.pageUrl).slice(0, 60)} (${Object.keys(msg.fetched || {}).length} 资源)`);
          sendResponse({ ok: true, deduped: false });
        } catch (e) {
          console.error('[JR] PAGE_ASSETS 落库失败:', e);
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }

      case 'AUDIO_CHUNK': {
        // S7.5：offscreen 录音 chunk → audio store；首 chunk 落地时刻 = t0（D10 时钟契约）
        const cur = await getState();
        if (!cur.recording || !cur.micEnabled) { sendResponse({ ok: false, error: 'not recording' }); break; }
        const patch = {};
        if (!cur.audioT0) patch.audioT0 = Date.now(); // 首 chunk 盖戳（seq=1 与 t0 双保险）
        // msg.bufArr 是数字数组（offscreen 因 JSON 通道转的）；还原为真正 Uint8Array 存 IDB，
        // 否则 exporter 读回 new Blob([...]) 会拼成 "[object Object]" 字符串。
        const bytes = msg.bufArr ? new Uint8Array(msg.bufArr).buffer : (msg.buf || null);
        await jrAdd('audio', {
          journeyId: cur.journeyId,
          seq: msg.seq,
          ts: msg.ts,          // offscreen 侧 Date.now()（同一时钟体系）
          bytes,
        });
        if (Object.keys(patch).length) await setState(patch);
        console.log(`[JR] AUDIO_CHUNK #${msg.seq} ${bytes ? bytes.byteLength : 0}B → IDB`);
        sendResponse({ ok: true });
        break;
      }

      case 'AUDIO_UNAVAILABLE': {
        // S7.5 降级：授权拒绝/设备异常 → 标记后其余功能不受影响（F10）
        const cur = await getState();
        console.warn('[JR] 音频不可用（降级继续录）:', msg.error);
        if (cur.recording) await setState({ micEnabled: false, audioUnavailable: true });
        sendResponse({ ok: true });
        break;
      }

      case 'ACK_STALE': {
        await ackStaleJourney();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
    }
  })();
  return true;
});

console.log('[JourneyRecorder] service worker loaded (S7.5 audio)');
