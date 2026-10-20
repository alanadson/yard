use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;

/// Small process-local LRU without retaining a second copy of each value.
pub(crate) struct BoundedCache<K, V> {
    entries: HashMap<K, (u64, V)>,
    capacity: usize,
    tick: u64,
}

impl<K: Eq + Hash + Clone, V> BoundedCache<K, V> {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(capacity > 0);
        Self {
            entries: HashMap::new(),
            capacity,
            tick: 0,
        }
    }

    pub(crate) fn get<Q: ?Sized + Eq + Hash>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.tick = self.tick.saturating_add(1);
        let (used, value) = self.entries.get_mut(key)?;
        *used = self.tick;
        Some(value)
    }

    /// `get` for a caller that changes the value in place.
    pub(crate) fn get_mut<Q: ?Sized + Eq + Hash>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        self.tick = self.tick.saturating_add(1);
        let (used, value) = self.entries.get_mut(key)?;
        *used = self.tick;
        Some(value)
    }

    pub(crate) fn insert(&mut self, key: K, value: V) {
        if self.entries.len() >= self.capacity && !self.entries.contains_key(&key) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (used, _))| used)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.tick = self.tick.saturating_add(1);
        self.entries.insert(key, (self.tick, value));
    }

    /// Takes the entry out and hands it back, so a caller can rebuild it
    /// from the old value instead of cloning it.
    pub(crate) fn remove<Q: ?Sized + Eq + Hash>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        self.entries.remove(key).map(|(_, value)| value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The usage scans rebuild a grown file's entry from the old one: the
    /// entry has to come out of the cache whole, not be cloned and dropped
    /// (it carries every message id the file has seen).
    /// The usage scans slim an idle entry in place; doing so must count as a
    /// use, like `get`, so the entry is not the next one evicted.
    #[test]
    fn get_mut_changes_the_value_in_place_and_counts_as_a_use() {
        let mut cache = BoundedCache::new(2);
        cache.insert("old", 1);
        cache.insert("recent", 2);
        *cache.get_mut(&"old").unwrap() = 10;
        cache.insert("new", 3);
        assert_eq!(cache.get(&"old"), Some(&10));
        assert_eq!(cache.get(&"recent"), None);
    }

    #[test]
    fn remove_hands_back_the_value_it_takes_out() {
        let mut cache = BoundedCache::new(4);
        cache.insert("a", vec![1, 2, 3]);
        assert_eq!(cache.remove(&"a"), Some(vec![1, 2, 3]));
        assert_eq!(cache.get(&"a"), None);
        assert_eq!(cache.remove(&"a"), None);
    }
}
