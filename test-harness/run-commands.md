# Test harness performance commands

These commands run the libraries' Node-side unit tests through `performance-harness/run-command.mjs`.

The measured `wall_ms` is the elapsed time of the wrapped test command. Use the same `--iterations` and `--warmup` values for native and sandbox runs when comparing overhead.

Before sandbox runs, make sure the target library is enabled in `.sandbox/sandbox.config.js` and its proxy has been generated with the normal bundle-generation workflow.

## date-fns

Framework: Vitest.

Note: `test-harness/date-fns/vitest.config.ts` is currently native. For sandbox mode, the config needs to redirect `./index.ts` to `../../.sandbox/date-fns-proxy.js` before running the sandbox command.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library date-fns `
  --workload-id unit-tests `
  --label "date-fns sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\date-fns && npx vitest run --config .\vitest.config.ts"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library date-fns `
  --workload-id unit-tests `
  --label "date-fns native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\date-fns && npx vitest run --config .\vitest.config.ts"
```

## dayjs

Framework: Jest.

Note: `test-harness/dayjs/package.json` currently maps Day.js imports to `.sandbox/dayjs-jest-shim.js`. Keep that mapper for sandbox mode. For native mode, remove or replace the sandbox `moduleNameMapper` entries before running the native command.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library dayjs `
  --workload-id unit-tests `
  --label "dayjs sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\dayjs && npx jest --coverage=false"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library dayjs `
  --workload-id unit-tests `
  --label "dayjs native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\dayjs && npx jest --coverage=false"
```

## image-js

Framework: Vitest.

Note: `test-harness/image-js/vitest.config.ts` currently includes a sandbox redirect plugin and an `image-js` alias to the sandbox proxy. Keep that config for sandbox mode. For native mode, remove the sandbox plugin and `image-js` proxy alias before running the native command.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library image-js `
  --workload-id unit-tests `
  --label "image-js sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\image-js && npx vitest run --config .\vitest.config.ts"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library image-js `
  --workload-id unit-tests `
  --label "image-js native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\image-js && npx vitest run --config .\vitest.config.ts"
```

## lodash

Framework: QUnit through Node scripts.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library lodash `
  --workload-id unit-tests `
  --label "lodash sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\lodash && npm run test:sandbox && npm run test:sandbox-fp"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library lodash `
  --workload-id unit-tests `
  --label "lodash native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\lodash && npm run test:main && npm run test:fp"
```

## luxon

Framework: Jest.

Note: use `jest.config.js` for sandbox mode and `jest-original.config.js` for native mode. The explicit `node --experimental-vm-modules` form avoids overwriting the `NODE_OPTIONS` value injected by the performance harness.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library luxon `
  --workload-id unit-tests `
  --label "luxon sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\luxon && node --experimental-vm-modules .\node_modules\jest\bin\jest.js --config .\jest.config.js"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library luxon `
  --workload-id unit-tests `
  --label "luxon native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\luxon && node --experimental-vm-modules .\node_modules\jest\bin\jest.js --config .\jest-original.config.js"
```

## marked

Framework: Node test runner.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library marked `
  --workload-id unit-tests `
  --label "marked sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- node --import .\test-sandbox-redirect\register-sandbox.mjs --test --test-reporter=spec "test-harness\marked\test\unit\*.test.js"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library marked `
  --workload-id unit-tests `
  --label "marked native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- node --test --test-reporter=spec "test-harness\marked\test\unit\*.test.js"
```

## mime

Framework: Node test runner.

Note: `npm test` also runs `test/exports_test.sh`, which is not a Windows-native Node unit-test command. The commands below measure the Node test files.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library mime `
  --workload-id unit-tests `
  --label "mime sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\mime && node --import ..\..\test-sandbox-redirect\register-sandbox.mjs --test"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library mime `
  --workload-id unit-tests `
  --label "mime native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\mime && node --test"
```

## mnemonist

Framework: Mocha.

Note: the current Mnemonist tests are CommonJS and require local source files directly. The current `test-sandbox-redirect` ESM loader does not redirect those `require()` calls, and `mnemonist` is currently commented out in `.sandbox/sandbox.config.js`. A real sandbox measurement needs a CommonJS preload/require hook or a Mocha/Vitest config that redirects those source requires to a generated `mnemonist` proxy.

Sandbox command shape after adding that redirect:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library mnemonist `
  --workload-id unit-tests `
  --label "mnemonist sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\mnemonist && npx mocha"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library mnemonist `
  --workload-id unit-tests `
  --label "mnemonist native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\mnemonist && npx mocha"
```

## strip-ansi

Framework: AVA.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library strip-ansi `
  --workload-id unit-tests `
  --label "strip-ansi sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- node --import .\test-sandbox-redirect\register-sandbox.mjs .\node_modules\ava\entrypoints\cli.mjs .\test-harness\strip-ansi\test-original.js
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library strip-ansi `
  --workload-id unit-tests `
  --label "strip-ansi native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- node .\node_modules\ava\entrypoints\cli.mjs .\test-harness\strip-ansi\test-original.js
```

## tweetnacl-js

Framework: tape.

Note: the current TweetNaCl tests are CommonJS and load the implementation through `require('../' + (process.env.NACL_SRC || 'nacl.min.js'))`. The current ESM sandbox loader cannot redirect that `require()` path to the ESM sandbox proxy. A real sandbox measurement needs a CommonJS-compatible shim/preload or a test config change that makes `NACL_SRC` resolve to a CommonJS bridge for `.sandbox/proxys/tweetnacl-proxy.js`.

Sandbox command shape after adding that redirect:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library tweetnacl `
  --workload-id unit-tests `
  --label "tweetnacl sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\tweetnacl-js && npm run test-node"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library tweetnacl `
  --workload-id unit-tests `
  --label "tweetnacl native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\tweetnacl-js && npm run test-node"
```

## yup

Framework: Vitest.

Note: `test-harness/yup/vitest.config.ts` currently aliases `../src` to `../../.sandbox/proxys/yup-proxy.js`. Keep that alias for sandbox mode. For native mode, remove the sandbox alias before running the native command.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library yup `
  --workload-id unit-tests `
  --label "yup sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\yup && yarn vitest run --config .\vitest.config.ts"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library yup `
  --workload-id unit-tests `
  --label "yup native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\yup && yarn vitest run --config .\vitest.config.ts"
```

## zod

Framework: Vitest.

Note: use `vitest-sandbox.config.ts` for sandbox mode and `vitest.config.ts` for native mode. If running package-local configs under `packages/zod`, keep the same native-vs-sandbox alias decision there as well.

Sandbox:

```powershell
node .\performance-harness\run-command.mjs `
  --mode sandbox `
  --library zod `
  --workload-id unit-tests `
  --label "zod sandbox unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\zod && pnpm vitest run --config .\vitest-sandbox.config.ts packages\zod\src\v4\classic\tests"
```

Native:

```powershell
node .\performance-harness\run-command.mjs `
  --mode native `
  --library zod `
  --workload-id unit-tests `
  --label "zod native unit tests" `
  --iterations 5 `
  --warmup 1 `
  -- cmd.exe /d /s /c "cd /d .\test-harness\zod && pnpm vitest run --config .\vitest.config.ts packages\zod\src\v4\classic\tests"
```
