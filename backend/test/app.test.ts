import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";

describe("createApp", () => {
  it("boots without throwing and registers health route", async () => {
    const app = createApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
