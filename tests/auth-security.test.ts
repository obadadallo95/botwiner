import test from "node:test";
import assert from "node:assert/strict";
import { verifyToken, type DecodedAuthToken } from "../apps/api/src/server.js";

test("Auth Security - Firebase ID token verified successfully", async () => {
  const mockFirebaseVerifier = async (token: string): Promise<DecodedAuthToken> => {
    await Promise.resolve();
    if (token === "valid-fb-token") {
      return {
        uid: "user-123",
        email: "owner@example.com",
        owner: true,
        aud: "test-aud",
        auth_time: 1234567,
        exp: 2345678,
        firebase: { identities: {}, sign_in_provider: "custom" },
        iss: "https://securetoken.google.com/test",
        sub: "user-123",
      };
    }
    throw new Error("invalid firebase token");
  };

  const result = await verifyToken("valid-fb-token", {
    verifyFirebaseIdToken: mockFirebaseVerifier,
  });

  assert.equal(result.email, "owner@example.com");
  assert.equal(result.uid, "user-123");
  assert.equal(result.isOwnerClaim, true);
});

test("Auth Security - Fallback disabled when googleOAuthClientId is not configured", async () => {
  const mockFirebaseVerifier = async (): Promise<DecodedAuthToken> => {
    await Promise.resolve();
    throw new Error("invalid firebase token");
  };

  let fetchCalled = false;
  const mockFetch = async (): Promise<Response> => {
    await Promise.resolve();
    fetchCalled = true;
    return new Response(JSON.stringify({ email: "owner@example.com", aud: "some-aud" }), { status: 200 });
  };

  await assert.rejects(
    async () => {
      await verifyToken("random-token", {
        verifyFirebaseIdToken: mockFirebaseVerifier,
        googleOAuthClientId: undefined,
        fetchImpl: mockFetch,
      });
    },
    /invalid firebase token/
  );

  assert.equal(fetchCalled, false, "Fallback fetch should not be called when client ID is not configured");
});

test("Auth Security - Google token rejected if audience does not match configured GOOGLE_OAUTH_CLIENT_ID", async () => {
  const mockFirebaseVerifier = async (): Promise<DecodedAuthToken> => {
    await Promise.resolve();
    throw new Error("invalid firebase token");
  };

  const mockFetch = async (): Promise<Response> => {
    await Promise.resolve();
    return new Response(
      JSON.stringify({
        email: "owner@example.com",
        sub: "google-uid-123",
        aud: "unrelated-client-id-attacker.apps.googleusercontent.com",
        iss: "https://accounts.google.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        email_verified: true,
      }),
      { status: 200 }
    );
  };

  await assert.rejects(
    async () => {
      await verifyToken("google-id-token", {
        verifyFirebaseIdToken: mockFirebaseVerifier,
        googleOAuthClientId: "expected-client-id.apps.googleusercontent.com",
        fetchImpl: mockFetch,
      });
    },
    /invalid firebase token/,
    "Token minted for unrelated OAuth client must be rejected even if email matches"
  );
});

test("Auth Security - Google token rejected if expired", async () => {
  const mockFirebaseVerifier = async (): Promise<DecodedAuthToken> => {
    await Promise.resolve();
    throw new Error("invalid firebase token");
  };

  const mockFetch = async (): Promise<Response> => {
    await Promise.resolve();
    return new Response(
      JSON.stringify({
        email: "owner@example.com",
        sub: "google-uid-123",
        aud: "expected-client-id.apps.googleusercontent.com",
        iss: "https://accounts.google.com",
        exp: Math.floor(Date.now() / 1000) - 60, // expired
        email_verified: true,
      }),
      { status: 200 }
    );
  };

  await assert.rejects(async () => {
    await verifyToken("google-id-token", {
      verifyFirebaseIdToken: mockFirebaseVerifier,
      googleOAuthClientId: "expected-client-id.apps.googleusercontent.com",
      fetchImpl: mockFetch,
    });
  });
});

test("Auth Security - Google token accepted when audience, issuer, exp, and email_verified match", async () => {
  const mockFirebaseVerifier = async (): Promise<DecodedAuthToken> => {
    await Promise.resolve();
    throw new Error("invalid firebase token");
  };

  const mockFetch = async (): Promise<Response> => {
    await Promise.resolve();
    return new Response(
      JSON.stringify({
        email: "owner@example.com",
        sub: "google-uid-123",
        aud: "expected-client-id.apps.googleusercontent.com",
        iss: "https://accounts.google.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        email_verified: "true",
      }),
      { status: 200 }
    );
  };

  const result = await verifyToken("google-id-token", {
    verifyFirebaseIdToken: mockFirebaseVerifier,
    googleOAuthClientId: "expected-client-id.apps.googleusercontent.com",
    fetchImpl: mockFetch,
  });

  assert.equal(result.email, "owner@example.com");
  assert.equal(result.uid, "google-uid-123");
  assert.equal(result.isOwnerClaim, false);
});
