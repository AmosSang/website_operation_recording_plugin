// Journey Recorder - 导出组包（S8，F7 打包导出）
// 运行在 offscreen document（D5：SW 无 URL.createObjectURL，offscreen 有完整 DOM API）。
// 入口由 SW 以 { source:'jr-sw', type:'JR_EXPORT', journeyId } 触发 → offscreen 内组包并下载。
// 依赖（由 offscreen/audio.html 用 <script> 引入）：
//   /vendor/jszip.min.js + /background/manifest-builder.js + /background/pack-builder.js
// 纯逻辑（命名/行号引用/域名/JSONL 展平/README）已抽到 pack-builder.js（可单测）。

const DB_NAME = 'journey-recorder';
const DB_VERSION = 2; // 与 SW stores.js 一致；v2 含 pageAssets
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function getAll(store, idx, idxVal) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    let req;
    if (idx && idxVal != null) {
      req = os.index(idx).getAll(idxVal);
    } else {
      req = os.getAll();
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ---------- 读取全部数据 ----------
async function collect(journeyId) {
  const [journeys, steps, netCalls, rrEvents, audioChunks, pageAssets] = await Promise.all([
    getAll('journeys').then((l) => l.find((j) => j.journeyId === journeyId)),
    getAll('steps'),
    getAll('netCalls', 'by_journey', journeyId),
    getAll('rrEvents', 'by_journey', journeyId),
    getAll('audio', 'by_journey', journeyId),
    getAll('pageAssets', 'by_journey', journeyId),
  ]);
  return {
    journey: journeys,
    steps: (steps || []).filter((s) => s.journeyId === journeyId),
    netCalls, rrEvents, audioChunks, pageAssets,
  };
}

// ---------- manifest 组装（用 pack-builder 纯函数 + manifest-builder 契约） ----------
function buildManifest(journey, steps, netCalls, audio, settings, pages) {
  const byStepRefs = window.JourneyPack.buildApiCallLineRefs(netCalls);
  const stepsOut = (steps || []).map((s) => {
    const refs = byStepRefs[s.id];
    const out = Object.assign({}, s, {
      _api_calls: refs ? ['net/calls.jsonl#L' + refs[0] + '-L' + refs[1]] : [],
    });
    // S8：给 step 标注所属 page_id（由组包层按 s.page.url 匹配 pages 得出）
    if (pages && s.page && s.page.url) {
      const pid = pages.pageIdByUrl[s.page.url];
      if (pid) out.page_id = pid;
    }
    return out;
  });
  const domains = window.JourneyPack.extractDomains(steps);
  const manifest = window.JourneyManifest.build({
    journey,
    steps: stepsOut,
    audio,
    settings,
    domains,
    appName: window.JourneyPack.inferAppName(journey, steps),
    recordedAt: new Date(journey.startedAt || Date.now()).toISOString(),
  });
  // S8：追加 pages 顶层段（每页一套资源的索引），契约只增不改删
  if (pages && pages.list.length) {
    manifest.pages = { list: pages.list }; // [{ page_id, url, title, entry: {page_html, assets_index} }]
  }
  return manifest;
}

// ---------- 页面资源组包（S8：每页一套，高保真仿制）----------
// 输入 pageAssets（IDB 记录数组，每条含 pageUrl/pageTitle/pageHtml/fetched）
// 输出 { list, pageIdByUrl, pageAssetsDir } —— list 供 manifest，pageIdByUrl 供 step 标注，dir 供 JSZip 落盘
function buildPages(pageAssets) {
  const R = window.JourneyResource;
  const list = [];
  const pageIdByUrl = {};
  const dirs = []; // 供调用方 zip.folder 落盘
  (pageAssets || []).forEach((pa) => {
    if (!pa || !pa.pageUrl) return;
    const pid = 'p_' + window.JourneyPack.sanitizeName(R.pageKey(pa.pageUrl));
    pageIdByUrl[pa.pageUrl] = pid;
    // 内联：外链 CSS → <style>，url() 子资源 → data:base64
    const built = R.buildPageAssets({ pageUrl: pa.pageUrl, html: pa.pageHtml || '', fetched: pa.fetched || {} });
    const pageMeta = {
      page_id: pid,
      url: pa.pageUrl,
      title: pa.pageTitle || '',
      page_html: 'pages/' + pid + '/page.html',
      assets_css: 'pages/' + pid + '/assets.css',
      asset_refs: built.assetRefs,
      sheets_missing: built.sheetsMissing,
    };
    list.push(pageMeta);
    dirs.push({ pid, pa, built });
  });
  return { list, pageIdByUrl, dirs };
}

// ---------- 组件装配 ----------
async function assembleZip(data, journeyName, micEnabled) {
  const { journey, steps, netCalls, rrEvents, audioChunks, pageAssets } = data;
  const P = window.JourneyPack;
  const R = window.JourneyResource;
  const zip = new JSZip();

  // 1) 顶层目录 + net/calls.jsonl
  const root = zip.folder('Journey_' + P.sanitizeName(journeyName) + '_' + P.fmtDate(Date.now()));
  const sortedNets = [...netCalls].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  root.folder('net').file('calls.jsonl', P.netCallsToJsonl(sortedNets));

  // 2) rrweb/events.jsonl（展平 chunks，逐事件一行，标注 __tabId）
  const flatEvents = P.flattenEvents(rrEvents);
  root.folder('rrweb').file('events.jsonl', P.eventsToJsonl(flatEvents));

  // 3) audio/journey.webm（合并 chunk）+ timeline.json（D10：t0/endMs/mimeType）
  let audio = null;
  if (audioChunks && audioChunks.length && micEnabled) {
    const sortedChunks = audioChunks.slice().sort((a, b) => a.seq - b.seq);
    const parts = sortedChunks.map((c) => c.bytes);
    const blob = new Blob(parts, { type: 'audio/webm' });
    root.folder('audio').file('journey.webm', blob);
    // D10：t0 = 录音首 chunk 时间戳（SW 收到首 chunk 时盖戳于 audioT0；此处用最早 ts 兜底）
    const t0 = sortedChunks[0].ts;
    // 末 chunk 结束时刻 = 末 chunk 时间戳 + 该 chunk 时长（未知，用 ts 近似；D10 允许 endMs 先置空）
    const endMs = null;
    audio = { recorded: true, t0, endMs, file: 'audio/journey.webm', mimeType: 'audio/webm;codecs=opus', webmBytes: blob.size };
    // F7：timeline.json = {t0, endMs, mimeType}（transcripts 对齐依据）
    root.folder('audio').file('timeline.json', JSON.stringify({ t0, endMs, mimeType: 'audio/webm;codecs=opus' }, null, 2));
  }

  // 4) steps/NNN_*/{viewport.png, dom.html}
  const stepsFolder = root.folder('steps');
  (steps || []).forEach((s) => {
    const dir = stepsFolder.folder(P.stripExt(s.name));
    if (s.viewport_png) {
      const data = s.viewport_png.startsWith('data:') ? s.viewport_png.split(',')[1] : s.viewport_png;
      dir.file('viewport.png', data, { base64: true });
    }
    if (s.dom_html) dir.file('dom.html', s.dom_html);
  });

  // 4.5) pages/<pageId>/（S8：每页一套资源，高保真仿制）
  //      page.html = 外链 CSS 内联 + url() 子资源转 data:base64 后的完整页；
  //      assets.css = 该页全部 CSS 合并（供 AI 直接引用）；assets/ 下外部文件（图片/字体）另行落盘。
  const pagesBuilt = buildPages(pageAssets);
  const pagesRoot = root.folder('pages');
  pagesBuilt.dirs.forEach(({ pid, pa, built }) => {
    const pdir = pagesRoot.folder(pid);
    // page.html：内联后的完整页面
    pdir.file('page.html', built.pageHtml || '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + (pa.pageTitle || '') + '</title></head><body>（无 DOM 快照）</body></html>');
    // assets.css：合并该页全部已抓 CSS 正文（含 @font-face），供直接引用
    const cssParts = [];
    Object.keys(pa.fetched || {}).forEach((u) => {
      const f = pa.fetched[u];
      if (f && f.textContent != null) cssParts.push('/* src: ' + u + ' */\n' + f.textContent);
    });
    pdir.file('assets.css', cssParts.join('\n\n'));
    // assets/ 下二进制资源（图片/字体）：转本地可读文件（data 已在 page.html 内联，此处留档）
    const assetsDir = pdir.folder('assets');
    Object.keys(pa.fetched || {}).forEach((u) => {
      const f = pa.fetched[u];
      if (f && f.dataBase64 != null) {
        const ext = (R.extOf(u) || 'bin');
        const name = P.sanitizeName(u.split('/').pop() || ('res.' + ext));
        assetsDir.file(name, f.dataBase64, { base64: true });
      }
    });
  });

  // 5) manifest.json
  const manifest = buildManifest(journey, steps, netCalls, audio, journey && journey.settings, { list: pagesBuilt.list, pageIdByUrl: pagesBuilt.pageIdByUrl });
  root.file('manifest.json', JSON.stringify(manifest, null, 2));

  // 6) README.txt
  root.file('README.txt', P.buildReadme(manifest, micEnabled));

  // 7) player.html（注入模板）
  const playerHtml = await assemblePlayer(flatEvents, manifest.steps, sortedNets, audio);
  root.file('player.html', playerHtml);

  // 冒烟校验 manifest schema
  const errs = window.JourneyManifest.validate(manifest);
  if (errs.length) console.warn('[JR export] manifest 冒烟校验未通过:', errs);

  return { blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), manifest, errs, audio };
}

// ---------- player.html 注入 ----------
async function assemblePlayer(flatEvents, manifestSteps, sortedNets, audio) {
  let tpl = '';
  try {
    tpl = await (await fetch(chrome.runtime.getURL('offscreen/player-template.html'))).text();
  } catch (e) {
    console.warn('[JR export] 读取 player 模板失败:', e);
    return '<!DOCTYPE html><html><body>回放器模板缺失</body></html>';
  }

  const netForPlayer = sortedNets.map((n) => ({ stepId: n.stepId || 0, call: n.call || {} }));
  // JSON.stringify 后转义 < 为 \u003c：防止数据含 </script> 提前闭合注入的 <script>（XSS/破坏回放）
  const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

  const replacements = {
    '__JR_TITLE__': (audio && audio.recorded ? '含口述轨 · ' : '') + 'Journey',
    '__JR_PLAYER_CSS__': '', // 占位，下面单独注入 <style> 内容
    '__JR_RRWEB_JS__': await readVendor('vendor/rrweb.min.js'),
    '__JR_PLAYER_JS__': await readVendor('vendor/rrweb-player.min.js'),
    '__JR_EVENTS__': safeJson(flatEvents),
    '__JR_STEPS__': safeJson(manifestSteps || []),
    '__JR_NET__': safeJson(netForPlayer),
    '__JR_AUDIO__': safeJson(audio || { recorded: false, t0: null, endMs: null, file: null, mimeType: null }),
  };

  const css = await readVendor('vendor/rrweb-player.css');
  tpl = tpl.replace('__JR_PLAYER_CSS__', css);
  Object.keys(replacements).forEach((k) => {
    if (k === '__JR_PLAYER_CSS__') return;
    tpl = tpl.split(k).join(replacements[k]);
  });
  return tpl;
}

function readVendor(path) {
  return fetch(chrome.runtime.getURL(path)).then((r) => r.text());
}

// ---------- 消息入口 ----------
// 由 SW 触发：{ source:'jr-sw', type:'JR_EXPORT', journeyId, fileName }
// 职责拆分（offscreen 无 chrome.downloads，官方文档：offscreen 只能用 chrome.runtime 收发消息，
// 其余 chrome.* API 不暴露）：
//   offscreen：读 IDB → JSZip 组包 → URL.createObjectURL(blob) → 回传 blobUrl 字符串
//   SW：拿到 blobUrl 后 chrome.downloads.download 落盘（见 orchestrator.js）
// blob URL 注册在扩展 origin，SW 的 downloads.download 可直接引用（官方 PDF 下载模式）。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.source !== 'jr-sw' || msg.type !== 'JR_EXPORT') return;
  (async () => {
    try {
      const data = await collect(msg.journeyId);
      if (!data.journey) { sendResponse({ ok: false, error: 'journey 不存在' }); return; }
      const journeyName = data.journey.name || '未命名旅程';
      const micEnabled = !!data.journey.micEnabled;
      const { blob, manifest, errs, audio } = await assembleZip(data, journeyName, micEnabled);
      const url = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000); // 下载可能耗时，5 分钟后回收
      sendResponse({ ok: true, blobUrl: url, fileName: msg.fileName, name: manifest.journey.name, manifestErr: errs, audio, blobSize: blob.size });
    } catch (e) {
      console.error('[JR export] 失败:', e);
      sendResponse({ ok: false, error: e.message, stack: e.stack });
    }
  })();
  return true; // 异步应答
});

console.log('[JR export] offscreen exporter ready (S8)');
