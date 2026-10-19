import { UserAgentInfo } from "@/types/auth-user";

export function parseUserAgent(
  userAgent: string | null,
): UserAgentInfo {
  const ua = userAgent ?? "";

  let browserName = "Unknown";
  let browserVersion = "";

  let osName = "Unknown";
  let osVersion = "";

  let deviceType: UserAgentInfo["device"]["type"] = "unknown";

  // Detect Flutter / Dart HTTP client
  const isFlutterApp = /Dart\/[\d.]+|Flutter/i.test(ua);

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
  if (isFlutterApp) {
    browserName = "HYOps Mobile App";
    browserVersion = "";
    deviceType = "mobile";
  } else if (/Edg\/([\d.]+)/i.test(ua)) {
    browserName = "Microsoft Edge";
    browserVersion = ua.match(/Edg\/([\d.]+)/i)?.[1] ?? "";
  } else if (/Chrome\/([\d.]+)/i.test(ua)) {
    browserName = "Google Chrome";
    browserVersion = ua.match(/Chrome\/([\d.]+)/i)?.[1] ?? "";
  } else if (/Firefox\/([\d.]+)/i.test(ua)) {
    browserName = "Mozilla Firefox";
    browserVersion = ua.match(/Firefox\/([\d.]+)/i)?.[1] ?? "";
  } else if (/Version\/([\d.]+).*Safari/i.test(ua)) {
    browserName = "Safari";
    browserVersion = ua.match(/Version\/([\d.]+)/i)?.[1] ?? "";
  }

  // Device, unless already identified as Flutter
  if (!isFlutterApp) {
    if (/iPhone|Android.*Mobile/i.test(ua)) {
      deviceType = "mobile";
    } else if (/iPad|Android(?!.*Mobile)/i.test(ua)) {
      deviceType = "tablet";
    } else if (ua) {
      deviceType = "desktop";
    }
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