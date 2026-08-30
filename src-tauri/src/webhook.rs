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
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    match agent
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(body)
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, _)) => Err(format!("o servidor respondeu {code}")),
        Err(e) => Err(format!("não consegui enviar: {e}")),
    }
}

/// Why these rules matter: this is the only path in the app that carries what
/// an agent printed off the machine. The address check is the whole of the
/// fence, and it is checked here as well as in the interface because this
/// command is callable from the frontend.
#[cfg(test)]
mod tests {
    use super::*;

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
