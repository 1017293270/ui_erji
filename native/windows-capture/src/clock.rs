use std::time::Instant;

use crate::backend::Clock;

pub struct MonotonicClock(Instant);

impl MonotonicClock {
    pub fn new() -> Self { Self(Instant::now()) }
}

impl Clock for MonotonicClock {
    fn now_ns(&self) -> u64 { self.0.elapsed().as_nanos() as u64 }
}
