import _ from "lodash";
import { renderScenarioResult } from "./reporter.js";

const mode = __SECURITY_MODE__;
const canaryKey = "__security_canary__";
const canaryValue = "host-canary";

Object.prototype[canaryKey] = canaryValue;

try {
  const hostCanaryBefore = Object.prototype[canaryKey];
  const unsetReturned = _.unset(
    {},
    ["constructor", "prototype", canaryKey],
  );
  const hostCanaryAfter = Object.prototype[canaryKey];
  const expectedAfter = mode === "native" ? undefined : canaryValue;

  delete Object.prototype[canaryKey];

  renderScenarioResult(
    `Lodash Prototype Pollution (${mode})`,
    [
      {
        observation: "Host canary before _.unset",
        expected: canaryValue,
        observed: hostCanaryBefore,
        pass: hostCanaryBefore === canaryValue,
      },
      {
        observation: "Vulnerable _.unset return value",
        expected: true,
        observed: unsetReturned,
        pass: unsetReturned === true,
      },
      {
        observation: "Host canary after _.unset",
        expected: expectedAfter ?? "deleted",
        observed: hostCanaryAfter ?? "deleted",
        pass: hostCanaryAfter === expectedAfter,
      },
    ],
    [
      "Both modes execute the same application and lodash@4.17.21 installation.",
      mode === "native"
        ? "The vulnerable native dependency deleted the host prototype canary."
        : "The import was redirected to the generated proxy; the host prototype canary remained intact.",
    ],
  );
} finally {
  delete Object.prototype[canaryKey];
}
