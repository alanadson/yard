# Read signing metadata without exporting private key material.
function Get-ReleaseCertificateMetadata {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2[]]$Certificates)
    foreach ($certificate in $Certificates) {
        $usages = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
            ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
        [PSCustomObject]@{
            thumbprint = $certificate.Thumbprint
            hasPrivateKey = $certificate.HasPrivateKey
            notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
            notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
            usages = $usages
        }
    }
}
