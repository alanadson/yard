//! User-supplied rates are explicit overrides, separate from the checked API reference.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRate {
    pub model: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write_five_minute: f64,
    pub cache_write_one_hour: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingSettings {
    pub revision: u64,
    pub rates: Vec<CustomRate>,
}

const SETTINGS_KEY: &str = "pricing.customRates.v1";

fn runtime_settings() -> &'static parking_lot::RwLock<PricingSettings> {
    static SETTINGS: std::sync::OnceLock<parking_lot::RwLock<PricingSettings>> = std::sync::OnceLock::new();
    SETTINGS.get_or_init(|| parking_lot::RwLock::new(PricingSettings::default()))
}

pub(crate) fn current() -> PricingSettings { runtime_settings().read().clone() }
pub(crate) fn publish(settings: PricingSettings) { *runtime_settings().write() = settings; }

pub fn load(connection: &rusqlite::Connection) -> Result<PricingSettings, String> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = connection.query_row("SELECT value FROM kv WHERE key = ?1", [SETTINGS_KEY], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    let settings: PricingSettings = raw.map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
        .unwrap_or_else(|| Ok(PricingSettings::default()))?;
    validate_rates(&settings.rates)?;
    Ok(settings)
}

pub fn save(connection: &mut rusqlite::Connection, revision: u64, rates: Vec<CustomRate>) -> Result<PricingSettings, String> {
    validate_rates(&rates)?;
    let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let current = load(&transaction)?;
    if current.revision != revision { return Err("STALE_PRICING_REVISION".into()); }
    let settings = PricingSettings { revision: revision.checked_add(1).ok_or("PRICING_REVISION_OVERFLOW")?, rates };
    let value = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    crate::persistence::db::kv_set(&transaction, SETTINGS_KEY, &value).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(settings)
}

fn validate_rates(rates: &[CustomRate]) -> Result<(), String> {
    let mut models = std::collections::HashSet::new();
    if rates.len() > 200 { return Err("INVALID_CUSTOM_RATES".into()); }
    for rate in rates {
        let values = [rate.input, rate.output, rate.cache_read, rate.cache_write_five_minute, rate.cache_write_one_hour];
        if rate.model.is_empty() || rate.model.len() > 160
            || !rate.model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/".contains(&byte))
            || !models.insert(rate.model.to_ascii_lowercase())
            || values.iter().any(|value| !value.is_finite() || *value < 0.0 || *value > 1_000_000.0) {
            return Err("INVALID_CUSTOM_RATES".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        connection
    }

    fn rate() -> CustomRate {
        CustomRate { model: "claude-sonnet-5-5".into(), input: 1.0, output: 3.0,
            cache_read: 0.2, cache_write_five_minute: 1.5, cache_write_one_hour: 2.5 }
    }

    /// Custom prices must survive reload without overwriting the official reference table.
    #[test]
    fn saved_custom_rates_survive_a_database_reload_with_their_revision() {
        let mut connection = connection();
        let saved = save(&mut connection, 0, vec![rate()]).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(load(&connection).unwrap(), saved);
        assert_eq!(saved.rates, vec![rate()]);
    }

    #[test]
    fn a_stale_price_editor_cannot_replace_the_newer_saved_rates() {
        let mut connection = connection();
        let saved = save(&mut connection, 0, vec![rate()]).unwrap();
        assert_eq!(save(&mut connection, 0, Vec::new()).unwrap_err(), "STALE_PRICING_REVISION");
        assert_eq!(load(&connection).unwrap(), saved);
        let reset = save(&mut connection, saved.revision, Vec::new()).unwrap();
        assert_eq!(reset.revision, 2);
        assert!(load(&connection).unwrap().rates.is_empty());
    }

    #[test]
    fn invalid_custom_rates_never_replace_the_last_acknowledged_settings() {
        let mut connection = connection();
        let saved = save(&mut connection, 0, vec![rate()]).unwrap();
        let mut invalid = Vec::new();
        for value in [-1.0, f64::NAN, f64::INFINITY, 1_000_001.0] {
            let mut candidate = rate(); candidate.input = value; invalid.push(vec![candidate]);
        }
        for model in ["", "model\nname"] {
            let mut candidate = rate(); candidate.model = model.into(); invalid.push(vec![candidate]);
        }
        invalid.push(vec![rate(), rate()]);
        for candidate in invalid {
            assert_eq!(save(&mut connection, saved.revision, candidate).unwrap_err(), "INVALID_CUSTOM_RATES");
            assert_eq!(load(&connection).unwrap(), saved);
        }
    }

    #[test]
    fn malformed_saved_rates_are_reported_without_rewriting_the_stored_document() {
        let connection = connection();
        let mut invalid = rate(); invalid.output = -2.0;
        let raw = serde_json::to_string(&PricingSettings { revision: 4, rates: vec![invalid] }).unwrap();
        crate::persistence::db::kv_set(&connection, SETTINGS_KEY, &raw).unwrap();
        assert_eq!(load(&connection).unwrap_err(), "INVALID_CUSTOM_RATES");
        assert_eq!(crate::persistence::db::kv_get(&connection, SETTINGS_KEY), Some(raw));
    }
}
