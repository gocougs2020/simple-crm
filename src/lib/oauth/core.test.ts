import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizationServerMetadata,
  isPrivateAddress,
  metadataUrlProblem,
  pkceChallenge,
  protectedResourceMetadata,
  redirectLabel,
  redirectMatches,
  redirectUriProblem,
  redirectWith,
  requestedAccess,
  verifyPkce,
} from "./core";

describe("PKCE", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  it("matches the RFC 7636 example", () => {
    assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), true);
  });
  it("refuses a wrong, short or missing verifier", () => {
    assert.equal(verifyPkce(verifier.replace("d", "e"), pkceChallenge(verifier)), false);
    assert.equal(verifyPkce("short", pkceChallenge("short")), false);
    assert.equal(verifyPkce(null, pkceChallenge(verifier)), false);
  });
});

describe("scopes", () => {
  it("is read-only only when the app asks just to read", () => {
    assert.equal(requestedAccess("crm:read").readOnly, true);
    assert.equal(requestedAccess("crm:read crm:write").readOnly, false);
    assert.equal(requestedAccess(undefined).readOnly, false);
    assert.equal(requestedAccess("openid profile").readOnly, false);
  });
});

describe("redirect URIs", () => {
  it("allows https, loopback http and app schemes", () => {
    for (const ok of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:3334/callback", "http://127.0.0.1/cb", "http://[::1]:8080/cb", "cursor://anysphere.cursor-retrieval/oauth/callback", "vscode://vscode.github-authentication/did-authenticate"])
      assert.equal(redirectUriProblem(ok), null, ok);
  });
  it("refuses script, data, files, plain http and fragments", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://evil.example/cb", "https://a.example/cb#frag", "https://user:pw@a.example/cb", "not a url"]) assert.notEqual(redirectUriProblem(bad), null, bad);
  });
  it("matches exactly, or on any port for loopback", () => {
    const registered = ["https://claude.ai/cb", "http://127.0.0.1/callback"];
    assert.equal(redirectMatches(registered, "https://claude.ai/cb"), true);
    assert.equal(redirectMatches(registered, "https://claude.ai/cb/other"), false);
    assert.equal(redirectMatches(registered, "https://claude.ai:8443/cb"), false);
    assert.equal(redirectMatches(registered, "http://127.0.0.1:53682/callback"), true);
    assert.equal(redirectMatches(registered, "http://127.0.0.1:53682/other"), false);
    assert.equal(redirectMatches(registered, "http://localhost:53682/callback"), false);
  });
  it("adds parameters and keeps existing ones", () => {
    const u = new URL(redirectWith("https://a.example/cb?x=1", { code: "c", state: null, iss: "https://crm.example" }));
    assert.equal(u.searchParams.get("x"), "1");
    assert.equal(u.searchParams.get("code"), "c");
    assert.equal(u.searchParams.has("state"), false);
  });
  it("describes where people will be sent", () => {
    assert.equal(redirectLabel("https://chatgpt.com/x"), "chatgpt.com");
    assert.equal(redirectLabel("http://127.0.0.1:5/x"), "an app on this computer");
    assert.equal(redirectLabel("cursor://x/y"), "the cursor app");
  });
});

describe("client metadata documents", () => {
  it("only fetches public https URLs with a path", () => {
    assert.equal(metadataUrlProblem("https://app.example.com/oauth/client.json"), null);
    for (const bad of ["http://app.example.com/c.json", "https://app.example.com/", "https://localhost/c.json", "https://127.0.0.1/c.json", "https://10.1.2.3/c.json", "https://[::1]/c.json", "https://metadata.internal/c.json", "https://intranet/c.json", "https://app.example.com:8443/c.json", "https://u:p@app.example.com/c.json"])
      assert.notEqual(metadataUrlProblem(bad), null, bad);
  });
  it("refuses IP literals in any spelling the URL parser accepts", () => {
    for (const bad of ["https://[::ffff:127.0.0.1]/c.json", "https://[0:0:0:0:0:ffff:7f00:1]/c.json", "https://0x7f000001/c.json", "https://2130706433/c.json", "https://[2606:4700::1111]/c.json", "https://8.8.8.8/c.json"])
      assert.notEqual(metadataUrlProblem(bad), null, bad);
  });
  it("classifies every spelling of a private address, as URLs and DNS return them", () => {
    for (const ip of ["::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "2002:7f00:1::", "2002:c0a8:101::1", "64:ff9b::7f00:1", "2001:0:4136:e378::1", "fec0::1", "ff02::1", new URL("https://[::ffff:127.0.0.1]/").hostname.slice(1, -1)])
      assert.equal(isPrivateAddress(ip), true, ip);
    assert.equal(isPrivateAddress("not-an-ip"), true);
  });
  it("knows private and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.20.23.154", "172.32.0.1", "172.66.147.243", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

describe("discovery documents", () => {
  it("point the MCP resource at this authorization server", () => {
    const prm = protectedResourceMetadata("https://crm.example.com", "CRM");
    assert.equal(prm.resource, "https://crm.example.com/api/mcp");
    assert.deepEqual(prm.authorization_servers, ["https://crm.example.com"]);
    const asm = authorizationServerMetadata("https://crm.example.com");
    assert.equal(asm.issuer, "https://crm.example.com");
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
    assert.ok(asm.grant_types_supported.includes("refresh_token"));
    assert.equal(asm.client_id_metadata_document_supported, true);
  });
});
