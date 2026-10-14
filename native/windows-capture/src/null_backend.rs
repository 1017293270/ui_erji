use std::sync::mpsc::Sender;

use crate::backend::{Backend, BackendOptions, Input, Started};

pub struct NullBackend;

impl Backend for NullBackend {
    fn start(&mut self, _options: &BackendOptions, _inputs: Sender<Input>) -> Started {
        Started { mic: None, system: None }
    }

    fn stop(&mut self) {}
}
