//! The few fields the usage scans read from one session `.jsonl` line.
//!
//! `costs.rs` and `sessions::usage` used to parse every line into a
//! `serde_json::Value` and then look up four or five keys. A Claude Code line
//! carries the whole tool result or the whole file a `Write` wrote, so almost
//! all of that tree was built only to be thrown away. This reads the same
//! keys straight off the text and skips the rest without building it.
//!
//! The contract is strict equivalence with the `Value` path, because the
//! numbers in "Custos e uso" must not move:
//!
//! - a line parses **exactly** when `serde_json::from_str::<Value>` accepts it
//!   (a line that did not count must keep not counting, and vice versa);
//! - each field is what the old getter chain returned: `v.get("type")
//!   .and_then(Value::as_str)`, `v.get("message").and_then(|m| m.get("usage"))`,
//!   and so on, duplicates resolved the same way (the last key wins);
//! - `usage` and `info` stay `Value`s, so `tokens.rs` reads their numbers
//!   with the very same `as_u64`.
//!
//! Every value, read or skipped, goes through `deserialize_any`, the entry
//! point `Value` itself uses, so serde_json applies the same checks (string
//! escapes, number range, nesting depth) and only the building is left out.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{self, DeserializeOwned, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

/// The line's top level. Each field is `Some` exactly when the old getter
/// found the key; a string field is `None` also when the value was not a
/// string, as `as_str` said.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct UsageLine {
    /// `type`.
    pub(crate) kind: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) cwd: Option<String>,
    /// Present whatever its type: a `message` that is not an object reads
    /// as one with no fields, as `Value::get` on it did.
    pub(crate) message: Option<MessageFields>,
    pub(crate) usage: Option<Value>,
    pub(crate) payload: Option<PayloadFields>,
}

/// `message` of a Claude Code line: the heavy `content` is skipped.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct MessageFields {
    pub(crate) id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) usage: Option<Value>,
}

/// `payload` of a Codex rollout line: a function output is skipped.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct PayloadFields {
    /// `type`.
    pub(crate) kind: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) info: Option<Value>,
}

/// The fields of `line`, or `None` exactly when it is not JSON by
/// `serde_json::Value`'s rules.
pub(crate) fn parse(line: &str) -> Option<UsageLine> {
    serde_json::from_str::<Loose<UsageLine>>(line).ok().map(|l| l.0)
}

// ---------------------------------------------------------------------------
// objects read field by field
// ---------------------------------------------------------------------------

/// An object whose known keys are read and the rest skipped.
trait Fields: Default {
    const NAMES: &'static [&'static str];
    /// Reads the value of `NAMES[field]`, overwriting an earlier duplicate:
    /// `Value`'s map keeps the last one too.
    fn read<'de, A: MapAccess<'de>>(&mut self, field: usize, map: &mut A) -> Result<(), A::Error>;
}

impl Fields for UsageLine {
    const NAMES: &'static [&'static str] = &["type", "timestamp", "cwd", "message", "usage", "payload"];
    fn read<'de, A: MapAccess<'de>>(&mut self, field: usize, map: &mut A) -> Result<(), A::Error> {
        match field {
            0 => self.kind = map.next_value::<LooseStr>()?.0,
            1 => self.timestamp = map.next_value::<LooseStr>()?.0,
            2 => self.cwd = map.next_value::<LooseStr>()?.0,
            3 => self.message = Some(map.next_value::<Loose<MessageFields>>()?.0),
            4 => self.usage = Some(map.next_value::<Value>()?),
            _ => self.payload = Some(map.next_value::<Loose<PayloadFields>>()?.0),
        }
        Ok(())
    }
}

impl Fields for MessageFields {
    const NAMES: &'static [&'static str] = &["id", "model", "usage"];
    fn read<'de, A: MapAccess<'de>>(&mut self, field: usize, map: &mut A) -> Result<(), A::Error> {
        match field {
            0 => self.id = map.next_value::<LooseStr>()?.0,
            1 => self.model = map.next_value::<LooseStr>()?.0,
            _ => self.usage = Some(map.next_value::<Value>()?),
        }
        Ok(())
    }
}

impl Fields for PayloadFields {
    const NAMES: &'static [&'static str] = &["type", "cwd", "model", "info"];
    fn read<'de, A: MapAccess<'de>>(&mut self, field: usize, map: &mut A) -> Result<(), A::Error> {
        match field {
            0 => self.kind = map.next_value::<LooseStr>()?.0,
            1 => self.cwd = map.next_value::<LooseStr>()?.0,
            2 => self.model = map.next_value::<LooseStr>()?.0,
            _ => self.info = Some(map.next_value::<Value>()?),
        }
        Ok(())
    }
}

/// serde_json's private marker for a raw value. A dependency turns on its
/// `raw_value` feature, and with it on, `Value` reads an object whose *first*
/// key is this marker as "the JSON inside this string" (and fails the line
/// when the value is not a string of valid JSON, or when a second key
/// follows). The typed path mirrors that so the two never disagree; the
/// test `a_line_parses_exactly_when_serde_json_value_accepts_it` notices if
/// a serde_json upgrade renames the marker.
const RAW_VALUE_MARKER: &str = "$serde_json::private::RawValue";

/// A key sorted into "the marker", "field `i`" or "anything else", read
/// without allocating.
enum Key {
    Marker,
    Field(usize),
    Other,
}

struct KeyOf(&'static [&'static str]);

impl<'de> DeserializeSeed<'de> for KeyOf {
    type Value = Key;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Key, D::Error> {
        // `Value` classifies its keys through `deserialize_str` as well.
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for KeyOf {
    type Value = Key;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a string key")
    }
    fn visit_str<E: de::Error>(self, key: &str) -> Result<Key, E> {
        Ok(if key == RAW_VALUE_MARKER {
            Key::Marker
        } else {
            self.0.iter().position(|name| *name == key).map_or(Key::Other, Key::Field)
        })
    }
}

/// Walks an object the way `Value` does: the marker only counts as the
/// first key, and then its string is parsed as the value `T` stands for.
/// `Ok(Some(t))` is that embedded value; `Ok(None)` means every entry went
/// through `field` (known keys) or was skipped.
fn walk_map<'de, A, T>(
    map: &mut A,
    names: &'static [&'static str],
    mut field: impl FnMut(usize, &mut A) -> Result<(), A::Error>,
) -> Result<Option<T>, A::Error>
where
    A: MapAccess<'de>,
    T: DeserializeOwned,
{
    let mut first = true;
    while let Some(key) = map.next_key_seed(KeyOf(names))? {
        match key {
            Key::Marker if first => return map.next_value_seed(Embedded::<T>(PhantomData)).map(Some),
            Key::Field(i) => field(i, map)?,
            Key::Marker | Key::Other => {
                map.next_value::<Skip>()?;
            }
        }
        first = false;
    }
    Ok(None)
}

/// The string after the raw-value marker, parsed as `T` on its own, as
/// `Value` re-parses it.
struct Embedded<T>(PhantomData<T>);

impl<'de, T: DeserializeOwned> DeserializeSeed<'de> for Embedded<T> {
    type Value = T;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<T, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de, T: DeserializeOwned> Visitor<'de> for Embedded<T> {
    type Value = T;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("raw value")
    }
    fn visit_str<E: de::Error>(self, text: &str) -> Result<T, E> {
        serde_json::from_str(text).map_err(E::custom)
    }
}

/// Generates the scalar arms every lenient visitor shares: JSON's
/// `deserialize_any` only ever calls these, plus `visit_str`, `visit_seq`
/// and `visit_map`.
macro_rules! scalars_are {
    ($value:expr) => {
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($value)
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok($value)
        }
    };
}

/// `T`'s fields when the value is an object, `T::default()` when it is
/// anything else (every getter on a non-object said `None`).
struct Loose<T>(T);

impl<'de, T: Fields + 'static> Deserialize<'de> for Loose<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(LooseVisitor(PhantomData))
    }
}

struct LooseVisitor<T>(PhantomData<T>);

impl<'de, T: Fields + 'static> Visitor<'de> for LooseVisitor<T> {
    type Value = Loose<T>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    scalars_are!(Loose(T::default()));
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(Loose(T::default()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Self::Value, A::Error> {
        drain_seq(seq)?;
        Ok(Loose(T::default()))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut out = T::default();
        let embedded = walk_map::<A, Loose<T>>(&mut map, T::NAMES, |i, map| out.read(i, map))?;
        Ok(embedded.unwrap_or(Loose(out)))
    }
}

/// `Some` for a string, `None` for any other value: `Value::as_str`.
struct LooseStr(Option<String>);

impl<'de> Deserialize<'de> for LooseStr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(LooseStrVisitor)
    }
}

struct LooseStrVisitor;

impl<'de> Visitor<'de> for LooseStrVisitor {
    type Value = LooseStr;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    scalars_are!(LooseStr(None));
    fn visit_str<E: de::Error>(self, text: &str) -> Result<LooseStr, E> {
        Ok(LooseStr(Some(text.to_owned())))
    }
    fn visit_string<E: de::Error>(self, text: String) -> Result<LooseStr, E> {
        Ok(LooseStr(Some(text)))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<LooseStr, A::Error> {
        drain_seq(seq)?;
        Ok(LooseStr(None))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<LooseStr, A::Error> {
        let embedded = walk_map::<A, LooseStr>(&mut map, &[], |_, _| Ok(()))?;
        Ok(embedded.unwrap_or(LooseStr(None)))
    }
}

/// Any value, checked as `Value` would check it and then dropped: no
/// string, vector or map is ever allocated for it.
struct Skip;

impl<'de> Deserialize<'de> for Skip {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(SkipVisitor)
    }
}

struct SkipVisitor;

impl<'de> Visitor<'de> for SkipVisitor {
    type Value = Skip;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    scalars_are!(Skip);
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Skip, E> {
        Ok(Skip)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<Skip, A::Error> {
        drain_seq(seq)?;
        Ok(Skip)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Skip, A::Error> {
        walk_map::<A, Skip>(&mut map, &[], |_, _| Ok(()))?;
        Ok(Skip)
    }
}

fn drain_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> Result<(), A::Error> {
    while seq.next_element::<Skip>()?.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// What the old code read from a line, through `Value` getters: the
    /// oracle every parsed line is held against.
    fn through_value(line: &str) -> Option<UsageLine> {
        let v: Value = serde_json::from_str(line).ok()?;
        let text = |o: &Value, key: &str| o.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(UsageLine {
            kind: text(&v, "type"),
            timestamp: text(&v, "timestamp"),
            cwd: text(&v, "cwd"),
            message: v.get("message").map(|m| MessageFields {
                id: text(m, "id"),
                model: text(m, "model"),
                usage: m.get("usage").cloned(),
            }),
            usage: v.get("usage").cloned(),
            payload: v.get("payload").map(|p| PayloadFields {
                kind: text(p, "type"),
                cwd: text(p, "cwd"),
                model: text(p, "model"),
                info: p.get("info").cloned(),
            }),
        })
    }

    fn nested(depth: usize) -> String {
        format!(r#"{{"type":"user","message":{{"content":{}{}}}}}"#, "[".repeat(depth), "]".repeat(depth))
    }

    /// Skipping a value with serde's `IgnoredAny` would be cheaper still, but
    /// serde_json skips such values with a laxer scanner: it takes a lone
    /// surrogate escape (which a tool output cut mid-emoji produces), a
    /// `1e999` or a nesting past the depth limit, all of which `Value`
    /// refuses. A line the old code dropped must stay dropped.
    #[test]
    fn a_line_parses_exactly_when_serde_json_value_accepts_it() {
        let raw = "$serde_json::private::RawValue";
        let lines = vec![
            r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":1}}}"#.to_string(),
            "not json".to_string(),
            "".to_string(),
            "   ".to_string(),
            "[1,2]".to_string(),
            r#""just a string""#.to_string(),
            "5".to_string(),
            "null".to_string(),
            r#"{"a":1} x"#.to_string(),
            r#"{"a":1}   "#.to_string(),
            r#"{"a":1}}"#.to_string(),
            r#"{"type":"user","message":{"content":"\ud800"}}"#.to_string(),
            r#"{"type":"user","message":{"content":"\udc00 tail"}}"#.to_string(),
            r#"{"type":"user","message":{"content":"\ud83d\ude00 ok"}}"#.to_string(),
            r#"{"type":"user","message":{"content":"bad \q escape"}}"#.to_string(),
            "{\"type\":\"user\",\"message\":{\"content\":\"raw \u{1} control\"}}".to_string(),
            r#"{"type":"user","message":{"content":[1e999]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[-1e999]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[1e300, 18446744073709551616, -0]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[01]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[1.]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[tru]}}"#.to_string(),
            r#"{"type":"user","message":{"content":[1,]}}"#.to_string(),
            r#"{"type":"user","message":{"content":{"a":1,}}}"#.to_string(),
            r#"{"type":"user","message":{"content":{1:2}}}"#.to_string(),
            r#"{"usage":{"input_tokens":1e999}}"#.to_string(),
            nested(125),
            nested(126),
            nested(127),
            nested(200),
            format!(r#"{{"x":{{"{raw}":"[1]"}}}}"#),
            format!(r#"{{"x":{{"{raw}":"[1"}}}}"#),
            format!(r#"{{"x":{{"{raw}":5}}}}"#),
            format!(r#"{{"x":{{"{raw}":"1","y":2}}}}"#),
            format!(r#"{{"x":{{"a":1,"{raw}":5}}}}"#),
            format!(r#"{{"x":[{{"{raw}":"\"\\ud800\""}}]}}"#),
            format!(r#"{{"{raw}":"{{}}"}}"#),
            format!(r#"{{"{raw}":"{{\"type\":1}} x"}}"#),
            format!(r#"{{"type":{{"{raw}":"[1e999]"}}}}"#),
            format!(r#"{{"message":{{"{raw}":"{{\"content\":\"\\ud800\"}}"}}}}"#),
            r#"{"type":"a","type":"b","message":{"id":"1"},"message":{"id":"2"}}"#.to_string(),
        ];
        for line in &lines {
            assert_eq!(
                parse(line).is_some(),
                serde_json::from_str::<Value>(line).is_ok(),
                "{line}"
            );
        }
    }

    /// Every field, on lines built to trip a typed parser: values of the
    /// wrong type (the old `as_str` said `None`, a derive would have failed
    /// the whole line), a `message` that is not an object, duplicated keys
    /// and serde_json's raw-value marker, which `Value` expands in place.
    #[test]
    fn each_field_is_what_the_value_getters_returned() {
        let raw = "$serde_json::private::RawValue";
        let lines = vec![
            r#"{"type":"assistant","timestamp":"2026-08-26T10:00:00Z","cwd":"C:\\p","message":{"id":"m1","model":"claude-opus-5","content":[{"type":"text","text":"oi"}],"usage":{"input_tokens":1,"output_tokens":2}}}"#.to_string(),
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3}}}}"#.to_string(),
            r#"{"type":"session_meta","payload":{"id":"s","cwd":"C:\\repo","model":"gpt-5","info":null}}"#.to_string(),
            r#"{"type":5,"timestamp":{},"cwd":[1],"message":"text","usage":7,"payload":"x"}"#.to_string(),
            r#"{"type":null,"message":[{"id":"m1"}],"payload":null,"usage":null}"#.to_string(),
            r#"{"message":{"id":7,"model":false,"usage":"many"}}"#.to_string(),
            r#"{"message":{"usage":null}}"#.to_string(),
            r#"{"type":"user","type":"assistant","message":{"id":"a"},"message":{"id":"b","usage":{}}}"#.to_string(),
            r#"{"message":{"id":"a","usage":{"input_tokens":1}},"message":7}"#.to_string(),
            r#"{"usage":{"input_tokens":1},"usage":{"output_tokens":2}}"#.to_string(),
            r#"{"payload":{"info":{"a":1},"info":null,"type":"x","type":3}}"#.to_string(),
            r#"{"Type":"assistant","MESSAGE":{"id":"m"}}"#.to_string(),
            r#"{"message":{"content":{"id":"nested, not the message id","usage":{"input_tokens":9}}}}"#.to_string(),
            r#"{"type":"assistant\u0021","cwd":"C:\\caf\u00e9"}"#.to_string(),
            "[{\"type\":\"assistant\"}]".to_string(),
            "\"assistant\"".to_string(),
            "{}".to_string(),
            format!(r#"{{"type":{{"{raw}":"\"assistant\""}}}}"#),
            format!(r#"{{"type":{{"{raw}":"5"}}}}"#),
            format!(r#"{{"message":{{"{raw}":"{{\"id\":\"m1\",\"usage\":{{\"input_tokens\":1}}}}"}}}}"#),
            format!(r#"{{"message":{{"{raw}":"[1]"}}}}"#),
            format!(r#"{{"{raw}":"{{\"type\":\"assistant\",\"cwd\":\"C:\\\\x\"}}"}}"#),
            format!(r#"{{"{raw}":"\"not an object\""}}"#),
            format!(r#"{{"usage":{{"{raw}":"{{\"input_tokens\":4}}"}}}}"#),
            format!(r#"{{"message":{{"a":1,"{raw}":"{{\"id\":\"x\"}}"}}}}"#),
            format!(r#"{{"payload":{{"{raw}":"{{\"type\":\"token_count\",\"info\":{{\"last_token_usage\":{{}}}}}}"}}}}"#),
        ];
        for line in &lines {
            let expected = through_value(line);
            assert!(expected.is_some(), "the fixture must be valid JSON: {line}");
            assert_eq!(parse(line), expected, "{line}");
        }
    }
}
