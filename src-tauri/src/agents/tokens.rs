//! Shared token normalization keeps session summaries and history consistent.

pub(crate) type TokenCounts = (u64, u64, u64, u64);

pub(crate) fn cache_duration_valid(usage: Option<&serde_json::Value>) -> bool {
    let Some(duration) = usage.and_then(|usage| usage.get("cache_creation")) else { return true };
    if !duration.is_object() { return false; }
    let five_minute = duration.get("ephemeral_5m_input_tokens");
    let one_hour = duration.get("ephemeral_1h_input_tokens");
    let total = usage.and_then(|usage| usage.get("cache_creation_input_tokens")).and_then(serde_json::Value::as_u64);
    let Some(total) = total else { return false };
    if [five_minute, one_hour].into_iter().flatten().any(|value| value.as_u64().is_none()) { return false; }
    let sum = five_minute.and_then(serde_json::Value::as_u64).unwrap_or(0)
        .checked_add(one_hour.and_then(serde_json::Value::as_u64).unwrap_or(0));
    match (five_minute.is_some() && one_hour.is_some(), sum) {
        (true, Some(sum)) => sum == total,
        (false, Some(sum)) => sum <= total,
        (_, None) => false,
    }
}

pub(crate) fn cache_one_hour_tokens(usage: Option<&serde_json::Value>) -> u64 {
    usage.and_then(|value| value.get("cache_creation"))
        .and_then(|value| value.get("ephemeral_1h_input_tokens"))
        .and_then(serde_json::Value::as_u64).unwrap_or(0)
}

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

pub(crate) fn codex_usage_valid(info: &serde_json::Value, mut previous: Option<TokenCounts>) -> bool {
    let within_input = |raw: TokenCounts| raw.1.checked_add(raw.2).is_some_and(|cached| cached <= raw.0);
    if !["last_token_usage", "total_token_usage"].into_iter().filter_map(|key| info.get(key)).filter(|value| !value.is_null())
        .all(codex_counters_valid) { return false; }
    if info.get("last_token_usage").is_none_or(serde_json::Value::is_null)
        && previous.is_some_and(|raw| !within_input(raw)) { return false; }
    raw_codex_delta(info, &mut previous).is_none_or(within_input)
}

pub(crate) fn codex_counters_valid(value: &serde_json::Value) -> bool {
    let raw = counts(value);
    value.is_object() && ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"].into_iter()
        .filter_map(|key| value.get(key)).all(|value| value.as_u64().is_some())
        && raw.1.checked_add(raw.2).is_some_and(|cached| cached <= raw.0)
}

/// Input, cached input, cache creation and output added by this event.
pub(crate) fn codex_delta(
    info: &serde_json::Value,
    previous: &mut Option<TokenCounts>,
) -> Option<TokenCounts> {
    let delta = raw_codex_delta(info, previous)?;
    Some((delta.0.saturating_sub(delta.1).saturating_sub(delta.2), delta.1, delta.2, delta.3))
}

fn raw_codex_delta(info: &serde_json::Value, previous: &mut Option<TokenCounts>) -> Option<TokenCounts> {
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

    /// Codex includes cached tokens inside input, unlike Claude's separate counters.
    #[test]
    fn codex_input_excludes_cache_reads_after_each_raw_cumulative_delta() {
        let first = serde_json::json!({ "total_token_usage": { "input_tokens": 100, "cached_input_tokens": 60, "output_tokens": 10 } });
        let next = serde_json::json!({ "total_token_usage": { "input_tokens": 130, "cached_input_tokens": 65, "output_tokens": 15 } });
        let mut previous = None;
        assert_eq!(codex_delta(&first, &mut previous), Some((40, 60, 0, 10)));
        assert_eq!(codex_delta(&next, &mut previous), Some((25, 5, 0, 5)));
    }

    #[test]
    fn codex_cache_writes_are_a_separate_input_category_after_raw_delta_calculation() {
        let first = serde_json::json!({ "total_token_usage": { "input_tokens": 100, "cached_input_tokens": 60,
            "cache_write_input_tokens": 10, "output_tokens": 10 } });
        let next = serde_json::json!({ "total_token_usage": { "input_tokens": 130, "cached_input_tokens": 65,
            "cache_write_input_tokens": 15, "output_tokens": 15 } });
        let mut previous = None;
        assert_eq!(codex_delta(&first, &mut previous), Some((30, 60, 10, 10)));
        assert_eq!(codex_delta(&next, &mut previous), Some((20, 5, 5, 5)));
    }

    #[test]
    fn a_codex_cache_delta_larger_than_its_raw_input_increment_is_not_priceable() {
        let next = serde_json::json!({ "total_token_usage": { "input_tokens": 110, "cached_input_tokens": 80, "output_tokens": 15 } });
        assert!(!codex_usage_valid(&next, Some((100, 10, 0, 10))));
    }

    #[test]
    fn malformed_codex_counter_values_cannot_be_priced_as_silent_zeroes() {
        for field in ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"] {
            for value in [serde_json::json!(-1), serde_json::json!(0.5), serde_json::json!("100"), serde_json::Value::Null] {
                let mut raw = serde_json::json!({ "input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 5 });
                raw[field] = value;
                let info = serde_json::json!({ "last_token_usage": raw });
                assert!(!codex_usage_valid(&info, None), "{info}");
            }
        }
        for raw in [serde_json::Value::Null, serde_json::json!("not an object"), serde_json::json!(42)] {
            let info = serde_json::json!({ "total_token_usage": raw, "last_token_usage": { "input_tokens": 10 } });
            if info["total_token_usage"].is_null() { assert!(codex_usage_valid(&info, None)); }
            else { assert!(!codex_usage_valid(&info, None)); }
        }
    }

    /// Malformed duration metadata must not silently select the cheaper legacy rate.
    #[test]
    fn invalid_cache_duration_metadata_is_not_a_valid_five_minute_reference() {
        for duration in [serde_json::json!(-1), serde_json::json!("100"), serde_json::json!(101)] {
            let usage = serde_json::json!({ "cache_creation_input_tokens": 100,
                "cache_creation": { "ephemeral_1h_input_tokens": duration } });
            assert!(!cache_duration_valid(Some(&usage)));
        }
        let inconsistent = serde_json::json!({ "cache_creation_input_tokens": 100,
            "cache_creation": { "ephemeral_5m_input_tokens": 60, "ephemeral_1h_input_tokens": 60 } });
        assert!(!cache_duration_valid(Some(&inconsistent)));
    }

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
