import { afterEach, expect, test } from "bun:test";
import { taskManager } from "../src/manager/task-manager";

const name = "automation-runtime-fixture";
afterEach(() => { if (taskManager.has(name)) taskManager.remove(name); });

test("Run now reports callback failures and permits a successful retry", async () => {
  let fail = true;
  taskManager.register(name, 60000, async () => {
    if (fail) throw new Error("Numeric comparison failed");
  });
  await expect(taskManager.runNow(name)).rejects.toThrow("Numeric comparison failed");
  expect(taskManager.getStatus(name).lastError).toBeInstanceOf(Error);
  fail = false;
  await taskManager.runNow(name);
  expect(taskManager.getStatus(name).lastError).toBeNull();
});

test("a scheduled failure keeps its timer running so the task can retry", async () => {
  taskManager.register(name, 60000, async () => { throw new Error("Temporary failure"); });
  await taskManager.start(name);
  expect(taskManager.getStatus(name).running).toBe(true);
  expect(taskManager.getStatus(name).lastError).toBeInstanceOf(Error);
});

test("editing the interval replaces the callback before restarting", async () => {
  let oldRuns = 0, newRuns = 0;
  taskManager.register(name, 60000, async () => { oldRuns++; });
  await taskManager.start(name);
  await taskManager.updateInterval(name, 120000, async () => { newRuns++; });
  expect(oldRuns).toBe(1);
  expect(newRuns).toBe(1);
  expect(taskManager.getStatus(name).interval).toBe(120000);
});
