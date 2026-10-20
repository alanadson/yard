/** Select a currently valid certificate before starting the Windows installer build. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function signingCertificate(certificates, now) {
  const current = certificates.filter((certificate) => certificate.hasPrivateKey === true
    && typeof certificate.thumbprint === "string" && /^[a-f0-9]{40}$/i.test(certificate.thumbprint)
    && certificate.usages.includes("1.3.6.1.5.5.7.3.3")
    && Date.parse(certificate.notBefore) <= now && now < Date.parse(certificate.notAfter));
  if (current.length === 1) return { ok: true, thumbprint: current[0].thumbprint };
  return { ok: false, reason: "No currently valid code-signing certificate with a private key was imported." };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const certificates = JSON.parse(readFileSync(process.argv[2], "utf8").replace(/^\uFEFF/, ""));
    const result = signingCertificate(certificates, Date.now());
    if (result.ok) console.log(result.thumbprint);
    else { console.error(result.reason); process.exitCode = 1; }
  } catch {
    console.error("Signing certificate metadata could not be validated.");
    process.exitCode = 1;
  }
}
