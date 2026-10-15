import { Static, t } from "elysia";

export const AuthUser = t.Object({
  sub: t.Number(),
  email: t.String(),
  name: t.String(),
  role: t.String(),
  token_version: t.Number(),
  user_agent: t.Any(),
  iat: t.Number(),
});

export type AuthUser = Static<typeof AuthUser>;
