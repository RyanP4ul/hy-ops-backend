export type AuthUser = {
  sub: number;
  email: string;
  name: string;
  role: string;
  token_version: number;
  user_agent: string;
  iat: number;
};

export type UserAgentInfo = {
  raw: string;
  browser: {
    name: string;
    version: string;
  };
  os: {
    name: string;
    version: string;
  };
  device: {
    type: "desktop" | "mobile" | "tablet" | "unknown";
  };
};
