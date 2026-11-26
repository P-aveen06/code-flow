import { describe, expect, it } from "vitest";
import { readApiUrl } from "./config";

describe("readApiUrl", () => {
  it("uses the configured API URL", () => {
    expect(readApiUrl({ VITE_API_URL: "https://api.example.com" })).toBe(
      "https://api.example.com",
    );
  });

  it("uses the default when the API URL is missing", () => {
    expect(readApiUrl({})).toBe("http://localhost:8787");
  });

  it("uses the default when the API URL is empty", () => {
    expect(readApiUrl({ VITE_API_URL: "" })).toBe("http://localhost:8787");
  });
});
