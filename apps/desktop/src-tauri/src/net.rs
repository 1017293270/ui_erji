//! HTTP clients for public hosts (Feishu, DeepSeek). The EchoMind server has its own, which
//! trusts only the EchoMind CA (server.rs).

/// A client builder that trusts the usual public CAs: the system's on the desktop, and on a
/// phone Mozilla's list, because Rust has no system TLS to link there.
pub(crate) fn public() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(mobile)]
    let builder = builder.tls_certs_only(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().filter_map(|der| reqwest::Certificate::from_der(der).ok()));
    builder
}

/// rustls needs its cryptography chosen once, before the first connection.
#[cfg(mobile)]
pub(crate) fn init() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
