/** Invalid Windows signing metadata must be refused before an installer compilation starts. */
import { expect, it } from "vitest";
import { signingCertificate } from "./signing-certificate.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

it("refuses an expired signing certificate instead of producing a usable thumbprint", () => {
  const certificate = { thumbprint: "A".repeat(40), hasPrivateKey: true,
    notBefore: "2025-01-01T00:00:00Z", notAfter: "2026-01-01T00:00:00Z", usages: ["1.3.6.1.5.5.7.3.3"] };
  expect(signingCertificate([certificate], Date.parse("2026-10-06T00:00:00Z"))).toEqual({ ok: false, reason: "No currently valid code-signing certificate with a private key was imported." });
});

it("rejects an expired certificate through the real release validation entry point", () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-signing-check-"));
  try {
    const metadata = join(directory, "certificates.json");
    writeFileSync(metadata, JSON.stringify([{ thumbprint: "A".repeat(40), hasPrivateKey: true,
      notBefore: "2020-01-01T00:00:00Z", notAfter: "2021-01-01T00:00:00Z", usages: ["1.3.6.1.5.5.7.3.3"] }]));
    const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "signing-certificate.mjs"), metadata], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No currently valid code-signing certificate");
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses valid certificates that cannot sign application code with a private key", () => {
  for (const extra of [{ hasPrivateKey: false }, { usages: ["1.3.6.1.5.5.7.3.1"] }, { usages: [] }]) {
    const certificate = { thumbprint: "A".repeat(40), hasPrivateKey: true,
      notBefore: "2026-01-01T00:00:00Z", notAfter: "2027-01-01T00:00:00Z", usages: ["1.3.6.1.5.5.7.3.3"], ...extra };
    expect(signingCertificate([certificate], Date.parse("2026-10-07T00:00:00Z"))).toEqual({ ok: false, reason: "No currently valid code-signing certificate with a private key was imported." });
  }
});

it("refuses malformed certificate identities before they reach the bundler configuration", () => {
  for (const thumbprint of [undefined, "", "not-a-thumbprint", "A".repeat(39), "G".repeat(40)]) {
    const certificate = { thumbprint, hasPrivateKey: true, notBefore: "2026-01-01T00:00:00Z",
      notAfter: "2027-01-01T00:00:00Z", usages: ["1.3.6.1.5.5.7.3.3"] };
    expect(signingCertificate([certificate], Date.parse("2026-10-07T00:00:00Z")).ok).toBe(false);
  }
});

it("reads real Windows certificate metadata without importing a key into the user's certificate store", () => {
  const directory = mkdtempSync(join(tmpdir(), "yard-signing-check-"));
  try {
    const fixture = join(directory, "certificate.ps1");
    writeFileSync(fixture, `$ErrorActionPreference = 'Stop'
. $args[0]
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Yard isolated signing check', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$usages = [System.Security.Cryptography.OidCollection]::new()
[void]$usages.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $true))
$certificate = $request.CreateSelfSigned([DateTimeOffset]'2026-01-01T00:00:00Z', [DateTimeOffset]'2027-01-01T00:00:00Z')
try { @(Get-ReleaseCertificateMetadata -Certificates @($certificate)) | ConvertTo-Json -Depth 5 -Compress }
finally { $certificate.Dispose(); $rsa.Dispose() }
`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
      join(dirname(fileURLToPath(import.meta.url)), "signing-certificate.ps1")], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    expect(record.hasPrivateKey).toBe(true);
    expect(record.usages).toEqual(["1.3.6.1.5.5.7.3.3"]);
    expect(signingCertificate([record], Date.parse("2026-10-07T00:00:00Z"))).toEqual({ ok: true, thumbprint: record.thumbprint });
  } finally {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
