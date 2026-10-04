import { constants, publicEncrypt } from "node:crypto";
import type { Http } from "./http";

/**
 * V1 token auth, from the legacy docs (yce.makeupar.com/document/v1.x):
 * POST /s2s/v1.0/client/auth { client_id: API key, id_token } where id_token is
 * "client_id=<key>&timestamp=<ms>" RSA-encrypted with the secret key (an X.509
 * base64 public key), base64-encoded. The docs' sample uses JSEncrypt, i.e.
 * PKCS#1 v1.5 padding. The token is valid for 2 hours.
 *
 * V2 endpoints take the API key directly; this exists only as a fallback for
 * endpoints documented under V1 auth (the unit balance).
 */
export function makeIdToken(apiKey: string, secretKey: string, now = Date.now()): string {
  const body = secretKey.replace(/-----[^-]+-----|\s+/g, "");
  const pem = `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  const plain = Buffer.from(`client_id=${apiKey}&timestamp=${now}`);
  return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, plain).toString("base64");
}

interface AuthResponse {
  status: number;
  result: { access_token: string };
}

export async function getV1AccessToken(http: Http, apiKey: string, secretKey: string): Promise<string> {
  const res = await http.request<AuthResponse>("POST", "/s2s/v1.0/client/auth", {
    body: { client_id: apiKey, id_token: makeIdToken(apiKey, secretKey) },
    retry: "safe",
    auth: "none",
    note: "v1 auth",
  });
  return res.result.access_token;
}
