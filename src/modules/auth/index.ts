import Elysia from "elysia";
import bcrypt from "bcrypt";
import {
  AccessTokenPayloadModel,
  LoginModel,
  RefreshTokenPayloadModel,
} from "./model";
import { UserService } from "../user/service";
import {
  authPlugin,
  configCookie,
  cookieOptions,
  createAccessToken,
  createRefreshToken,
} from "@/plugins/auth";
import { logger } from "../../utils/logger";
import { db } from "@/db/index";

export const authRoutes = new Elysia({ prefix: "auth" })
  .model({
    ...LoginModel,
  })
  .use(authPlugin)
  .get("/me", async ({ cookie: { access_token }, jwt, set }) => {
    if (!access_token.value || typeof access_token.value !== "string") {
      set.status = 401;
      return {
        message: "Unauthorized",
      };
    }

    const payload = (await jwt.verify(
      access_token.value as string,
    )) as unknown as AccessTokenPayloadModel;

    if (!payload) {
      set.status = 401;
      return {
        message: "Unauthorized",
      };
    }

    const user = await UserService.findUserById(payload.sub);

    if (!user) {
      set.status = 401;
      return {
        message: "Unauthorized",
      };
    }

    if (user.token_version !== payload.token_version) {
      logger.error(
        `Token version mismatch for user ${user.id}. Token version: ${payload.token_version}, User token version: ${user.token_version}`,
      );
      set.status = 401;
      return {
        message: "Unauthorized",
      };
    }

    return payload;
  })
  .post(
    "/refresh",
    async ({ cookie: { access_token, refresh_token }, jwt, set }) => {
      if (!refresh_token.value || typeof refresh_token.value !== "string") {
        set.status = 401;
        return {
          message: "Unauthorized",
        };
      }

      const payload = (await jwt.verify(
        refresh_token.value as string,
      )) as unknown as RefreshTokenPayloadModel;

      if (!payload) {
        set.status = 401;
        return {
          message: "Unauthorized",
        };
      }

      const user = await UserService.findUserById(payload.sub);

      if (!user || user.token_version !== payload.token_version) {
        set.status = 401;
        return {
          message: "Unauthorized",
        };
      }

      const newAccessToken = await createAccessToken(jwt, user);

      access_token.set({
        value: newAccessToken,
        ...cookieOptions(configCookie.ACCESS_TOKEN_EXPIRATION),
      });

      return "ok";
    },
  )
  .post(
    "/login",
    async ({ jwt, body, set, cookie: { access_token, refresh_token } }) => {
      const { email, password } = body;
      const errors: Record<string, string> = {};
      const user = await UserService.findUserByEmail(email);

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        set.status = 400;
        errors["email"] = "Invalid credentials.";
      }

      if (errors && Object.keys(errors).length > 0) {
        set.status = 400;
        return {
          errors,
        };
      }

      const { accessToken, refreshToken } = await UserService.rotateSession(
        user?.id || -1,
        jwt,
      );

      access_token.set({
        value: accessToken,
        ...cookieOptions(configCookie.ACCESS_TOKEN_EXPIRATION),
      });

      refresh_token.set({
        value: refreshToken,
        ...cookieOptions(configCookie.REFRESH_TOKEN_EXPIRATION),
      });

      return {
        message: "Logged in",
      };
    },
    {
      body: "login",
    },
  )
  .post("/logout", async ({ cookie: { access_token, refresh_token }, set }) => {
    access_token.remove();
    refresh_token.remove();

    set.status = 200;

    return {
      message: "Logged out",
    };
  });
