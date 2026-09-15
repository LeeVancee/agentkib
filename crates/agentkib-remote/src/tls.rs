use anyhow::{Context, Result, ensure};
use rustls::{
    DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

pub fn fingerprint(cert: &[u8]) -> String {
    hex::encode(Sha256::digest(cert))
}

#[derive(Serialize, Deserialize)]
struct Identity {
    certificate: Vec<u8>,
    private_key: Vec<u8>,
}

pub struct TlsIdentity {
    pub id: String,
    pub server: Arc<rustls::ServerConfig>,
    pub client: Arc<rustls::ClientConfig>,
}

// Unknown certificates are permitted only to prove possession during pairing.
// Authorization and exact certificate pins are enforced before any application data.
#[derive(Debug)]
struct DeviceVerifier;
impl DeviceVerifier {
    fn signature(
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn schemes() -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
impl ServerCertVerifier for DeviceVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if cert.len() > 8192 {
            return Err(rustls::Error::General(
                "device certificate too large".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.3 required".into()))
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Self::signature(m, c, s)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        Self::schemes()
    }
}
impl ClientCertVerifier for DeviceVerifier {
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        if cert.len() > 8192 {
            return Err(rustls::Error::General(
                "device certificate too large".into(),
            ));
        }
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.3 required".into()))
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &CertificateDer<'_>,
        s: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Self::signature(m, c, s)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        Self::schemes()
    }
}

pub fn write_private(path: &Path, value: &impl Serialize) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().context("missing storage directory")?;
    prepare_directory(parent)?;
    if path.exists() {
        ensure!(
            !std::fs::symlink_metadata(path)?.file_type().is_symlink(),
            "private storage must not be a symlink"
        );
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    restrict(temp.path(), false)?;
    temp.write_all(&serde_json::to_vec(value)?)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

pub fn prepare_directory(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| p.exists()) {
        ensure!(
            !std::fs::symlink_metadata(parent)?.file_type().is_symlink(),
            "private storage parent must not be a symlink"
        );
    }
    if path.exists() {
        ensure!(
            !std::fs::symlink_metadata(path)?.file_type().is_symlink(),
            "private storage directory must not be a symlink"
        );
    }
    std::fs::create_dir_all(path)?;
    restrict(path, true)
}

pub fn restrict(path: &Path, directory: bool) -> Result<()> {
    ensure!(
        !std::fs::symlink_metadata(path)?.file_type().is_symlink(),
        "private storage must not be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                },
                DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
            },
        };
        // OWNER RIGHTS refers to the file's actual owner, not a username or group.
        // Protected ACLs remove inherited access; OI/CI protect newly created children.
        let sddl = if directory {
            "D:P(A;OICI;FA;;;OW)"
        } else {
            "D:P(A;;FA;;;OW)"
        }
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut descriptor = std::ptr::null_mut();
        unsafe {
            ensure!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut()
                ) != 0,
                "could not create private storage ACL"
            );
            let applied = SetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            LocalFree(descriptor.cast());
            ensure!(applied != 0, "could not protect private storage ACL");
        }
    }
    Ok(())
}

impl TlsIdentity {
    pub fn load(dir: &Path) -> Result<Self> {
        prepare_directory(dir)?;
        let path = dir.join("identity.json");
        let identity: Identity = if path.exists() {
            ensure!(
                !std::fs::symlink_metadata(&path)?.file_type().is_symlink(),
                "identity must not be a symlink"
            );
            restrict(&path, false)?;
            ensure!(std::fs::metadata(&path)?.len() < 32768, "invalid identity");
            serde_json::from_slice(&std::fs::read(&path)?)?
        } else {
            let generated = rcgen::generate_simple_self_signed(vec!["agentkib.local".into()])?;
            let value = Identity {
                certificate: generated.cert.der().to_vec(),
                private_key: generated.signing_key.serialize_der(),
            };
            write_private(&path, &value)?;
            value
        };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let server = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_client_cert_verifier(Arc::new(DeviceVerifier))
            .with_single_cert(
                vec![CertificateDer::from(identity.certificate.clone())],
                PrivatePkcs8KeyDer::from(identity.private_key.clone()).into(),
            )?;
        let client = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(DeviceVerifier))
            .with_client_auth_cert(
                vec![CertificateDer::from(identity.certificate.clone())],
                PrivatePkcs8KeyDer::from(identity.private_key).into(),
            )?;
        Ok(Self {
            id: fingerprint(&identity.certificate),
            server: Arc::new(server),
            client: Arc::new(client),
        })
    }
}
