// SCHWAB SIGN-IN HAND-OFF (2026-11-12). Schwab's OAuth redirect lands here with ?code=… (a ONE-TIME code, valid about
// 30 s). This page cannot renew anything itself: the code has to be exchanged by the server, which holds the client
// secret. So it offers two ways to use the code, because a code can only be used once:
//   - UPDATE SERVER TOKEN: open the server's /control page with the code in the URL hash (a hash is never sent to a
//     server or written to a log). The control page holds the control token and posts the code to
//     /api/v1/candle-spread/control/schwab-token, and the server stores the new token and restarts.
//   - COPY URL: for scripts/renew-schwab-token.js "<url>" on the dev machine, which updates .env and, with --push,
//     the server too.
// Loaded after schwab-api.js, so PROXY_URL already points at the right backend (localhost or CloudFront).
(function () {
  const code = new URLSearchParams(window.location.search).get('code');
  if (!code) return;
  function render() {
    const bar = document.createElement('div');
    bar.id = 'schwab-code-handoff';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1f3a5f;color:#fff;'
      + 'font:14px system-ui,sans-serif;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.3)';
    const msg = document.createElement('span');
    msg.textContent = 'Schwab sign-in code received. It expires in about 30 seconds and works once.';
    const send = document.createElement('button');
    send.textContent = 'Update server token';
    send.style.cssText = 'font-weight:600;padding:6px 12px;cursor:pointer';
    send.onclick = () => { window.location.href = `${PROXY_URL}/control#schwab-code=${encodeURIComponent(code)}`; };
    const copy = document.createElement('button');
    copy.textContent = 'Copy URL for the local script';
    copy.style.cssText = 'padding:6px 12px;cursor:pointer';
    copy.onclick = () => {
      (navigator.clipboard ? navigator.clipboard.writeText(window.location.href) : Promise.reject(new Error('no clipboard')))
        .then(() => { copy.textContent = 'Copied'; })
        .catch(() => { window.prompt('Copy this URL:', window.location.href); });
    };
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'dismiss';
    close.style.cssText = 'margin-left:auto;padding:2px 8px;cursor:pointer';
    close.onclick = () => bar.remove();
    bar.append(msg, send, copy, close);
    document.body.appendChild(bar);
  }
  if (document.body) render(); else document.addEventListener('DOMContentLoaded', render);
})();
