import Elysia, { t, type Static } from "elysia";

const baseUserSchema = {
  name: t.String({ minLength: 1 }),
  email: t.String({ format: "email" }),
  password: t.Optional(t.String({ minLength: 6 })),
};

const customerProfileSchema = t.Object({
  company_name: t.String(),
  phone_number: t.String(),
  address: t.String(),
});

const driverProfileSchema = t.Object({
  status: t.String(),
  phone_number: t.String(),
});

const userAdminSchema = t.Object({
  ...baseUserSchema,
  role: t.Union([t.Literal("admin"), t.Literal("staff")]),
});

const userCustomerSchema = t.Object({
  ...baseUserSchema,
  role: t.Literal("customer"),
  profile: t.Optional(customerProfileSchema),
});

const userDriverSchema = t.Object({
  ...baseUserSchema,
  role: t.Literal("driver"),
  profile: t.Optional(driverProfileSchema),
});

export const userSchema = t.Union([
  userAdminSchema,
  userCustomerSchema,
  userDriverSchema,
]);

export type UserType = Static<typeof userSchema>;

export const userModel = new Elysia().model({
  "user.create": userSchema,
  "user.update": userSchema,
});
