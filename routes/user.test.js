const { createMockSupabase } = require("../test-utils/mockSupabase");

const mockSupabase = createMockSupabase();
jest.mock("../config/database", () => mockSupabase);

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const express = require("express");
const request = require("supertest");
const userRoutes = require("./user");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/user", userRoutes);
  return app;
}

const app = buildApp();
const validToken = jwt.sign({ userId: 1, email: "ada@example.com" }, process.env.JWT_SECRET);

beforeEach(() => {
  mockSupabase.__reset();
});

describe("POST /api/user/profile", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await request(app).post("/api/user/profile").send({ name: "Ada Lovelace" });

    expect(res.status).toBe(401);
  });

  it("rejects a name that is too short", async () => {
    const res = await request(app)
      .post("/api/user/profile")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ name: "A" });

    expect(res.status).toBe(400);
  });

  it("updates the full name and returns the serialized user", async () => {
    mockSupabase.mockResult("users", {
      data: {
        id: 1,
        full_name: "Ada Lovelace",
        email: "ada@example.com",
        display_picture_url: "",
        verified: true,
      },
      error: null,
    });

    const res = await request(app)
      .post("/api/user/profile")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ name: "Ada Lovelace" });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      _id: 1,
      name: "Ada Lovelace",
      email: "ada@example.com",
      displayPictureUrl: "",
      verified: true,
    });
  });
});

describe("POST /api/user/password", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await request(app)
      .post("/api/user/password")
      .send({ currentPassword: "OldPassw0rd!", newPassword: "NewPassw0rd!" });

    expect(res.status).toBe(401);
  });

  it("rejects a new password without a number", async () => {
    const res = await request(app)
      .post("/api/user/password")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ currentPassword: "OldPassw0rd!", newPassword: "NewPassword!" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/number/i);
  });

  it("rejects an incorrect current password", async () => {
    const hashed = await bcrypt.hash("OldPassw0rd!", 10);
    mockSupabase.mockResult("users", { data: { id: 1, password: hashed }, error: null });

    const res = await request(app)
      .post("/api/user/password")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ currentPassword: "WrongPassword1!", newPassword: "NewPassw0rd!" });

    expect(res.status).toBe(401);
    // Only the user lookup — no password update should run.
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });

  it("updates the password when the current password is correct", async () => {
    const hashed = await bcrypt.hash("OldPassw0rd!", 10);
    mockSupabase.mockResult("users", { data: { id: 1, password: hashed }, error: null });
    mockSupabase.mockResult("users", { data: null, error: null }); // update

    const res = await request(app)
      .post("/api/user/password")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ currentPassword: "OldPassw0rd!", newPassword: "NewPassw0rd!" });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/user/avatar", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await request(app)
      .post("/api/user/avatar")
      .send({ image: "base64data", mimeType: "image/jpeg" });

    expect(res.status).toBe(401);
  });

  it("rejects an unsupported mime type", async () => {
    const res = await request(app)
      .post("/api/user/avatar")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ image: "base64data", mimeType: "image/gif" });

    expect(res.status).toBe(400);
  });

  it("stores the image as a data URI and returns the serialized user", async () => {
    mockSupabase.mockResult("users", {
      data: {
        id: 1,
        full_name: "Ada Lovelace",
        email: "ada@example.com",
        display_picture_url: "data:image/jpeg;base64,base64data",
        verified: true,
      },
      error: null,
    });

    const res = await request(app)
      .post("/api/user/avatar")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ image: "base64data", mimeType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body.user.displayPictureUrl).toBe("data:image/jpeg;base64,base64data");
  });
});
