//! One `POST`, so a notification can reach someone who is not at the machine
//! (`src/lib/webhook.ts` holds the rules on the interface side).
//!
//! Deliberately dumb: it takes an address and a JSON body and posts it, with
//! a short timeout and no retry. It is a notification — arriving late is
//! worse than not arriving, and a queue of pending balloons is a mechanism
//! nobody asked for.
//!
//! The fence is duplicated here on purpose. `webhook.ts` already refuses
//! anything that is not https (or localhost), but this command is reachable
//! from the frontend, and the one thing that must never happen is a `file://`
//! or a plain-http address carrying an agent's words out of the machine.

use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(8);

/// Is this an address a notification may be sent to?
///
/// https anywhere; http only on the loopback, where there is no wire to
/// listen on. Everything else — `file:`, `javascript:`, a bare host — is not
/// a webhook.
pub fn allowed(url: &str) -> bool {
    let value = url.trim();
    if let Some(rest) = value.strip_prefix("https://") {
        return !rest.is_empty();
    }
    let Some(rest) = value.strip_prefix("http://") else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .split('@')
        .next_back()
        .unwrap_or_default();
    let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    matches!(
        name.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]"
    )
}

pub fn post(url: &str, body: &str) -> Result<(), String> {
    if !allowed(url) {
        return Err("endereço não permitido: use https (ou http em localhost)".into());
    }
    let agent = crate::http::client(TIMEOUT, None, true).map_err(|e| format!("não consegui enviar: {e}"))?;
    let response = agent
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("não consegui enviar: {e}"))?;
    match crate::http::refused(&response) {
        Some(code) => Err(format!("o servidor respondeu {code}")),
        None => Ok(()),
    }
}

/// Why these rules matter: this is the only path in the app that carries what
/// an agent printed off the machine. The address check is the whole of the
/// fence, and it is checked here as well as in the interface because this
/// command is callable from the frontend.
#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned when the client moved from ureq to reqwest: what the user reads
    /// when the server refuses, and what the server receives.
    #[test]
    fn a_refused_post_reports_the_status_the_server_answered() {
        let (url, server) = crate::http::testing::serve_once("500 Internal Server Error", &[], "");
        assert_eq!(post(&format!("{url}/hook"), r#"{"text":"done"}"#), Err("o servidor respondeu 500".to_string()));
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /hook "), "{request}");
        assert!(request.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(request.ends_with(r#"{"text":"done"}"#));
    }

    #[test]
    fn an_accepted_post_succeeds() {
        let (url, server) = crate::http::testing::serve_once("204 No Content", &[], "");
        assert_eq!(post(&format!("{url}/hook"), "{}"), Ok(()));
        server.join().unwrap();
    }

    #[test]
    fn https_is_allowed_anywhere() {
        assert!(allowed("https://ntfy.sh/meu-topico"));
        assert!(allowed("https://exemplo.dev/hook?a=1"));
    }

    #[test]
    fn plain_http_on_the_internet_is_refused() {
        assert!(!allowed("http://exemplo.dev/hook"));
        assert!(!allowed("http://192.168.0.10/hook"));
    }

    #[test]
    fn http_on_the_loopback_is_allowed_because_there_is_no_wire() {
        assert!(allowed("http://localhost:8080/hook"));
        assert!(allowed("http://127.0.0.1/hook"));
        assert!(allowed("http://[::1]:9/hook"));
    }

    /// The regression this guards: `http://localhost@evil.com/` reads as
    /// localhost to a careless parser and resolves to `evil.com`.
    #[test]
    fn a_userinfo_trick_does_not_pass_as_localhost() {
        assert!(!allowed("http://localhost@evil.com/hook"));
    }

    #[test]
    fn nothing_else_is_a_webhook() {
        assert!(!allowed("file:///c:/segredo.txt"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("ntfy.sh/x"));
        assert!(!allowed(""));
        assert!(!allowed("https://"));
    }
}
