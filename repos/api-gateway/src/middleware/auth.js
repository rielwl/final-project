import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL ?? "http://localhost:9000/.well-known/jwks.json"));

/** Verifies the caller's bearer token and attaches { clientId, scopes } to req.auth. */
export async function authenticate(req, res, next) {
  if (req.path === "/healthz") return next();

  const header = req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_bearer_token" });

  try {
    const { payload } = await jwtVerify(token, jwks, { audience: "acme-payments" });
    req.auth = { clientId: payload.sub, scopes: (payload.scope ?? "").split(" ") };
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}
