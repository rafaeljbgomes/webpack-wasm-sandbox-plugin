import nacl from "tweetnacl";

const seed = new Uint8Array(32);
for (let index = 0; index < seed.length; index += 1) {
  seed[index] = index + 1;
}

const message = new TextEncoder().encode(
  "Performance harness message signed with TweetNaCl for sandbox compatibility.",
);

export default function run() {
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const signature = nacl.sign.detached(message, keyPair.secretKey);
  const verified = nacl.sign.detached.verify(message, signature, keyPair.publicKey);
  const digest = nacl.hash(message);

  if (!verified || signature.length !== nacl.sign.signatureLength || digest.length !== 64) {
    throw new Error("TweetNaCl scenario produced invalid signature output.");
  }
}
