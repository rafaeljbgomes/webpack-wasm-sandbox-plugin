// Harness shim: the tests import the built library from dist/; both modes
// load the installed mime@4.1.0 instead (redirected to the proxy in sandbox mode).
export * from 'mime';
export { default } from 'mime';
