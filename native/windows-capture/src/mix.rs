/// Averages L/R, ignoring wider channels so a mic on a wide interface is not diluted.
pub fn mix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels == 0 { return Vec::new(); }
    let used = channels.min(2);
    interleaved.chunks_exact(channels)
        .map(|frame| frame[..used].iter().sum::<f32>() / used as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_only_the_first_two_channels() {
        assert_eq!(mix_to_mono(&[0.2, -0.4], 1), vec![0.2, -0.4]);
        assert_eq!(mix_to_mono(&[1.0, -1.0, 0.5, 0.25], 2), vec![0.0, 0.375]);
        assert_eq!(mix_to_mono(&[0.5, 0.25, 9.0, 9.0, -1.0, 1.0, 9.0, 9.0], 4), vec![0.375, 0.0]);
        assert!(mix_to_mono(&[], 0).is_empty());
    }
}
