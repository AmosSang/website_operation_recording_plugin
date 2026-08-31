// Journey Recorder - MAIN world 网络钩子（决策 D2：只有 MAIN world 能截到页面自己的 fetch/XHR）
// S4：捕获 method/url/status/耗时/请求头/请求体/响应体，**就地脱敏后**才 postMessage 桥回
// ISOLATED 层（敏感原始值不过页面消息总线）。全链 try/catch：hook 失败 → net_hook_failed 降级。
// 注意：sanitizer 以 window.JourneySanitizer 挂载于 MAIN world（页面可见，前缀命名空间防冲突）。
(() => {
  try {
    if (window.__journeyNetHooked__) return;
    window.__journeyNetHooked__ = true;

    const emit = (payload) => {
      try { window.postMessage({ source: '__journey_net__', payload }, '*'); } catch (e) { /* 桥断则弃 */ }
    };
    const fail = (err) => {
      try { window.postMessage({ source: '__journey_net__', payload: { error: String(err) } }, '*'); } catch (e) { /* */ }
    };

    const S = window.JourneySanitizer;
    const mask = (evt) => {
      if (S && S.maskNetEvent) { try { return S.maskNetEvent(evt); } catch (e) { fail('sanitizer: ' + e); } }
      // 降级：sanitizer 缺失时只发时序与 URL 骨架（不带任何头与体），显著告警
      return {
        kind: evt.kind, method: evt.method, url: String(evt.url || '').split('?')[0],
        status: evt.status, startTs: evt.startTs, endTs: evt.endTs,
        reqHeaders: {}, reqBody: '[sanitizer_missing]', resBody: '[sanitizer_missing]',
        sanitized_lite: true,
      };
    };

    // 归一化头容器：Headers / 数组 / 普通对象 → [name, value][]
    function headerEntries(h) {
      if (!h) return [];
      if (typeof h.forEach === 'function') { const a = []; h.forEach((v, k) => a.push([k, v])); return a; }
      if (Array.isArray(h)) return h.map((p) => [p[0], p[1]]);
      return Object.keys(h).map((k) => [k, h[k]]);
    }

    function findContentType(h) {
      for (const p of headerEntries(h)) {
        if (String(p[0]).toLowerCase() === 'content-type') return String(p[1]);
      }
      return '';
    }

    // 请求体文本化：string / URLSearchParams 可读；FormData/Blob 等只标类型（不展开，可能含文件）
    function bodyToText(body, headers) {
      try {
        if (body == null) return { text: null, ct: findContentType(headers) };
        if (typeof body === 'string') return { text: body, ct: findContentType(headers) };
        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
          return { text: body.toString(), ct: findContentType(headers) || 'application/x-www-form-urlencoded' };
        }
        const kind = (typeof FormData !== 'undefined' && body instanceof FormData && 'FormData') ||
                     (typeof Blob !== 'undefined' && body instanceof Blob && 'Blob') ||
                     (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) && 'ArrayBuffer') ||
                     (body && body.constructor && body.constructor.name) || 'unknown';
        return { text: '[non-text body: ' + kind + ']', ct: findContentType(headers) };
      } catch (e) { return { text: '[body read error]', ct: '' }; }
    }

    // 响应体：文本类 MIME 才读 clone；二进制只标类型（避开大文件/图片内存开销）
    const TEXTY_RE = /json|text|html|xml|javascript|x-www-form-urlencoded/i;
    function readResBody(res, cb) {
      try {
        let ct = '';
        try { ct = res.headers ? (res.headers.get('content-type') || '') : ''; } catch (e) { /* */ }
        if (!TEXTY_RE.test(ct)) { cb(null, '[binary: ' + (ct || 'unknown') + ']', ct); return; }
        res.clone().text().then(
          (t) => cb(null, t, ct),
          (e) => cb(e, null, ct)
        );
      } catch (e) { cb(e, null, ''); }
    }

    /* ---- fetch hook ---- */
    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        let fetchSeq = 0;
        window.fetch = function (input, init) {
          let url = '', method = '';
          try {
            url = typeof input === 'string' ? input : (input && input.url) || String(input);
            method = (init && init.method) || (input && input.method) || 'GET';
          } catch (e) { /* 解析失败不阻塞请求 */ }
          const startTs = Date.now();
          const reqId = 'f' + (++fetchSeq);
          try { emit({ sub: 'start', reqId, startTs }); } catch (e) { /* */ }
          const reqHeaders = headerEntries((init && init.headers) || (input && input.headers));
          const bt = bodyToText((init && init.body) || null, init && init.headers);
          const p = origFetch.apply(this, arguments);
          try {
            p.then(
              (res) => {
                const base = {
                  kind: 'fetch', method: String(method).toUpperCase(), url,
                  status: res.status, startTs, endTs: Date.now(),
                  reqHeaders, reqBody: bt.text, reqContentType: bt.ct,
                };
                readResBody(res, (err, text, ct) => {
                  try {
                    emit(Object.assign(mask(Object.assign(base, {
                      resBody: err ? '[res body read error]' : text,
                      resContentType: ct,
                    })), { sub: 'end', reqId }));
                  } catch (e) { fail('emit: ' + e); }
                });
              },
              (err) => {
                try {
                  emit(Object.assign(mask({
                    kind: 'fetch', method: String(method).toUpperCase(), url,
                    status: 0, startTs, endTs: Date.now(),
                    reqHeaders, reqBody: bt.text, reqContentType: bt.ct,
                    err: String((err && err.message) || err),
                  }), { sub: 'end', reqId }));
                } catch (e) { /* */ }
              }
            );
          } catch (e) { /* 上报失败不影响页面 */ }
          return p;
        };
      }
    } catch (e) { fail('fetch hook: ' + e); }

    /* ---- XHR hook ---- */
    try {
      const XHR = XMLHttpRequest.prototype;
      let xhrSeq = 0;
      const origOpen = XHR.open;
      const origSend = XHR.send;
      const origSetHeader = XHR.setRequestHeader;
      XHR.open = function (method, url) {
        try {
          this.__jr = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), headers: [] };
        } catch (e) { /* */ }
        return origOpen.apply(this, arguments);
      };
      XHR.setRequestHeader = function (name, value) {
        try { if (this.__jr) this.__jr.headers.push([String(name), String(value)]); } catch (e) { /* */ }
        return origSetHeader.apply(this, arguments);
      };
      XHR.send = function (body) {
        try {
          const rec = this.__jr || { method: 'GET', url: '', headers: [] };
          rec.startTs = Date.now();
          rec.reqId = 'x' + (++xhrSeq);
          try { emit({ sub: 'start', reqId: rec.reqId, startTs: rec.startTs }); } catch (e) { /* */ }
          const bt = bodyToText(body ?? null, rec.headers);
          rec.reqBody = bt.text;
          this.addEventListener('loadend', () => {
            try {
              let resText = null, ct = '';
              try {
                ct = this.getResponseHeader('content-type') || '';
                if (TEXTY_RE.test(ct) && (this.responseType === '' || this.responseType === 'text')) {
                  resText = this.responseText;
                } else if (this.responseType !== '' && this.responseType !== 'text') {
                  resText = '[binary: ' + (ct || this.responseType) + ']';
                }
              } catch (e) { resText = '[res body read error]'; }
              emit(Object.assign(mask({
                kind: 'xhr', method: rec.method, url: rec.url,
                status: this.status, startTs: rec.startTs, endTs: Date.now(),
                reqHeaders: rec.headers, reqBody: rec.reqBody, reqContentType: bt.ct,
                resBody: resText, resContentType: ct,
              }), { sub: 'end', reqId: rec.reqId }));
            } catch (e) { fail('xhr emit: ' + e); }
          });
        } catch (e) { /* */ }
        return origSend.apply(this, arguments);
      };
    } catch (e) { fail('xhr hook: ' + e); }
  } catch (e) {
    try { window.postMessage({ source: '__journey_net__', payload: { error: String(e) } }, '*'); } catch (_) { /* */ }
  }
})();
