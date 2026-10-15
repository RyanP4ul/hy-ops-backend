import { Elysia, t } from "elysia";

const version = 1;

export const authRoutes = new Elysia().post(
  `/api/v${version}/login`,
  ({ body }) => {
    return body.name;
  },
  {
    body: t.Object({
      name: t.String({ minLength: 3, maxLength: 32 }),
      password: t.String(),
    }),
  },
);
