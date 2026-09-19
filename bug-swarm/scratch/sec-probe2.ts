import { decideEgress, isPrivateIp } from "../../packages/core/src/sandbox/egress-allowlist.js";
import { redactObject, redactCredentials, containsCredentials } from "../../packages/core/src/internal/credential-redactor.js";

console.log("=== A. trailing-dot / name-form private-address bypass through decideEgress ===");
const allow = ["http://localhost:3000", "https://example.com"];
for (const u of ["http://localhost.:3000/x", "http://localhost./x", "http://LOCALHOST/x"]) {
  const d = decideEgress(u, allow);
  console.log(`${u.padEnd(28)} allowed=${d.allowed} reason=${d.reason} private=${d.privateAddress}`);
}
console.log(`isPrivateIp("localhost.") = ${isPrivateIp("localhost.")}  isPrivateIp("127.0.0.1.") = ${isPrivateIp("127.0.0.1.")}`);

console.log("\n=== B. redactObject: compound secret field names leak in full ===");
const obj = {
  dbPassword: "postgres://secret",
  userPassword: "hunter2",
  adminPassword: "godmode",
  apiSecret: "sk-live-abcdef",
  openaiKey: "sk-proj-1234567890abcdefghij",
  anthropicKey: "sk-ant-1234567890abcdefghij",
  refreshTokenValue: "rt_abc",
  stripeSigningSecret: "whsec_abc",
  ok: "not secret",
};
const out = redactObject(obj);
for (const [k, v] of Object.entries(out)) {
  console.log(`${k.padEnd(22)} = ${typeof v === "string" && v.length > 12 ? v.slice(0, 12) + "…" : v}  ${v !== "<redacted>" && k !== "ok" ? "  <-- LEAKED" : ""}`);
}

console.log("\n=== C. whitespace-bearing quoted secrets are not detected ===");
for (const t of ['password: "hunter2 traced"', "api_key=\"my key value\"", "PASSWORD='a b c d e'"]) {
  console.log(`containsCredentials=${containsCredentials(t)}  out=${redactCredentials(t)}`);
}
