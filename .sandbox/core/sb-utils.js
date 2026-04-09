// Shared utilities with zero internal dependencies.
// Imported by forward-membrane, reverse-membrane, and custom-marshallers.

// Identifies TypedArray views (excludes DataView)
export function isTypedArrayView(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

// Matches all known engine phrasings for "this is a constructor, call it with new".
export const REQUIRES_NEW_RE =
  /requires 'new'|must be called with new|cannot be invoked without 'new'/i;
