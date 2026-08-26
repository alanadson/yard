//! Integration with agent CLIs: where they are, what they already ran, how much it cost.

pub mod resolver;
pub mod sessions;
pub mod read;
pub mod tail;

#[cfg(test)]
mod env_tests;
