//! Local certificate request generation; no network, subprocess or key persistence.
use anyhow::{Result, ensure};
use rcgen::{CertificateParams, DistinguishedName, KeyPair, PKCS_ECDSA_P256_SHA256};
use rustls::pki_types::PrivatePkcs8KeyDer;

pub fn create_csr(private_key_der: &[u8], hosts: Vec<String>) -> Result<Vec<u8>> {
    ensure!(
        !private_key_der.is_empty() && private_key_der.len() <= 4096,
        "invalid-csr-key"
    );
    ensure!(!hosts.is_empty() && hosts.len() <= 16, "invalid-csr-hosts");
    let mut distinct = std::collections::BTreeSet::new();
    for host in &hosts {
        ensure!(
            host.len() <= 253
                && host.is_ascii()
                && host.contains('.')
                && !host.ends_with('.')
                && distinct.insert(host),
            "invalid-csr-hosts"
        );
        ensure!(
            host.split('.').all(|part| !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')),
            "invalid-csr-hosts"
        );
        ensure!(
            host.parse::<std::net::IpAddr>().is_err(),
            "invalid-csr-hosts"
        );
    }
    let key = KeyPair::from_pkcs8_der_and_sign_algo(
        &PrivatePkcs8KeyDer::from(private_key_der),
        &PKCS_ECDSA_P256_SHA256,
    )
    .map_err(|_| anyhow::anyhow!("invalid-csr-key"))?;
    let mut params =
        CertificateParams::new(hosts).map_err(|_| anyhow::anyhow!("invalid-csr-hosts"))?;
    params.distinguished_name = DistinguishedName::new();
    Ok(params
        .serialize_request(&key)
        .map_err(|_| anyhow::anyhow!("csr-signing-failed"))?
        .der()
        .to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generates_signed_request_without_external_programs() {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let csr = create_csr(&key.serialize_der(), vec!["device.example.com".into()]).unwrap();
        assert!(csr.starts_with(&[0x30]));
        assert!(csr.windows(18).any(|bytes| bytes == b"device.example.com"));
        assert!(
            csr.windows(key.public_key_raw().len())
                .any(|bytes| bytes == key.public_key_raw())
        );
    }
    #[test]
    fn rejects_invalid_keys_and_unbounded_host_requests() {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
            .unwrap()
            .serialize_der();
        for hosts in [
            vec![],
            vec!["*.example.com".into()],
            vec!["127.0.0.1".into()],
            vec!["a.example.com\nother".into()],
            vec!["a.example.com".into(); 17],
        ] {
            assert!(create_csr(&key, hosts).is_err());
        }
        assert!(create_csr(b"not a private key", vec!["a.example.com".into()]).is_err());
    }
}
