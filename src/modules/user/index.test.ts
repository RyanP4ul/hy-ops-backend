import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

// Replace the service before loading routes: these tests never import the
// database client, start the application, or require account fixtures.
type Actor = { id: number; role: string; token_version: number };
let actor: Actor | undefined;
const mutations = {
  createUser: mock(async (..._args: unknown[]) => ({ message: "created" })),
  updateUser: mock(async (..._args: unknown[]) => ({ message: "updated" })),
  changePassword: mock(async (..._args: unknown[]) => ({ message: "changed" })),
  deleteUser: mock(async (..._args: unknown[]) => ({ message: "deleted" })),
  archiveUser: mock(async (..._args: unknown[]) => ({ id: 9, message: "deactivated" })),
};
const service = {
  ...mutations,
  getMutationActor: mock(async (_id: number) => actor),
  getUsers: mock(async () => ({ rows: [], total: 0 })),
  getCustomers: mock(async () => ({ rows: [], total: 0 })),
  getAllDrivers: mock(async () => ({ rows: [], total: 0 })),
};
mock.module("./service", () => ({ UserService: service }));
mock.module("../deliveries/scope", () => ({ staffWarehouse: async () => undefined }));
const { userRoutes } = require("./index") as typeof import("./index");

const account = { name: "Test Operator", email: "operator@example.test", role: "admin" };
const cases = [
  { method: "POST", path: "/users", body: account, mutation: "createUser" },
  { method: "PUT", path: "/users/2?version=7", body: account, mutation: "updateUser" },
  { method: "PATCH", path: "/users/2/password", body: { password: "test-password" }, mutation: "changePassword" },
  { method: "DELETE", path: "/users/2?version=7", mutation: "deleteUser" },
  { method: "POST", path: "/users/2/archive?version=7", mutation: "archiveUser" },
] as const;

function app(sub = "1", tokenVersion = 3, claimedRole = "admin") {
  // Mirrors the parent's verified-token resolve hook without signing tokens.
  return new Elysia()
    .resolve(() => ({ user: { sub, role: claimedRole, token_version: tokenVersion } }))
    .use(userRoutes);
}

function request(method: string, path: string, body?: object) {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

function expectNoMutations() {
  for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
}

beforeEach(() => {
  actor = { id: 1, role: "admin", token_version: 3 };
  for (const method of Object.values(service)) method.mockClear();
});

describe("Users mutation authorization", () => {
  for (const role of ["staff", "customer", "driver"]) {
    for (const route of cases) {
      test(`${role} cannot ${route.mutation}, even with an old admin claim`, async () => {
        actor = { id: 1, role, token_version: 3 };
        const response = await app().handle(request(route.method, route.path, "body" in route ? route.body : undefined));
        expect(response.status).toBe(403);
        expectNoMutations();
      });
    }
  }

  for (const state of ["missing", "revoked"]) {
    for (const route of cases) {
      test(`${state} account/session cannot ${route.mutation}`, async () => {
        actor = state === "missing" ? undefined : { id: 1, role: "admin", token_version: 4 };
        const response = await app().handle(request(route.method, route.path, "body" in route ? route.body : undefined));
        expect(response.status).toBe(401);
        expectNoMutations();
      });
    }
  }

  test("invalid actor ID is rejected before the account lookup", async () => {
    const response = await app("invalid").handle(request("DELETE", "/users/2?version=7"));
    expect(response.status).toBe(401);
    expect(service.getMutationActor).not.toHaveBeenCalled();
    expectNoMutations();
  });

  test("missing authentication context is rejected", async () => {
    const response = await new Elysia().use(userRoutes).handle(
      request("DELETE", "/users/2?version=7"),
    );
    expect(response.status).toBe(401);
    expect(service.getMutationActor).not.toHaveBeenCalled();
    expectNoMutations();
  });

  test("Users guard does not restrict other modules", async () => {
    actor = { id: 1, role: "staff", token_version: 3 };
    const response = await app("1", 3, "staff")
      .post("/unrelated", () => ({ ok: true }))
      .handle(request("POST", "/unrelated"));
    expect(response.status).toBe(200);
    expect(service.getMutationActor).not.toHaveBeenCalled();
    expectNoMutations();
  });

  for (const route of cases) {
    test(`active admin can ${route.mutation}`, async () => {
      const response = await app().handle(request(route.method, route.path, "body" in route ? route.body : undefined));
      expect(response.status).toBe(200);
      expect(service.getMutationActor).toHaveBeenCalledWith(1);
      expect(mutations[route.mutation]).toHaveBeenCalledTimes(1);
      for (const [name, mutation] of Object.entries(mutations)) {
        if (name !== route.mutation) expect(mutation).not.toHaveBeenCalled();
      }
      if (route.mutation === "updateUser") expect(mutations.updateUser).toHaveBeenCalledWith(2, 7, account, { id: 1, tokenVersion: 3 });
      if (route.mutation === "deleteUser") expect(mutations.deleteUser).toHaveBeenCalledWith(2, 7);
      if (route.mutation === "archiveUser") expect(mutations.archiveUser).toHaveBeenCalledWith(1, 2, 7, { id: 1, tokenVersion: 3 });
      if (route.mutation === "changePassword") expect(mutations.changePassword).toHaveBeenCalledWith(2, "test-password", { id: 1, tokenVersion: 3 });
      if (route.mutation === "createUser") expect(mutations.createUser).toHaveBeenCalledWith(account, { id: 1, tokenVersion: 3 });
    });
  }

  test("admin cannot delete their own account", async () => {
    const response = await app().handle(request("DELETE", "/users/1?version=7"));
    expect(response.status).toBe(403);
    expectNoMutations();
  });

  test("admin cannot deactivate their own account", async () => {
    const response = await app().handle(request("POST", "/users/1/archive?version=7"));
    expect(response.status).toBe(403);
    expectNoMutations();
  });

  test("admin cannot remove their own role", async () => {
    const response = await app().handle(request("PUT", "/users/1?version=7", { ...account, role: "staff" }));
    expect(response.status).toBe(403);
    expectNoMutations();
  });

  test("admin can edit their own account while retaining admin access", async () => {
    const response = await app().handle(request("PUT", "/users/1?version=7", account));
    expect(response.status).toBe(200);
    expect(mutations.updateUser).toHaveBeenCalledWith(1, 7, account, { id: 1, tokenVersion: 3 });
  });

  for (const path of ["/users/customers", "/users/drivers"]) {
    test(`${path} remains available to authenticated operational roles`, async () => {
      actor = { id: 1, role: "staff", token_version: 3 };
      const response = await app("1", 3, "staff").handle(request("GET", path));
      expect(response.status).toBe(200);
      expect(service.getMutationActor).not.toHaveBeenCalled();
      expectNoMutations();
    });
  }
});
