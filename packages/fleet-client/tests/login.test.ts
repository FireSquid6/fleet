import { describe, expect, test } from "bun:test";
import { loginCredentials, loginErrorMessage } from "../src/lib/login";

describe("loginCredentials", () => {
  test("trims the username but leaves the password exactly as typed", () => {
    expect(loginCredentials({ username: "  ada  ", password: " pass word " })).toEqual({
      username: "ada",
      password: " pass word ",
    });
  });

  test("is not submittable until both fields have something in them", () => {
    expect(loginCredentials({ username: "", password: "hunter2" })).toBeNull();
    expect(loginCredentials({ username: "   ", password: "hunter2" })).toBeNull();
    expect(loginCredentials({ username: "ada", password: "" })).toBeNull();
  });

  test("a password of nothing but spaces is still a password", () => {
    expect(loginCredentials({ username: "ada", password: "   " })).toEqual({
      username: "ada",
      password: "   ",
    });
  });
});

describe("loginErrorMessage", () => {
  test("shows the bridge's own wording", () => {
    expect(loginErrorMessage(new Error("invalid username or password"))).toBe(
      "invalid username or password",
    );
  });

  test("falls back rather than showing an empty line or a stringified non-error", () => {
    expect(loginErrorMessage(new Error("   "))).toBe("could not sign in");
    expect(loginErrorMessage(undefined)).toBe("could not sign in");
    expect(loginErrorMessage({ status: 500 })).toBe("could not sign in");
  });
});
