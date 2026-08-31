// Journey Recorder - content recorder（ISOLATED world）
// S3：F2 锚定规则 + domsig + customEvent 嵌入。S5：Settle 结算机制（锚定与取证分离）。
// 结算只是"截图/全量DOM 的择时增强"，关键证据由 rrweb 事件流兜底（打断不丢信息）。
(() => {
  if (window.__journeyRecorderActive__) return; // 幂等：导航重注入/重复注入保护
  window.__journeyRecorderActive__ = true;

  const D = window.JourneyDomsig;
  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch((e) => console.warn('[JR] send failed:', e));

  /* ---------- 元素分类辅助（F2 规则） ---------- */
  const TEXT_TYPES = ['text', 'email', 'search', 'tel', 'url', 'number', 'password'];

  function tagName(el) { return String((el && el.tagName) || '').toLowerCase(); }

  function isTextLike(el) {
    const tag = tagName(el);
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const t = String(el.getAttribute('type') || 'text').toLowerCase();
    return TEXT_TYPES.indexOf(t) !== -1;
  }

  function inputKind(el) {
    const tag = tagName(el);
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'input') {
      const t = String(el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'password') return 'password';
      return 'text';
    }
    return 'other';
  }

  const CLICKABLE_SEL =
    'button, a, input, select, textarea, label, summary, ' +
    '[role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [onclick]';

  function isClickable(el) {
    try {
      if (el.closest && el.closest(CLICKABLE_SEL)) return true;
      if (window.getComputedStyle) {
        let node = el;
        for (let i = 0; node && i < 3; i++, node = node.parentElement) {
          if (window.getComputedStyle(node).cursor === 'pointer') return true;
        }
      }
    } catch (e) { /* 判定失败按可点击处理，宁可多记 */ }
    return true;
  }

  function realTarget(e) {
    try {
      if (e.composedPath && e.composedPath()[0]) return e.composedPath()[0];
    } catch (err) { /* */ }
    return e.target;
  }

  /* ================================================================
     S5：Settle 结算机制（每 Step 一个会话，三信号齐才取证）
     ================================================================ */
  const SETTLE_DOM_QUIET_MS = 300;   // ① DOM 静默窗
  const SETTLE_ROUTE_QUIET_MS = 300; // ③ 路由静止窗
  const SETTLE_TIMEOUT_MS = 10000;   // 兜底

  // ② in-flight 网络追踪：net-hook 的 NET_START/NET_END 维护
  const pendingNets = new Map(); // reqId -> startTs

  let settle = null; // { key, stepId, startedAt, domTimer, timeoutTimer, domQuiet, lastRouteTs }
  let mutationObs = null;

  function armDomQuiet() {
    if (!settle) return;
    settle.domQuiet = false;
    clearTimeout(settle.domTimer);
    settle.domTimer = setTimeout(() => {
      if (!settle) return;
      settle.domQuiet = true;
      trySettle();
    }, SETTLE_DOM_QUIET_MS);
  }

  function trySettle() {
    if (!settle || !settle.domQuiet) return;
    // ② 网络静默：任何在飞请求都阻塞结算。
    // 2026-08-31 修复：原先按 settle.startedAt 时间窗过滤，但 NET_START 的 postMessage
    // 先于 SW 往返（startSettle）到达，慢请求 startTs < startedAt 被漏判 →
    // 慢接口/挂起接口 302ms 即 settled（路径②③验收暴露）。按 F5 时间窗语义，
    // 在飞请求天然属于当前最新 Step，故改为 pendingNets.size 判断。
    if (pendingNets.size > 0) return;
    if (Date.now() - settle.lastRouteTs < SETTLE_ROUTE_QUIET_MS) return; // ③ 路由未静止
    finishSettle('settled');
  }

  function finishSettle(tag) {
    const s = settle;
    settle = null;
    if (!s) return;
    clearTimeout(s.domTimer);
    clearTimeout(s.timeoutTimer);
    let domHtml = null;
    try { domHtml = document.documentElement.outerHTML; } catch (e) { /* 序列化失败留空 */ }
    send({
      type: 'STEP_SETTLED',
      stepKey: s.key,
      stepId: s.stepId,
      settleTag: tag, // settled | interrupted_settle | settle_timeout
      ts: Date.now(),
      signals: {
        durationMs: Date.now() - s.startedAt,
        pendingNets: pendingNets.size,
      },
      domHtml,
    });
    // S8：该页首次结算时，异步采集资源（外链 CSS/字体/图片），不阻塞 settle 取证
    maybeCollectPageResources();
  }

  /* ================================================================
     S8 资源抓取（高保真仿制）：每个页面首次结算时采集该页 CSS/字体/图片。
     与 settle 解耦——settle 的 dom_html 是即时取证，资源采集是异步 fetch，
     完成后发 PAGE_ASSETS 给 SW（按 pageKey 去重，每页一套）。
     ================================================================ */
  const collectedPages = new Set(); // 已采集的 pageKey，避免重复抓
  const fetchWithTimeout = (url, ms) => Promise.race([
    fetch(url, { credentials: 'include' }).then((r) => ({ ok: r.ok, status: r.status, blob: r.blob() })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('fetch timeout ' + url)), ms)),
  ]);

  // 把 Blob 读取成 { dataBase64 } 或 { textContent }（按 mime 分类）
  async function readBlobAs(blob, mime) {
    if (/^image\/|^font\/|woff|^application\/(font|octet-stream)/.test(mime)) {
      // 二进制 → base64
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      let b64 = '';
      for (let i = 0; i < bin.length; i += 0x8000) b64 += btoa(bin.slice(i, i + 0x8000));
      return { mime, dataBase64: b64, size: buf.length };
    }
    // 文本类 → 正文
    const text = await blob.text();
    return { mime, textContent: text, size: text.length };
  }

  // 抓单个外链资源 → 归一化为 fetched map 的一个条目（key=绝对 URL）
  async function fetchOne(absUrl) {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(absUrl, 8000);
      // fetchWithTimeout 已把 blob 转成 Promise，这里 await 取 Blob
      const blob = await (r && r.blob ? r.blob : Promise.resolve(null));
      if (!blob || !blob.size) return { url: absUrl, mime: '', dataBase64: null, textContent: null, size: 0, ok: false, ms: Date.now() - t0 };
      const mime = blob.type || mimeOfUrl(absUrl);
      const norm = await readBlobAs(blob, mime);
      const entry = { url: absUrl, mime, size: norm.size, ok: true, ms: Date.now() - t0 };
      if (norm.dataBase64 != null) entry.dataBase64 = norm.dataBase64;
      if (norm.textContent != null) entry.textContent = norm.textContent;
      return entry;
    } catch (e) {
      return { url: absUrl, mime: '', dataBase64: null, textContent: null, size: 0, ok: false, error: String(e && e.message || e), ms: Date.now() - t0 };
    }
  }

  function mimeOfUrl(url) {
    const m = String(url.split('?')[0].split('#')[0]).match(/\.([a-z0-9]+)$/i);
    const map = { css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
    return (m && map[m[1].toLowerCase()]) || '';
  }

  function absUrlStr(base, ref) {
    try { return new URL(String(ref || ''), base).href; } catch (e) { return String(ref || ''); }
  }

  // 收集页面全部资源（外链 stylesheet + css 内 url() 子资源），并行抓取
  async function collectPageResources(pageHtml) {
    const base = String(location.href);
    const fetched = {};
    const queue = [];
    const push = (u, b) => {
      const su = absUrlStr(b || base, u);
      if (su && !fetched[su] && queue.indexOf(su) === -1) queue.push(su);
    };
    // 扫描 CSS 文本中的 url() 引用（跳过 data:/blob:/# 锚点）
    const scanCssUrls = (css, b) => {
      const re = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
      let m;
      while ((m = re.exec(css)) != null) {
        const raw = String(m[2] || '').trim();
        if (/^(data:|blob:|#)/.test(raw)) continue;
        push(raw, b);
      }
    };
    // ① 外链 stylesheet + ② 内联 style 里的 url()
    document.querySelectorAll('link[rel~="stylesheet"]').forEach((ln) => {
      const href = ln.getAttribute('href');
      if (href) push(href, base);
    });
    document.querySelectorAll('style').forEach((st) => scanCssUrls(st.textContent || '', base));

    // ③ 并行抓取（上限 6），CSS 抓回后补扫其 url()
    const CONC = 6;
    let i = 0;
    const workers = Array.from({ length: Math.min(CONC, Math.max(1, queue.length)) }, async () => {
      while (i < queue.length) {
        const u = queue[i++];
        if (fetched[u]) continue;
        const r = await fetchOne(u);
        fetched[u] = r;
        if (r.ok && r.textContent != null) scanCssUrls(r.textContent, u);
      }
    });
    await Promise.all(workers);
    return { pageUrl: base, pageHtml: pageHtml || '', pageTitle: document.title || '', fetched };
  }

  // 触发点：finishSettle 后调用。若该页（按 pageKey 去重）首次结算，则异步采集资源（不阻塞 settle）
  function maybeCollectPageResources() {
    const key = absUrlStr(String(location.href), '.');
    if (collectedPages.has(key)) return;
    collectedPages.add(key);
    let domHtml = null;
    try { domHtml = document.documentElement.outerHTML; } catch (e) { /* */ }
    collectPageResources(domHtml).then((res) => {
      send({ type: 'PAGE_ASSETS', pageUrl: res.pageUrl, pageTitle: res.pageTitle, pageHtml: res.pageHtml, fetched: res.fetched });
    }).catch((e) => { console.warn('[JR] collectPageResources failed:', e); });
  }

  function startSettle(stepKey, stepId) {
    if (settle) finishSettle('interrupted_settle'); // 边界①：新锚到来，旧会话立即取证
    settle = {
      key: stepKey,
      stepId,
      startedAt: Date.now(),
      domQuiet: false,
      domTimer: null,
      lastRouteTs: 0,
      timeoutTimer: setTimeout(() => {
        if (settle) finishSettle('settle_timeout'); // 边界②：10s 兜底
      }, SETTLE_TIMEOUT_MS),
    };
    armDomQuiet();
  }

  // ① DOM 静默：全局观察，无 settle 会话时回调即刻返回（成本趋零）
  try {
    mutationObs = new MutationObserver(() => { if (settle) armDomQuiet(); });
    mutationObs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
  } catch (e) { console.warn('[JR] MutationObserver 失败（DOM 静默信号缺失）:', e); }

  // ③ 路由静止：hash 变更会伴随 DOM 重渲染，双信号互相印证
  const onRouteChange = () => {
    if (!settle) return;
    settle.lastRouteTs = Date.now();
    armDomQuiet();
  };
  window.addEventListener('hashchange', onRouteChange);
  window.addEventListener('popstate', onRouteChange);

  /* ---------- 锚点发送（元数据 + customEvent 立即嵌入；响应后启动 Settle） ---------- */
  function anchor(action, targetEl, extra) {
    const target = D ? D.describe(targetEl) : { css_path: null, semantic: tagName(targetEl), visible_text: '', tag: tagName(targetEl), aria_role: null, aria_label: null };
    try {
      if (window.rrweb && window.rrweb.record && window.rrweb.record.addCustomEvent) {
        window.rrweb.record.addCustomEvent('journey-step', {
          action,
          target_semantic: target.semantic,
        });
      }
    } catch (e) { /* 嵌入失败不影响元数据 */ }
    const payload = Object.assign({
      ts: Date.now(),
      action,
      target,
      page: { url: String(location.href), title: document.title || '' },
    }, extra || {});
    chrome.runtime.sendMessage({ type: 'STEP_ANCHORED', anchor: payload })
      .then((res) => {
        if (res && res.ok) startSettle(res.stepKey, res.stepId); // 结算挂到新 Step 上
      })
      .catch((e) => console.warn('[JR] anchor send failed:', e));
  }

  /* ---------- ① click 锚定 ---------- */
  const onClick = (e) => {
    if (e.button !== 0) return;
    const t = realTarget(e);
    if (!t || !isClickable(t)) return;
    anchor('click', t);
  };
  document.addEventListener('click', onClick, { capture: true, passive: true });

  /* ---------- ② 文本输入：逐键不记，blur/Enter 汇总（密码 ***） ---------- */
  let inputSession = null;

  const onInput = (e) => {
    const t = realTarget(e);
    if (!t || !isTextLike(t)) return;
    if (!inputSession || inputSession.el !== t) {
      inputSession = { el: t, lastCommitted: null };
    }
  };
  document.addEventListener('input', onInput, { capture: true, passive: true });

  const onFocusin = (e) => {
    const t = realTarget(e);
    if (t && isTextLike(t)) inputSession = { el: t, lastCommitted: String(t.value ?? '') };
  };
  document.addEventListener('focusin', onFocusin, { capture: true, passive: true });

  function commitInput(el) {
    if (!inputSession || inputSession.el !== el) return;
    const kind = inputKind(el);
    const finalVal = kind === 'password' ? '***' : String(el.value ?? '');
    const changed = finalVal !== inputSession.lastCommitted;
    inputSession.lastCommitted = finalVal;
    if (!changed || finalVal === '') return;
    anchor('change', el, { value: finalVal, input_type: kind });
  }

  const onKeydown = (e) => {
    if (e.key !== 'Enter') return;
    const t = realTarget(e);
    if (t && isTextLike(t)) commitInput(t);
  };
  document.addEventListener('keydown', onKeydown, { capture: true, passive: true });

  const onFocusout = (e) => {
    const t = realTarget(e);
    if (t && isTextLike(t)) commitInput(t);
  };
  document.addEventListener('focusout', onFocusout, { capture: true, passive: true });

  /* ---------- ③ select / checkbox / radio：change 即锚定 ---------- */
  const onChange = (e) => {
    const t = realTarget(e);
    if (!t) return;
    const kind = inputKind(t);
    if (kind === 'text' || kind === 'password' || kind === 'textarea') return;
    let value = '';
    if (kind === 'select') {
      const opt = t.selectedOptions && t.selectedOptions[0];
      value = opt ? opt.textContent.trim() : String(t.value ?? '');
    } else if (kind === 'checkbox' || kind === 'radio') {
      value = String(t.checked);
    } else {
      value = String(t.value ?? '');
    }
    anchor('change', t, { value, input_type: kind });
  };
  document.addEventListener('change', onChange, { capture: true, passive: true });

  /* ---------- ④ MAIN world 网络事件桥 + in-flight 追踪 ---------- */
  const onNetMsg = (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== '__journey_net__') return;
    const p = d.payload;
    if (p && p.error) {
      send({ type: 'PIPE_WARN', pipe: 'net_hook', error: p.error });
      return;
    }
    if (p && p.sub === 'start') {
      pendingNets.set(p.reqId, p.startTs);
      if (settle) { settle.domQuiet = false; armDomQuiet(); } // 请求开始 → 不再静默
      return;
    }
    if (p && p.sub === 'end') {
      pendingNets.delete(p.reqId);
      if (settle) { settle.domQuiet = false; armDomQuiet(); } // 响应可能触发渲染 → 重新等 DOM 静默
      trySettle();
      // 完整记录转发 SW
      const c = Object.assign({}, p);
      delete c.sub;
      send({ type: 'NET_EVT', call: c });
      return;
    }
    // 兼容：无 sub 的旧消息按完整记录处理
    send({ type: 'NET_EVT', call: p });
  };
  window.addEventListener('message', onNetMsg);

  /* ---------- rrweb 事件流（分片转发，S2 已通） ---------- */
  let stopRrweb = null;
  let flushTimer = null; // 声明在 try 外：JR_STOP 清理需访问（块级作用域踩坑，2026-08-29 修复）
  try {
    if (!window.rrweb) throw new Error('rrweb 库未注入（ISOLATED）');
    const buffer = [];
    let lastFlush = Date.now();
    const flush = () => {
      if (!buffer.length) return;
      const events = buffer.splice(0, buffer.length);
      lastFlush = Date.now();
      send({ type: 'RR_CHUNK', events, chunkTs: lastFlush });
    };
    const maybeFlush = () => {
      if (buffer.length >= 200) { flush(); return; }
      if (!flushTimer) {
        flushTimer = setInterval(() => {
          if (Date.now() - lastFlush >= 2000) flush();
        }, 500);
      }
    };
    stopRrweb = window.rrweb.record({
      emit: (event) => { buffer.push(event); maybeFlush(); },
      maskInputOptions: { password: true },
    });
    console.log('[JR] rrweb started (isolated world)');
  } catch (e) {
    console.warn('[JR] rrweb 启动失败 → replay_stream_failed:', e);
    send({ type: 'PIPE_WARN', pipe: 'replay_stream', error: String((e && e.message) || e) });
  }

  /* ---------- 手动锚点（S7）：popup 触发，纯解说节点，产物结构与其他 Step 一致 ---------- */
  const runtimeListener = (msg) => {
    if (!msg) return;
    if (msg.type === 'JR_MANUAL_ANCHOR') {
      // 命名由 SW 侧 naming 处理（action=manual → NNN_manual_[页面标题]）
      anchor('manual', document.body, { manual: true });
      try { sendResponse({ ok: true, stepCount: null }); } catch (e) { /* popup 可能先关 */ }
      return;
    }
    if (msg.type === 'JR_TAB_OPENED') {
      // S7.1 补强：新标签页纳入录制并注入完成后，SW 触发 → 补一次「新 tab 初始画面」快照。
      // 走统一 anchor 通道（自动获得 Settle/落库/customEvent/截图）；action=tab_open → NNN_tab_open[页面标题]。
      // 页面刚注入可能尚未完全就绪，延迟一点确保 DOM 可序列化且 Settle 能捕捉初始态。
      setTimeout(() => {
        try { anchor('tab_open', document.body, { auto: true }); } catch (e) { /* */ }
      }, 300);
      try { sendResponse({ ok: true }); } catch (e) { /* */ }
      return;
    }
    if (msg.type !== 'JR_STOP') return;
    try { if (settle) finishSettle('interrupted_settle'); } catch (e) { /* */ }
    try { if (stopRrweb) stopRrweb(); } catch (e) { /* 忽略二次 stop */ }
    document.removeEventListener('click', onClick, { capture: true });
    document.removeEventListener('input', onInput, { capture: true });
    document.removeEventListener('focusin', onFocusin, { capture: true });
    document.removeEventListener('keydown', onKeydown, { capture: true });
    document.removeEventListener('focusout', onFocusout, { capture: true });
    document.removeEventListener('change', onChange, { capture: true });
    window.removeEventListener('message', onNetMsg);
    window.removeEventListener('hashchange', onRouteChange);
    window.removeEventListener('popstate', onRouteChange);
    chrome.runtime.onMessage.removeListener(runtimeListener);
    if (mutationObs) { try { mutationObs.disconnect(); } catch (e) { /* */ } }
    clearInterval(flushTimer);
    pendingNets.clear();
    delete window.__journeyRecorderActive__;
    console.log('[JR] recorder stopped & cleaned');
  };
  chrome.runtime.onMessage.addListener(runtimeListener);

  console.log('[JR] recorder injected (S5 settle)');
})();
