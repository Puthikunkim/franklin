import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/r2", () => ({
  r2Configured: vi.fn(() => true),
  presignUpload: vi.fn(async () => "https://r2.example/put-url"),
  publicUrl: vi.fn((k: string) => `https://cdn.example/${k}`),
}));
vi.mock("../../src/lib/session", () => ({ getDealerId: vi.fn(async () => "dealer-1") }));

import { POST } from "../../src/app/api/uploads/presign/route";
import * as r2 from "../../src/lib/r2";
import * as session from "../../src/lib/session";

function req(body: unknown) {
  return new Request("http://localhost/api/uploads/presign", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/uploads/presign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 when not logged in", async () => {
    vi.mocked(session.getDealerId).mockResolvedValueOnce(null);
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 1000 }));
    expect(res.status).toBe(401);
  });

  it("503 when R2 is not configured", async () => {
    vi.mocked(r2.r2Configured).mockReturnValueOnce(false);
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 1000 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("r2_not_configured");
  });

  it("400 for a non-image content type", async () => {
    const res = await POST(req({ filename: "a.pdf", contentType: "application/pdf", size: 1000 }));
    expect(res.status).toBe(400);
  });

  it("400 for a file over 10 MB", async () => {
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 11 * 1024 * 1024 }));
    expect(res.status).toBe(400);
  });

  it("200 with upload + public URLs for a valid request", async () => {
    const res = await POST(req({ filename: "a.jpg", contentType: "image/jpeg", size: 1000 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadUrl).toBe("https://r2.example/put-url");
    expect(body.publicUrl).toMatch(/^https:\/\/cdn\.example\/listings\//);
  });
});
