// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",

  // Foreground colors
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

type LogLevel = "info" | "warning" | "error" | "silly" | "debug";

interface LogConfig {
  level: LogLevel;
  color: string;
  prefix: string;
}

const logConfigs: Record<LogLevel, LogConfig> = {
  info: {
    level: "info",
    color: colors.cyan,
    prefix: "INF",
  },
  warning: {
    level: "warning",
    color: colors.yellow,
    prefix: "WRN",
  },
  error: {
    level: "error",
    color: colors.red,
    prefix: "ERR",
  },
  silly: {
    level: "silly",
    color: colors.magenta,
    prefix: "SIL",
  },
  debug: {
    level: "debug",
    color: colors.green,
    prefix: "DEB",
  },
};

function formatDate(): string {
  const now = new Date();
  return now.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function log(level: LogLevel, ...messages: string[]): void {
  const config = logConfigs[level];
  const timestamp = formatDate();
  const prefix = `${colors.gray}[${timestamp}]${colors.reset} ${config.color}${colors.bright}[${config.prefix}]${colors.reset}`;

  console.log(prefix, ...messages);
}

export const logger = {
  info: (...messages: string[]) => log("info", ...messages),
  warning: (...messages: string[]) => log("warning", ...messages),
  error: (...messages: string[]) => log("error", ...messages),
  silly: (...messages: string[]) => log("silly", ...messages),
  debug: (...messages: string[]) => log("debug", ...messages),
};
