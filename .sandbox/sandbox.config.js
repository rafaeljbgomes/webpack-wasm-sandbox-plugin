/**
 * Benchmark policy for the evaluated libraries and branch-exclusive workloads.
 * Workload adapters intentionally remain on feat/sandbox-benchmarking.
 */
export default {
  "strip-ansi": {
    permissions: [],
  },
  "marked": {
    permissions: [],
  },
  "image-js": {
    permissions: ["Intl", "TextEncoder", "TextDecoder"],
    workloads: {
      transform: {
        entry: "performance-harness/browser/workloads/image-js/transform-workload.js",
        exports: ["transformImage"],
      },
    },
  },
  "luxon": {
    permissions: ["Intl"],
    workloads: {
      scheduling: {
        entry: "performance-harness/browser/workloads/luxon/scheduling-workload.js",
        exports: ["scheduleMeeting"],
      },
    },
  },
  "mime": {
    permissions: [],
  },
  "tweetnacl": {
    permissions: ["crypto"],
  },
  "lodash": {
    permissions: [],
    workloads: {
      collection: {
        entry: "performance-harness/browser/workloads/lodash/collection-workload.js",
        exports: ["summarizeOrders"],
      },
    },
  },
  "zod": {
    permissions: [],
    workloads: {
      validation: {
        entry: "performance-harness/browser/workloads/zod/validation-workload.js",
        exports: ["validateOrders"],
      },
    },
  },
  "date-fns": {
    permissions: ["Intl"],
  },
  "yup": {
    permissions: [],
  },
};
