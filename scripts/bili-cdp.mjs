#!/usr/bin/env node
/**
 * 零依赖 Chrome DevTools Protocol 驱动器
 * 用法:
 *   node bili-cdp.mjs launch [url]    启动独立 Chrome(远程调试 9333) 并打开 url
 *   node bili-cdp.mjs status          查看调试端口与页面列表
 *   node bili-cdp.mjs nav <url>       当前页跳转
 *   node bili-cdp.mjs url             打印当前 url / title
 *   node bili-cdp.mjs text [maxLen]   打印 body.innerText
 *   node bili-cdp.mjs shot <file.png> 截图当前视口
 *   node bili-cdp.mjs eval <file.js>  在当前页执行 JS，打印返回值(JSON)
 *   node bili-cdp.mjs close           关闭本驱动启动的浏览器
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = process.env.CDP_PROFILE || path.join(__dirname, '.bili-chrome-profile');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HEADLESS = process.env.HEADLESS === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'GET' });
  if (!r.ok) throw new Error(`http ${r.status} for ${p}`);
  return r.json();
}

async function isUp() {
  try {
    const v = await httpJson('/json/version');
    return v && v.webSocketDebuggerUrl ? v : null;
  } catch {
    return null;
  }
}

async function launch(url) {
  let v = await isUp();
  if (!v) {
    fs.mkdirSync(PROFILE, { recursive: true });
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,OptimizationHints',
      '--window-size=1440,960',
      'about:blank',
    ];
    if (HEADLESS) args.unshift('--headless=new');
    const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      v = await isUp();
      if (v) break;
    }
    if (!v) throw new Error(`Chrome 未暴露调试端口 ${PORT}（可能无桌面会话，可设 HEADLESS=1 重试）`);
  }
  console.log(`browser: ${v.Browser}  port=${PORT}`);
  if (url) {
    await withPage(async (send) => {
      await send('Page.enable');
      await send('Page.navigate', { url });
      await sleep(6000);
    });
    console.log('navigated:', url);
  }
}

async function status() {
  const v = await isUp();
  if (!v) {
    console.log('NOT RUNNING');
    return;
  }
  const list = await httpJson('/json/list');
  console.log(`browser: ${v.Browser}`);
  for (const t of list) {
    if (t.type === 'page') console.log(`  [page] ${t.title} :: ${t.url}`);
  }
}

async function withPage(fn) {
  const list = await httpJson('/json/list');
  let pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!pages.length) throw new Error('没有可用的 page target');
  const MATCH = process.env.CDP_TARGET_MATCH || '';
  const LAST = process.env.CDP_TARGET_LAST === '1';
  if (MATCH) pages = pages.filter((p) => p.url.includes(MATCH));
  if (!pages.length) throw new Error('没有匹配的 page target: ' + MATCH);
  const target = LAST ? pages[pages.length - 1] : pages[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await fn(send);
  } finally {
    try { ws.close(); } catch {}
  }
}

async function evaluate(expr) {
  return withPage(async (send) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  });
}

const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv.slice(3);
let lastPos = { x: 700, y: 400 };

try {
  switch (cmd) {
    case 'launch':
      await launch(arg);
      break;
    case 'status':
      await status();
      break;
    case 'nav':
      if (!arg) throw new Error('需要 url');
      await withPage(async (send) => {
        await send('Page.enable');
        await send('Page.navigate', { url: arg });
        await sleep(6000);
      });
      console.log('navigated:', arg);
      break;
    case 'url': {
      const info = await evaluate('({url: location.href, title: document.title, ready: document.readyState})');
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case 'text': {
      const max = Number(arg || 6000);
      const t = await evaluate('document.body ? document.body.innerText : ""');
      console.log(String(t || '').slice(0, max));
      break;
    }
    case 'shot': {
      if (!arg) throw new Error('需要输出文件');
      const out = path.isAbsolute(arg) ? arg : path.join(__dirname, arg);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await withPage(async (send) => {
        await send('Page.enable');
        return await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      });
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log('saved:', out);
      break;
    }
    case 'eval': {
      if (!arg) throw new Error('需要 js 文件');
      const file = path.isAbsolute(arg) ? arg : path.join(__dirname, arg);
      const src = fs.readFileSync(file, 'utf8');
      const val = await evaluate(src);
      console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
      break;
    }
    case 'click': {
      const [x, y] = rest.slice(0, 2).map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要 x y');
      const steps = Number(rest[2] || 8);
      await withPage(async (send) => {
        const sx = lastPos.x;
        const sy = lastPos.y;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: sx + (x - sx) * t + (Math.random() - 0.5) * 2.5,
            y: sy + (y - sy) * t + (Math.random() - 0.5) * 2.5,
          });
          await sleep(25 + Math.random() * 35);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleep(90);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(70);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      });
      lastPos = { x, y };
      console.log('clicked', x, y);
      break;
    }
    case 'type': {
      if (!arg) throw new Error('需要文本');
      await withPage(async (send) => {
        await send('Input.insertText', { text: arg });
      });
      console.log('typed', arg.length, 'chars');
      break;
    }
    case 'shotclip': {
      const [x, y, w, h] = rest.slice(0, 4).map(Number);
      const outArg = rest[4];
      const scale = Number(rest[5] || 2);
      if (!outArg) throw new Error('需要输出文件');
      const out = path.isAbsolute(outArg) ? outArg : path.join(__dirname, outArg);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await withPage(async (send) => {
        await send('Page.enable');
        return await send('Page.captureScreenshot', {
          format: 'png',
          clip: { x, y, width: w, height: h, scale },
        });
      });
      fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      console.log('saved:', out, `clip=${x},${y},${w},${h} scale=${scale}`);
      break;
    }
    case 'newtab': {
      if (!arg) throw new Error('需要 url');
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(arg)}`, { method: 'PUT' });
      const j = await r.json();
      console.log('new tab:', j.id, j.url);
      await sleep(5000);
      break;
    }
    case 'hoverscan': {
      const names = ['推广', '报表', '工具', '资产', '账户', '财务'];
      const res = await withPage(async (send) => {
        const expr =
          '(() => { const names = ' + JSON.stringify(names) + ';' +
          ' return names.map(n => { const el = [...document.querySelectorAll("*")].find(e => e.children.length===0 && (e.textContent||"").trim()===n && e.offsetParent!==null);' +
          ' if (!el) return null; const r = el.getBoundingClientRect(); return {n, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; }); })()';
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
        const list = (r.result.value || []).filter(Boolean);
        const out = [];
        for (const item of list) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: item.x, y: item.y });
          await sleep(1000);
          const q =
            '(() => { const els = [...document.querySelectorAll("[class*=dropdown],[class*=menu],[role=menu],[class*=popover]")]' +
            '.filter(e => e.offsetParent !== null && (e.innerText||"").trim() && e.getBoundingClientRect().height > 10 && e.getBoundingClientRect().width > 40);' +
            ' return els.map(e => (e.innerText||"").trim().split("\\n").map(s=>s.trim()).filter(Boolean).join(" / ")).slice(0, 6); })()';
          const qr = await send('Runtime.evaluate', { expression: q, returnByValue: true });
          out.push({ nav: item.n, menus: qr.result.value });
        }
        return out;
      });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'clicktext': {
      if (!arg) throw new Error('需要文字');
      const t = arg;
      const rect = await evaluate(
        '(() => { const t = ' + JSON.stringify(t) + ';' +
        ' const inView = (e) => { const r = e.getBoundingClientRect(); return r.top >= -2 && r.bottom <= innerHeight + 2 && r.width > 4; };' +
        ' let cands = [...document.querySelectorAll("*")].filter(e => e.children.length === 0 && (e.textContent||"").trim() === t && e.offsetParent !== null);' +
        ' let pick = cands.filter(inView)[0];' +
        ' if (!pick) { const all = [...document.querySelectorAll("*")].filter(e => (e.innerText||"").trim() === t && e.offsetParent !== null)' +
        '   .sort((a,b) => { const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect(); return ra.width*ra.height - rb.width*rb.height; });' +
        '   pick = all.filter(inView)[0] || all[0]; }' +
        ' if (!pick) return null;' +
        ' const r = pick.getBoundingClientRect();' +
        ' const vis = r.top >= -2 && r.bottom <= innerHeight + 2;' +
        ' return {x: r.x + r.width/2, y: r.y + r.height/2, hit: pick.tagName + "." + String(pick.className||"").slice(0,18), w: Math.round(r.width), h: Math.round(r.height), vis}; })()'
      );
      if (!rect) throw new Error('未找到文字: ' + t);
      const x = rect.x, y = rect.y;
      if (!rect.vis) {
        await evaluate('(() => { const t = ' + JSON.stringify(t) + ';' +
          ' const all = [...document.querySelectorAll("*")].filter(e => (e.innerText||"").trim() === t && e.offsetParent !== null)' +
          '   .sort((a,b) => { const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect(); return ra.width*ra.height - rb.width*rb.height; });' +
          ' if (all[0]) { all[0].click(); return true; } return false; })()');
        console.log('clicktext(js)', t, 'rect offscreen', Math.round(x), Math.round(y));
        lastPos = { x, y };
        break;
      }
      await withPage(async (send) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleep(80);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(80);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      });
      lastPos = { x, y };
      console.log('clicktext', t, 'at', Math.round(x), Math.round(y), rect.hit, rect.w + 'x' + rect.h);
      break;
    }
    case 'fill': {
      const ph = rest[0];
      const val = rest[1] === undefined ? '' : rest[1];
      if (!ph) throw new Error('需要 placeholder 与内容');
      const found = await evaluate(
        '(() => { const el = [...document.querySelectorAll("input,textarea")].find(i => ((i.placeholder||"")+' +
        ' " " + (i.getAttribute("aria-label")||"")).includes(' + JSON.stringify(ph) + ')); if (!el) return false;' +
        ' el.focus(); el.click(); return true; })()'
      );
      if (!found) throw new Error('未找到输入框: ' + ph);
      await withPage(async (send) => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
        await sleep(100);
        await send('Input.insertText', { text: val });
      });
      console.log('filled', ph, '=>', val);
      break;
    }
    case 'hover': {
      const [hx, hy] = rest.slice(0, 2).map(Number);
      if (!Number.isFinite(hx) || !Number.isFinite(hy)) throw new Error('需要 x y');
      await withPage(async (send) => {
        for (let i = 1; i <= 6; i++) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastPos.x + (hx - lastPos.x) * i / 6, y: lastPos.y + (hy - lastPos.y) * i / 6 });
          await sleep(20);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
      });
      lastPos = { x: hx, y: hy };
      console.log('hovered', hx, hy);
      break;
    }
    case 'scroll': {
      const y = Number(arg || 0);
      await evaluate('(() => { const y = ' + JSON.stringify(y) + ';' +
        ' let n = 0;' +
        ' for (const d of document.querySelectorAll("div,main,section")) {' +
        '   if (d.scrollHeight > d.clientHeight + 50 && d.clientHeight > 200) { d.scrollTop = y; n++; }' +
        ' }' +
        ' window.scrollTo(0, y);' +
        ' return n; })()');
      await sleep(700);
      console.log('scrolled to', y);
      break;
    }
    case 'key': {
      const map = {
        Enter: { key: 'Enter', code: 'Enter', vk: 13 },
        Escape: { key: 'Escape', code: 'Escape', vk: 27 },
        Tab: { key: 'Tab', code: 'Tab', vk: 9 },
        Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
      };
      const k = map[arg];
      if (!k) throw new Error('不支持的按键: ' + arg);
      await withPage(async (send) => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
        await sleep(60);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
      });
      console.log('key', arg);
      break;
    }
    case 'reload': {
      await withPage(async (send) => {
        await send('Page.enable');
        await send('Page.reload', { ignoreCache: true });
        await sleep(4000);
      });
      console.log('reloaded');
      break;
    }
    case 'hover': {
      if (!arg) throw new Error('需要文字或 x,y');
      let x, y;
      if (/^\d+\s*,\s*\d+$/.test(arg)) {
        [x, y] = arg.split(',').map(Number);
      } else {
        const t = arg;
        const rect = await evaluate(
          '(() => { const t = ' + JSON.stringify(t) + ';' +
          ' const inView = (e) => { const r = e.getBoundingClientRect(); return r.top >= -2 && r.bottom <= innerHeight + 2 && r.width > 2; };' +
          ' let cands = [...document.querySelectorAll("*")].filter(e => (e.innerText||"").trim() === t && e.offsetParent !== null);' +
          ' let pick = cands.filter(inView)[0] || cands[0];' +
          ' if (!pick) return null; const r = pick.getBoundingClientRect();' +
          ' return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()'
        );
        if (!rect) throw new Error('未找到元素: ' + arg);
        x = rect.x; y = rect.y;
      }
      await withPage(async (send) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 3, y: y - 3 });
        await sleep(120);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleep(150);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 2, y: y + 2 });
      });
      lastPos = { x, y };
      console.log('hover', Math.round(x), Math.round(y));
      break;
    }
    case 'close':
      await withPage(async (send) => { await send('Browser.close').catch(() => {}); }).catch(() => {});
      console.log('close requested');
      break;
    default:
      console.log('usage: node bili-cdp.mjs <launch|status|nav|url|text|shot|eval|close> [arg]');
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
