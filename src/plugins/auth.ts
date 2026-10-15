import { Elysia } from "elysia";
import jwt from "@elysia/jwt";
import { UserSelect } from "../db/schema/users";

export const createAccessToken = async (jwt: any, user: UserSelect) => {
  return await jwt.sign({
    sub: String(user.id),
    email: user.email,
    name: user.name,
    role: user.role,
    token_version: user.token_version,
  });
};

export const createRefreshToken = async (jwt: any, user: UserSelect) => {
  return await jwt.sign({
    sub: String(user.id),
    token_version: user.token_version,
  });
};

export const configCookie = {
  ACCESS_TOKEN_EXPIRATION: 15 * 60, // 15 minutes
  REFRESH_TOKEN_EXPIRATION: 7 * 24 * 60 * 60, // 7 days
};

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge,
});

export const authPlugin = new Elysia()
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "",
    }),
  )
  .use(
    jwt({
      name: "refreshToken",
      secret: process.env.REFRESH_TOKEN_SECRET || "",
    }),
  );

export const authGuard = new Elysia().use(authPlugin).guard(
  {
    beforeHandle: async ({ cookie: { access_token }, jwt, set }) => {
      if (!access_token.value) {
        set.status = 401;
        return "Unauthorized";
      }

      const payload = await jwt.verify(access_token.value as string);

      if (!payload) {
        set.status = 401;
        return "Unauthorized";
      }
    },
  },
  (app) =>
    app.resolve(async ({ cookie: { access_token }, jwt }) => {
      const payload = await jwt.verify(access_token.value as string);

      if (!payload) {
        throw new Error("Unauthorized");
      }

      return {
        user: payload,
      };
    }),
);
