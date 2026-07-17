import stripAnsi from "strip-ansi";
import { renderScenarioResult } from "./reporter.js";

const mode = __SECURITY_MODE__;
const victimAddress = "0x1111111111111111111111111111111111111111";
const attackerAddress = "0x9999999999999999999999999999999999999999";

function installHostFixtures() {
  const descriptors = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    XMLHttpRequest: Object.getOwnPropertyDescriptor(
      globalThis,
      "XMLHttpRequest",
    ),
    ethereum: Object.getOwnPropertyDescriptor(globalThis, "ethereum"),
  };

  const fakeFetch = async (_resource, init = {}) => ({
    async json() {
      return JSON.parse(init.body);
    },
  });

  class FakeXMLHttpRequest {
    open(method, url) {
      this.method = method;
      this.url = url;
    }

    send(body) {
      this.sentBody = body;
    }
  }

  const fakeEthereum = {
    async request(payload) {
      return payload.params[0];
    },
  };

  Object.defineProperties(globalThis, {
    fetch: {
      configurable: true,
      writable: true,
      value: fakeFetch,
    },
    XMLHttpRequest: {
      configurable: true,
      writable: true,
      value: FakeXMLHttpRequest,
    },
    ethereum: {
      configurable: true,
      writable: true,
      value: fakeEthereum,
    },
  });

  return {
    references: {
      fetch: fakeFetch,
      XMLHttpRequest: FakeXMLHttpRequest,
      ethereum: fakeEthereum,
    },
    restore() {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete globalThis[key];
        }
      }
    },
  };
}

const fixtures = installHostFixtures();

try {
  const stripped = stripAnsi("\u001B[31msecurity probe\u001B[0m");

  const fetchResponse = await globalThis.fetch("/security-local-only", {
    method: "POST",
    body: JSON.stringify({ to: victimAddress }),
  });
  const fetchRecipient = (await fetchResponse.json()).to;

  const request = new globalThis.XMLHttpRequest();
  request.open("POST", "/security-local-only");
  request.send(JSON.stringify({ to: victimAddress }));
  const xhrRecipient = JSON.parse(request.sentBody).to;

  const transaction = await globalThis.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ to: victimAddress, value: "0x0" }],
  });

  const expectedRecipient =
    mode === "native" ? attackerAddress : victimAddress;
  const expectedApiState = mode === "native" ? "intercepted" : "unchanged";
  const apiState =
    globalThis.fetch !== fixtures.references.fetch &&
    globalThis.XMLHttpRequest !== fixtures.references.XMLHttpRequest &&
    globalThis.ethereum !== fixtures.references.ethereum
      ? "intercepted"
      : globalThis.fetch === fixtures.references.fetch &&
          globalThis.XMLHttpRequest === fixtures.references.XMLHttpRequest &&
          globalThis.ethereum === fixtures.references.ethereum
        ? "unchanged"
        : "partially changed";

  renderScenarioResult(
    `strip-ansi Supply-chain Fixture (${mode})`,
    [
      {
        observation: "Normal ANSI removal",
        expected: "security probe",
        observed: stripped,
        pass: stripped === "security probe",
      },
      {
        observation: "Host API references",
        expected: expectedApiState,
        observed: apiState,
        pass: apiState === expectedApiState,
      },
      {
        observation: "fetch transaction recipient",
        expected: expectedRecipient,
        observed: fetchRecipient,
        pass: fetchRecipient === expectedRecipient,
      },
      {
        observation: "XMLHttpRequest transaction recipient",
        expected: expectedRecipient,
        observed: xhrRecipient,
        pass: xhrRecipient === expectedRecipient,
      },
      {
        observation: "Wallet transaction recipient",
        expected: expectedRecipient,
        observed: transaction.to,
        pass: transaction.to === expectedRecipient,
      },
    ],
    [
      "The installed strip-ansi package contains a harmless evaluation patch that reproduces API interception and recipient rewriting without external requests.",
      mode === "native"
        ? "Native execution allowed the altered dependency to replace host APIs."
        : "The sandbox received no browser capabilities, so the altered dependency could not replace host APIs.",
    ],
  );
} finally {
  fixtures.restore();
}
