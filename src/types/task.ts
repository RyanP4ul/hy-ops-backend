export type TaskCallback = () => void | Promise<void>;

export type Task = {
  name: string;
  interval: number;
  callback: TaskCallback;
  timer: Timer | null;
  running: boolean;
  lastRunAt: Date | null;
  lastError: unknown | null;
};
