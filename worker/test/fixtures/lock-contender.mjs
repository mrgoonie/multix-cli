#!/usr/bin/env node
// One of several processes that open the same job state directory at once
// (local-executor tests): prints "held" when it got the lock, "locked" otherwise.
const [moduleUrl, stateDir] = process.argv.slice(2);
const { createLocalExecutor, ExecutorLockedError } = await import(moduleUrl);
try {
  const executor = await createLocalExecutor({ stateDir, lockWaitMs: 0, runJob: async () => ({}) });
  // Hold long enough for every contender to have tried.
  await new Promise((r) => setTimeout(r, 400));
  await executor.close();
  console.log("held");
} catch (error) {
  console.log(
    error instanceof ExecutorLockedError ? "locked" : `error ${error?.code} ${error?.message}`,
  );
}
