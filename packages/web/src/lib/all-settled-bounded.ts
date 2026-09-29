/** Run every operation while keeping at most `concurrency` promises in flight. */
export async function allSettledBounded<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  operation: (item: TItem, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        results[index] = {
          status: "fulfilled",
          value: await operation(items[index]!, index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
