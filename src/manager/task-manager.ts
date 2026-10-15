import { Task, TaskCallback } from "@/types/task";
import { logger } from "../utils/logger";

class TaskManager {
  private tasks = new Map<string, Task>();

  /**
   * Register a new task
   */
  register(name: string, interval: number, callback: TaskCallback) {
    if (this.tasks.has(name)) {
      throw new Error(`Task "${name}" is already registered.`);
    }

    const task: Task = {
      name,
      interval,
      callback,
      timer: null,
      running: false,
      lastRunAt: null,
      lastError: null,
    };

    this.tasks.set(name, task);

    logger.info(`[TaskManager] Registered task: ${name}`);
  }

  /**
   * Start a task
   */
  async start(name: string) {
    const task = this.getTask(name);

    if (task.running) {
      logger.info(`[TaskManager] Task "${name}" is already running.`);

      return;
    }

    task.running = true;
    task.lastError = null;

    logger.info(`[TaskManager] Starting task: ${name}`);

    // Run immediately
    await this.execute(task);

    // Start interval
    task.timer = setInterval(() => {
      this.execute(task);
    }, task.interval);
  }

  /**
   * Stop a task
   */
  stop(name: string) {
    const task = this.getTask(name);

    if (!task.running) {
      logger.info(`[TaskManager] Task "${name}" is already stopped.`);

      return;
    }

    if (task.timer) {
      clearInterval(task.timer);
      task.timer = null;
    }

    task.running = false;

    logger.info(`[TaskManager] Stopped task: ${name}`);
  }

  /**
   * Restart a task
   */
  async restart(name: string) {
    this.stop(name);

    await this.start(name);
  }

  /**
   * Start every registered task
   */
  async startAll() {
    for (const task of this.tasks.values()) {
      await this.start(task.name);
    }
  }

  /**
   * Stop every registered task
   */
  stopAll() {
    for (const task of this.tasks.values()) {
      this.stop(task.name);
    }
  }

  /**
   * Execute a task safely
   */
  private async execute(task: Task) {
    if (!task.running) {
      return;
    }

    try {
      task.lastRunAt = new Date();
      task.lastError = null;

      logger.info(`[TaskManager] Running task: ${task.name}`);

      await task.callback();

      logger.info(`[TaskManager] Completed task: ${task.name}`);
    } catch (error) {
      task.lastError = error;

      if (error instanceof Error) {
        logger.error(
          `[TaskManager] Task "${task.name}" failed:`,
          error.message,
        );
      }
    }
  }

  /**
   * Get one task
   */
  private getTask(name: string): Task {
    const task = this.tasks.get(name);

    if (!task) {
      throw new Error(`Task "${name}" is not registered.`);
    }

    return task;
  }

  /**
   * Get status of one task
   */
  getStatus(name: string) {
    const task = this.getTask(name);

    return {
      name: task.name,
      interval: task.interval,
      running: task.running,
      lastRunAt: task.lastRunAt,
      lastError: task.lastError,
    };
  }

  /**
   * Get status of all tasks
   */
  getAllStatuses() {
    return Array.from(this.tasks.values()).map((task) => ({
      name: task.name,
      interval: task.interval,
      running: task.running,
      lastRunAt: task.lastRunAt,
      lastError: task.lastError,
    }));
  }

  /**
   * Check if task exists
   */
  has(name: string) {
    return this.tasks.has(name);
  }

  /**
   * Remove a task
   */
  remove(name: string) {
    const task = this.getTask(name);

    this.stop(name);

    this.tasks.delete(task.name);

    logger.info(`[TaskManager] Removed task: ${name}`);
  }
}

export const taskManager = new TaskManager();
