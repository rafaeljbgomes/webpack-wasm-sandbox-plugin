let invocationCount = 0;

export default function run() {
  invocationCount += 1;
  if (invocationCount === 2) {
    throw new Error("Intentional failure on the second scenario repetition.");
  }
}
