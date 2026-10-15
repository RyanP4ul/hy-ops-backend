import { UserAgentInfo } from "@/types/auth-user";

export function parseUserAgent(userAgent: string | null): UserAgentInfo {
  const ua = userAgent ?? "";

  let browserName = "Unknown";
  let browserVersion = "";

  let osName = "Unknown";
  let osVersion = "";

  let deviceType: UserAgentInfo["device"]["type"] = "unknown";

  // OS
  if (/Windows NT 10\.0/i.test(ua)) {
    osName = "Windows";
    osVersion = "10/11";
  } else if (/Windows NT 6\.1/i.test(ua)) {
    osName = "Windows";
    osVersion = "7";
  } else if (/Android/i.test(ua)) {
    osName = "Android";

    const match = ua.match(/Android ([\d.]+)/i);
    osVersion = match?.[1] ?? "";
  } else if (/iPhone OS ([\d_]+)/i.test(ua)) {
    osName = "iOS";

    const match = ua.match(/iPhone OS ([\d_]+)/i);
    osVersion = match?.[1]?.replace(/_/g, ".") ?? "";
  } else if (/Mac OS X ([\d_]+)/i.test(ua)) {
    osName = "macOS";

    const match = ua.match(/Mac OS X ([\d_]+)/i);
    osVersion = match?.[1]?.replace(/_/g, ".") ?? "";
  } else if (/Linux/i.test(ua)) {
    osName = "Linux";
  }

  // Browser
  if (/Edg\/([\d.]+)/i.test(ua)) {
    browserName = "Microsoft Edge";

    const match = ua.match(/Edg\/([\d.]+)/i);
    browserVersion = match?.[1] ?? "";
  } else if (/Chrome\/([\d.]+)/i.test(ua)) {
    browserName = "Google Chrome";

    const match = ua.match(/Chrome\/([\d.]+)/i);
    browserVersion = match?.[1] ?? "";
  } else if (/Firefox\/([\d.]+)/i.test(ua)) {
    browserName = "Mozilla Firefox";

    const match = ua.match(/Firefox\/([\d.]+)/i);
    browserVersion = match?.[1] ?? "";
  } else if (/Version\/([\d.]+).*Safari/i.test(ua)) {
    browserName = "Safari";

    const match = ua.match(/Version\/([\d.]+)/i);
    browserVersion = match?.[1] ?? "";
  }

  // Device
  if (/iPhone|Android.*Mobile/i.test(ua)) {
    deviceType = "mobile";
  } else if (/iPad|Android(?!.*Mobile)/i.test(ua)) {
    deviceType = "tablet";
  } else if (ua) {
    deviceType = "desktop";
  }

  return {
    raw: ua,
    browser: {
      name: browserName,
      version: browserVersion,
    },
    os: {
      name: osName,
      version: osVersion,
    },
    device: {
      type: deviceType,
    },
  };
}
