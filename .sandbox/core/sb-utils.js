/**
 * Tests whether a value is a TypedArray view supported by the custom
 * marshaller, excluding DataView.
 *
 * @param {unknown} value Value to inspect.
 * @returns {boolean} Whether the value is a supported TypedArray view.
 */
export function isTypedArrayView(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** Constructor-only invocation messages emitted by supported host engines. */
export const REQUIRES_NEW_RE =
  /requires 'new'|must be called with new|cannot be invoked without 'new'|use the 'new' operator|cannot be called as a function/i;
