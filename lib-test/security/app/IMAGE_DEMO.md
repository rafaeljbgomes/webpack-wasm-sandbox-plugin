# Image.js video demonstration

This page demonstrates the developer workflow from a normal Webpack import to an explicitly configured sandbox. The application entry (`src/image-demo.js`) and the command stay unchanged; only the Webpack configuration changes.

## Final isolated build

Install the isolated evaluation application's dependencies once from the repository root:

```powershell
npm install --prefix .\lib-test\security\app
```

Build and serve the final isolated state:

```powershell
npx webpack --config webpack.image-demo.config.cjs
python -m http.server 9000
```

Open `http://localhost:9000/security-image-demo.html` and the browser console. The image is transformed, the host canary remains, and the patched attack key is absent because `localStorage` is not in `sandbox-configs/image-demo.js`.

## Native starting point for the recording

Start the recording with `webpack.image-demo.config.cjs` in this state:

1. Remove the `WebpackSandboxPlugin` import.
2. Remove the `WebpackSandboxPlugin` and `sandbox.config.js` replacement entries from `plugins`.
3. Change `__IMAGE_DEMO_MODE__` from `"isolated"` to `"native"`.

Run the same command:

```powershell
npx webpack --config webpack.image-demo.config.cjs
```

This is an ordinary Webpack build: the `image-js` import resolves directly to the package, so its harmless evaluation patch writes `__security_image_attack__` to the browser's `localStorage` while the page still displays the processed image.

Then add back the final configuration shown in this repository and run the same command again. The plugin reads `sandbox-configs/image-demo.js`, generates the proxy and isolated bundle, and redirects the unchanged bare import. The allowed `Intl`, `TextEncoder`, and `TextDecoder` capabilities retain the image operation; the missing `localStorage` capability blocks only the patched write.

The patch is a controlled simulation for the dissertation evaluation. It does not represent a claim of a vulnerability in Image.js.
