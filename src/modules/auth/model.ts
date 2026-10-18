import { t } from "elysia";
import { UserRole } from "../../db/schema/users";

export const LoginModel = {
  login: t.Object({
    email: t.String({ format: "email" }),
    password: t.String({ minLength: 6 }),
  }),
};

export type Login = typeof LoginModel.login.static;

export interface AccessTokenPayloadModel {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  token_version: number;
}

export interface RefreshTokenPayloadModel {
  sub: string;
  token_version: number;
}
