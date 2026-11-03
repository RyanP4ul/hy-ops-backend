import Elysia from "elysia";
import { currentSession } from "./policy";
import { issueWsTicket } from "./ws-ticket";
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
  .post("/ws-ticket", async ({ cookie: { access_token }, jwt, set }) => {
    set.headers["Cache-Control"] = "no-store";
    const claims = typeof access_token.value === "string"
      ? await jwt.verify(access_token.value)
      : false;
    const id = claims ? Number(claims.sub) : NaN;
    const actor = Number.isSafeInteger(id) && id > 0
      ? await UserService.getMutationActor(id)
      : null;
    if (!claims || !currentSession(claims, actor)) {
      set.status = 401;
      return { message: "Unauthorized" };
    }
    return { ticket: await issueWsTicket(claims) };
  })
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

    if (!user || !currentSession(payload, user)) {
      set.status = 401;
      return {
        message: "Unauthorized",
      };
    }

    return { ...payload, id: user.id };
  })
  .post(
    "/refresh",
    async ({ cookie: { access_token, refresh_token }, jwt, refreshToken, set }) => {
      if (!refresh_token.value || typeof refresh_token.value !== "string") {
        set.status = 401;
        return {
          message: "Unauthorized",
        };
      }

      const payload = (await refreshToken.verify(
        refresh_token.value as string,
      )) as unknown as RefreshTokenPayloadModel;

      if (!payload || payload.token_type !== "refresh" || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
        set.status = 401;
        return {
          message: "Unauthorized",
        };
      }

      const user = await UserService.findUserById(payload.sub);

      if (!user || user.token_version !== payload.token_version || user.refresh_token !== refresh_token.value) {
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
    async ({ jwt, refreshToken: refreshSigner, body, set, cookie: { access_token, refresh_token } }) => {
      const { email, password, is_mobile } = body;
      const errors: Record<string, string> = {};
      const user = await UserService.findUserByEmail(email);

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        set.status = 400;
        errors["email"] = "Invalid credentials.";
      }

      if (is_mobile && user && Object.keys(errors).length === 0 && user.role !== "driver") {
        errors["email"] = "Only driver accounts can sign in to HYOps Driver.";
      }

      if (!is_mobile && user?.role === "driver") {
        set.status = 400;
        errors["email"] = "Drivers can only log in via the mobile app.";
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
        refreshSigner,
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
        access_token: accessToken,
        refresh_token: refreshToken,
      };
    },
    {
      body: "login",
    },
  )
  .post("/logout", async ({ cookie: { access_token, refresh_token }, jwt, refreshToken, set }) => {
    const access = typeof access_token.value === "string" ? await jwt.verify(access_token.value) : false;
    const refresh = typeof refresh_token.value === "string" ? await refreshToken.verify(refresh_token.value) : false;
    const claims = access || refresh;
    if (claims && Number.isSafeInteger(Number(claims.sub)) && typeof claims.token_version === "number") {
      await UserService.revokeSession(Number(claims.sub), claims.token_version);
    }
    access_token.remove();
    refresh_token.remove();

    set.status = 200;

    return {
      message: "Logged out",
    };
  });
