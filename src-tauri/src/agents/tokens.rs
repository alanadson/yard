//! Shared token normalization keeps session summaries and history consistent.

pub(crate) type TokenCounts = (u64, u64, u64, u64);

/// Each API message contributes once, even when content blocks are interleaved.
pub(crate) fn claude_delta(
    message: &serde_json::Value,
    seen: &mut std::collections::HashSet<String>,
) -> Option<TokenCounts> {
    claude_usage_delta(
        message.get("id").and_then(serde_json::Value::as_str),
        message.get("usage"),
        seen,
    )
}

/// `claude_delta` over the two fields it reads (`message.id` as a string,
/// `message.usage` as it came): what the typed scans of `usage_line` hand
/// over, since they never build the message as a `Value`.
pub(crate) fn claude_usage_delta(
    id: Option<&str>,
    usage: Option<&serde_json::Value>,
    seen: &mut std::collections::HashSet<String>,
) -> Option<TokenCounts> {
    let usage = usage.filter(|value| value.is_object())?;
    if let Some(id) = id.filter(|id| !id.is_empty()) {
        if !seen.insert(id.to_string()) {
            return None;
        }
    }
    let number = |key| {
        usage
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    Some((
        number("input_tokens"),
        number("cache_read_input_tokens"),
        number("cache_creation_input_tokens"),
        number("output_tokens"),
    ))
}

fn counts(value: &serde_json::Value) -> TokenCounts {
    let number = |key| {
        value
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    (
        number("input_tokens"),
        number("cached_input_tokens"),
        number("cache_write_input_tokens"),
        number("output_tokens"),
    )
}

/// Input, cached input, cache creation and output added by this event.
pub(crate) fn codex_delta(
    info: &serde_json::Value,
    previous: &mut Option<TokenCounts>,
) -> Option<TokenCounts> {
    let total = info
        .get("total_token_usage")
        .filter(|value| !value.is_null())
        .map(counts);
    let delta = match (
        info.get("last_token_usage")
            .filter(|value| !value.is_null()),
        total,
        *previous,
    ) {
        (Some(last), _, _) => counts(last),
        (None, Some(current), Some(before)) => (
            current.0.saturating_sub(before.0),
            current.1.saturating_sub(before.1),
            current.2.saturating_sub(before.2),
            current.3.saturating_sub(before.3),
        ),
        (None, Some(current), None) => current,
        (None, None, _) => return None,
    };
    if total.is_some() {
        *previous = total;
    }
    Some(delta)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The typed usage scans (`usage_line`) hand over the message's fields,
    /// not the message: the count, and the ids it remembers, must be exactly
    /// the ones `claude_delta` gives the whole message.
    #[test]
    fn the_fields_of_a_message_count_exactly_like_the_message_itself() {
        let messages = [
            r#"{"id":"m1","usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}"#,
            r#"{"id":"m1","usage":{"input_tokens":3}}"#,
            r#"{"id":"m2","usage":5}"#,
            r#"{"id":"m2","usage":{"input_tokens":1.5,"output_tokens":-2}}"#,
            r#"{"id":"","usage":{"input_tokens":8}}"#,
            r#"{"id":"","usage":{"input_tokens":8}}"#,
            r#"{"id":7,"usage":{"output_tokens":9}}"#,
            r#"{"usage":{"output_tokens":9}}"#,
            r#"{"id":"m3"}"#,
            r#"{"id":"m3","usage":null}"#,
        ];
        let mut whole = HashSet::new();
        let mut parts = HashSet::new();
        for text in messages {
            let message: serde_json::Value = serde_json::from_str(text).unwrap();
            let expected = claude_delta(&message, &mut whole);
            let got = claude_usage_delta(
                message.get("id").and_then(serde_json::Value::as_str),
                message.get("usage"),
                &mut parts,
            );
            assert_eq!(got, expected, "{text}");
            assert_eq!(parts, whole, "{text}");
        }
    }
}
