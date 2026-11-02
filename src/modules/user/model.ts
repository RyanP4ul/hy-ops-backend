import Elysia, { t, type Static } from "elysia";

const baseUserSchema = {
  name: t.String({ minLength: 1 }),
  email: t.String({ format: "email" }),
  password: t.Optional(t.String({ minLength: 6 })),
};

const staffProfileSchema = t.Object({
  warehouse_id: t.Numeric({ minimum: 1 }),
});

const customerProfileSchema = t.Object({
  company_name: t.String(),
  phone_number: t.String(),
  address_line: t.String({ minLength: 1 }),
  barangay: t.String({ minLength: 1 }),
  city_municipality: t.String({ minLength: 1 }),
  province: t.String({ minLength: 1 }),
  postal_code: t.String(),
  latitude: t.String(),
  longitude: t.String(),
});

const driverProfileSchema = t.Object({
  warehouse_id: t.Numeric({ minimum: 1 }),
  status: t.String(),
  warehouse_name: t.String(),
  phone_number: t.String(),
});

const userAdminSchema = t.Object({
  ...baseUserSchema,
  role: t.Union([t.Literal("admin")]),
});

const staffAdminSchema = t.Object({
  ...baseUserSchema,
  role: t.Literal("staff"),
  profile: t.Optional(staffProfileSchema),
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
  staffAdminSchema,
  userCustomerSchema,
  userDriverSchema,
]);

export type UserType = Static<typeof userSchema>;

export const userModel = new Elysia().model({
  "user.create": userSchema,
  "user.update": userSchema,
  "user.changePassword": t.Object({
    password: t.String({ minLength: 6 }),
  }),
});
