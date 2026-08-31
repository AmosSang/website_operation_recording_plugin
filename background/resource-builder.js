// Journey Recorder - 页面资源解析/内联纯函数（高保真仿制可交互原型）
// UMD 双端：浏览器挂 window.JourneyResource；node --test 直接 require。
// 覆盖：外链 <link rel=stylesheet> 提取 / 相对路径按 base URL 解析 / CSS 内联 /
//       url() 子资源（SVG/PNG/字体）引用改写 / @font-face 内联 / 按 URL 去重。
// 设计约定：不做网络抓取（抓取由 content script 带登录态做，产出 fetched map 传入）；
//           本模块只做「已抓到资源 → 内联/改写」的纯逻辑，便于单测。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JourneyResource = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 工具 ----------
  // 解析绝对 URL（带 base）。相对/协议相对(//) 都解析成绝对。
  function absUrl(base, ref) {
    try {
      return new URL(String(ref || ''), base).href;
    } catch (e) {
      return String(ref || ''); // 解析失败原样返回
    }
  }

  // 从文件名取扩展名（小写）
  function extOf(urlOrPath) {
    const m = String(urlOrPath || '').match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
    return m ? m[1].toLowerCase() : '';
  }

  // mime → 是否文本类（可内联正文）
  function isCssMime(mime) {
    return /text\/css|application\/octet-stream/.test(String(mime || ''));
  }

  // 能否安全转 data:base64（二进制/图片/字体）
  function isBinaryMime(mime) {
    return /image\/|font\/|application\/(font|wasm|octet-stream)/.test(String(mime || ''));
  }

  // ---------- ① 提取外链样式表 ----------
  // 返回 [{ href, relAbsolute }]，relAbsolute = 解析后的绝对 URL。
  function extractStylesheets(html, base) {
    const out = [];
    if (!html) return out;
    const re = /<link\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) != null) {
      const tag = m[0];
      const rel = (tag.match(/\brel\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
      const href = (tag.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1] ||
                   (tag.match(/\bhref\s*=\s*([^\s"'>]+)/i) || [])[1];
      if (rel.toLowerCase().includes('stylesheet') && href) {
        out.push({ href, relAbsolute: absUrl(base, href) });
      }
    }
    return out;
  }

  // ---------- ② HTML 里把外链 <link rel=stylesheet> 替换为内联 <style> ----------
  // fetched: { [absUrl]: { textContent } }（CSS 正文已抓取）
  // 返回 { html, used: [absUrl...], missing: [absUrl...] }
  function inlineStylesheets(html, fetched, base) {
    let out = html || '';
    const used = [];
    const missing = [];
    const re = /<link\b[^>]*>/gi;
    let m;
    // 逐个替换：匹配到 href 且在 fetched 中则替换为 <style>
    out = out.replace(re, (tag) => {
      const rel = (tag.match(/\brel\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
      if (!rel.toLowerCase().includes('stylesheet')) return tag;
      const href = (tag.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1] ||
                   (tag.match(/\bhref\s*=\s*([^\s"'>]+)/i) || [])[1];
      if (!href) return tag;
      const url = absUrl(base, href);
      const css = fetched && fetched[url] && fetched[url].textContent;
      if (css != null) {
        used.push(url);
        // style 无 media 属性时默认 all；保留原 media（若有）
        const media = (tag.match(/\bmedia\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
        const mediaAttr = media ? ` media="${media}"` : '';
        return `<style data-jr-src="${url}"${mediaAttr}><!-- inlined from ${url} -->\n${css}\n</style>`;
      } else {
        missing.push(url);
        return `<link rel="stylesheet" href="${url}"><!-- 未抓到正文，保留外链 -->`;
      }
    });
    return { html: out, used, missing };
  }

  // ---------- ③ CSS url() 引用改写 ----------
  // cssText: 原始 CSS；fetched: { [absUrl]: { mime, dataBase64?, textContent?, localPath? } }
  // 策略：
  //   - 资源已抓取且是图片/字体二进制 → 改写为 data:base64（优先，单文件自治）
  //   - 或改写为本地 assets/ 相对路径（由 exporter 决定是否落盘）
  // 返回 { css, rewritten: [{ src, url, result: 'data'|'local'|'keep'|'missing' }] }
  function rewriteCssUrls(cssText, fetched, base) {
    let css = String(cssText || '');
    const rewritten = [];
    // 匹配 url(...)，url 可带引号
    css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, quote, raw) => {
      const trimmed = String(raw || '').trim();
      // 已是 data: 或绝对 http(s) 且不在 fetched 中 → 保留
      if (/^data:/i.test(trimmed)) return whole;
      const url = absUrl(base, trimmed);
      const f = fetched && fetched[url];
      if (!f) {
        rewritten.push({ src: trimmed, url, result: 'missing' });
        return whole; // 未抓到：保持原 URL（已是绝对，本地仍可访问）
      }
      if (f.mime && isBinaryMime(f.mime) && f.dataBase64 != null) {
        rewritten.push({ src: trimmed, url, result: 'data' });
        return `url("data:${f.mime};base64,${f.dataBase64}")`;
      }
      if (f.textContent != null && isCssMime(f.mime)) {
        // 嵌套 CSS：递归改写其 url()（极少见，防御处理）
        rewritten.push({ src: trimmed, url, result: 'data' });
        return `url("data:text/css;base64,${b64(f.textContent)}")`;
      }
      if (f.localPath) {
        rewritten.push({ src: trimmed, url, result: 'local' });
        return `url("${f.localPath}")`;
      }
      rewritten.push({ src: trimmed, url, result: 'keep' });
      return whole;
    });
    return { css, rewritten };
  }

  // ---------- @font-face 内联（把 src: url(...) 改写为 data:base64 或本地路径） ----------
  // 复用 rewriteCssUrls 对整段 CSS 处理即可（@font-face 的 src url() 也是 url() 引用）。
  // 单独暴露以便特殊处理（如保留 format() 提示）。
  function inlineFontFace(cssText, fetched, base) {
    const { css } = rewriteCssUrls(cssText, fetched, base);
    return css;
  }

  // ---------- 多页去重键 ----------
  // 用「规范化的绝对 URL」作为页去重键（去掉 hash，保留 search）
  function pageKey(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href;
    } catch (e) {
      return String(url || '');
    }
  }

  // ---------- 组装单页产物 ----------
  // 输入：{ pageUrl, html, fetched }
  // 输出：{ pageHtml, cssInlinedInHtml, sheetsUsed, sheetsMissing, assetRefs }
  function buildPageAssets({ pageUrl, html, fetched }) {
    const base = pageUrl;
    // ① 外链 CSS 内联
    const inlined = inlineStylesheets(html, fetched, base);
    // ② 对已内联的 CSS 再做 url() 改写（图片/字体 → data:base64）
    //    这里对 inlined.html 里每个 <style data-jr-src> 的正文做改写
    let pageHtml = inlined.html;
    // 收集改写信息
    const assetRefs = [];
    pageHtml = pageHtml.replace(/<style data-jr-src="([^"]+)"[^>]*>([\s\S]*?)<\/style>/gi, (whole, srcUrl, cssBody) => {
      const f = fetched && fetched[srcUrl];
      const res = rewriteCssUrls(cssBody, fetched, base);
      res.rewritten.forEach((r) => assetRefs.push(r));
      return `<style data-jr-src="${srcUrl}">${res.css}</style>`;
    });
    return {
      pageUrl,
      pageHtml,
      sheetsUsed: inlined.used,
      sheetsMissing: inlined.missing,
      assetRefs,
    };
  }

  function b64(str) {
    // 文本 → base64（UTF-8 安全）
    if (typeof Buffer !== 'undefined') return Buffer.from(String(str), 'utf8').toString('base64');
    // 浏览器：用 TextEncoder + btoa
    const enc = new TextEncoder();
    const bytes = enc.encode(String(str));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  return {
    absUrl,
    extOf,
    isCssMime,
    isBinaryMime,
    extractStylesheets,
    inlineStylesheets,
    rewriteCssUrls,
    inlineFontFace,
    pageKey,
    buildPageAssets,
  };
});
