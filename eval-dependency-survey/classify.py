"""Classifies the direct dependencies of the five applications.

N  not browser runtime: Node/CLI/server packages, build plugins, type-only
   packages, React Native and Electron packages (some manifests are shared
   with mobile or desktop clients).
U  UI, framework, DOM, styling, fonts or icons: renders to or manipulates the
   DOM, or hooks into a framework's component or state model.
P  polyfill, shim or runtime helper: patches or stands in for globals, which a
   separate context cannot do for the page.
I  bound to a host platform API or I/O: network clients and SDKs, storage,
   media, workers, WebAssembly/GPU, analytics, page or browser state.
C  candidate: data in, data out through a small API, with at most a few
   granted host APIs (e.g. Intl, crypto.getRandomValues); `heavy` marks
   candidates whose per-call work is large (crypto, compression, image or
   search indexing), where Table 8 shows the largest absolute cost.
Assignments are by package purpose (registry description and documentation).
"""
import json, os, re, collections, csv
here = os.path.dirname(__file__)
N = """@electron/fuses @koa/multer @koa/router koa koa-bodyparser koa-json multer commander inquirer ts-node open proper-lockfile
https-proxy-agent node-fetch optional-require bufferutil utf-8-validate jsdom lowdb @svgr/webpack monaco-editor-webpack-plugin null-loader
vite-tsconfig-paths @types/color-hash @types/react-is @types/turndown @mattermost/types @mattermost/desktop-api @redux-devtools/extension
@amplitude/analytics-react-native @giphy/react-native-sdk @sayem314/react-native-keep-awake @react-native-google-signin/google-signin
@react-native-async-storage/async-storage @react-native-clipboard/clipboard @react-native-community/netinfo @react-native-community/slider
@bitwarden/desktop-napi chalk form-data @fontsource/noto-sans""".split()
P = """core-js regenerator-runtime whatwg-fetch intersection-observer buffer process util stream-browserify crypto-browserify abortcontroller-polyfill
proxy-polyfill text-encoding fast-text-encoding native-promise-only promise.withresolvers element-closest-polyfill classlist.js focus-visible
css-vars-ponyfill resize-observer-polyfill seamless-scroll-polyfill webcomponents.js image-capture zone.js abab smooth-scroll-into-view-if-needed""".split()
I = """axios @nextcloud/axios @mattermost/client @jellyfin/sdk jellyfin-apiclient @microsoft/signalr @microsoft/signalr-protocol-msgpack
@stomp/stompjs dropbox @microsoft/microsoft-graph-client @giphy/js-fetch-api @amplitude/analytics-browser amplitude-js idb-keyval localforage
localforage-observable hls.js flv.js @tensorflow/tfjs-core @tensorflow/tfjs-backend-wasm @tensorflow/tfjs-backend-webgl @tensorflow/tfjs-backend-webgpu
@tensorflow/tfjs-converter @tensorflow-models/body-segmentation @mediapipe/selfie_segmentation @jitsi/rnnoise-wasm @jellyfin/libass-wasm libarchive.js
@vladmandic/human @vladmandic/human-models lib-jitsi-meet oauth4webapi @simplewebauthn/browser braintree-web-drop-in pdfjs-dist epubjs web-vitals
wasm-check screenfull clipboard-copy @nextcloud/auth @nextcloud/initial-state @nextcloud/capabilities @nextcloud/browser-storage @nextcloud/event-bus
@nextcloud/files @nextcloud/sharing @nextcloud/password-confirmation @nextcloud/router @nextcloud/viewer @nextcloud/l10n @nextcloud/logger
i18next-http-backend i18next-browser-languagedetector @matrix-org/olm @bitwarden/sdk-internal @bitwarden/commercial-sdk-internal libbitsub
@jitsi/js-utils @jitsi/logger redux-persist history qrcode-parser webdav debounce p-queue rebound""".split()
C_LIGHT = """date-fns dayjs moment moment-timezone luxon lodash lodash-es marked markdown-it highlight.js lowlight katex @braintree/sanitize-url
escape-html emoji-regex grapheme-splitter i18n-iso-countries country-list libphonenumber-js punycode semver uuid ipaddr.js tldts jwt-decode
base64-js serialize-error fast-deep-equal shallow-equals color tinycolor2 color-contrast-checker color-hash windows-iana timezones.json
@bufbuild/protobuf @xmldom/xmldom exif2css browserslist-useragent-regexp ts-ebml classnames clsx @nextcloud/paths i18next
@guyplusplus/turndown-plugin-gfm qrcode""".split()
C_HEAVY = """node-forge fflate jszip pixelmatch blurhash zxcvbn lunr flexsearch papaparse big-integer js-sha512 js-md5""".split()
def cat(n):
    if n in N or n.startswith(("@types/", "react-native", "@react-native", "@react-navigation/", "@fontsource/")): return "N"
    if n in P: return "P"
    if n in I: return "I"
    if n in C_HEAVY: return "C-heavy"
    if n in C_LIGHT: return "C"
    return "U"  # remaining: UI, framework, DOM, styling, icons (listed in the CSV for review)
c = json.load(open(os.path.join(here, "closures.json")))
rows = []; summary = {}
for app, d in c.items():
    cnt = collections.Counter(cat(n) for n in d["direct"])
    summary[app] = {"direct": len(d["direct"]), "closure": d["closure"], **cnt, "sept2025": sorted(d["sept2025"])}
    for n in d["direct"]: rows.append({"app": app, "package": n, "category": cat(n)})
with open(os.path.join(here, "direct-dependencies.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["app", "package", "category"]); w.writeheader(); w.writerows(rows)
json.dump(summary, open(os.path.join(here, "summary.json"), "w"), indent=1)
for a, s in summary.items():
    rt = s["direct"] - s.get("N", 0)
    cand = s.get("C", 0) + s.get("C-heavy", 0)
    print(f"{a:18} direct={s['direct']:3} browser-runtime={rt:3} U={s.get('U',0):3} P={s.get('P',0):2} I={s.get('I',0):3} C={s.get('C',0):2} C-heavy={s.get('C-heavy',0):2} candidates={cand:2} ({100*cand/rt:.0f}%)")
U = sorted({r['package'] for r in rows if r['category'] == 'U'})
print(len(U), "U:", " ".join(U))
