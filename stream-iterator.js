// phonemizer (eSpeak NG) unpacks its data with `for await (… of stream)`, which needs
// ReadableStream to be async-iterable. Older Safari lacks that, and phonemizer then waits
// forever without an error. This adds the iteration where it is missing; it must be
// imported before phonemizer.
if (
  typeof ReadableStream === "function" &&
  !ReadableStream.prototype[Symbol.asyncIterator]
)
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
