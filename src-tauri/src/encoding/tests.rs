//! What the four encodings have to get right.
//!
//! Two of them are the ones that actually bite. **UTF-16** is what a lot of
//! Windows tooling still writes, and it is unmistakable from its BOM, so
//! guessing it is safe and not guessing it means the file opens as a wall of
//! NULs. **Windows-1252** cannot be detected at all, which is why it is only
//! ever chosen by hand: it decodes *any* byte sequence, so a heuristic that
//! reached for it would happily "succeed" on a JPEG.
//!
//! The round trip is the rule that carries the most weight. Opening a file in
//! an encoding and saving it back has to leave the bytes as they were, or
//! choosing an encoding becomes a way to quietly rewrite a file.

use super::*;

#[test]
fn a_utf8_file_is_read_as_utf8() {
    let bytes = "olá, mundo".as_bytes().to_vec();

    assert_eq!(detect(&bytes), Encoding::Utf8);
    assert_eq!(decode(&bytes, Encoding::Utf8).unwrap(), "olá, mundo");
}

#[test]
fn a_utf8_bom_is_utf8_and_does_not_reach_the_buffer() {
    // The BOM is metadata; the editor already tracks it separately and puts
    // it back on write. Leaving it in the text puts an invisible character at
    // the start of every such file.
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("olá".as_bytes());

    assert_eq!(detect(&bytes), Encoding::Utf8);
    assert_eq!(decode(&bytes, Encoding::Utf8).unwrap(), "olá");
}

#[test]
fn a_utf16_bom_is_recognised_on_both_sides() {
    let le = vec![0xFF, 0xFE, b'o', 0x00, b'i', 0x00];
    let be = vec![0xFE, 0xFF, 0x00, b'o', 0x00, b'i'];

    assert_eq!(detect(&le), Encoding::Utf16Le);
    assert_eq!(detect(&be), Encoding::Utf16Be);
    assert_eq!(decode(&le, Encoding::Utf16Le).unwrap(), "oi");
    assert_eq!(decode(&be, Encoding::Utf16Be).unwrap(), "oi");
}

#[test]
fn utf16_without_a_bom_is_read_when_it_is_asked_for() {
    // Chosen by hand, not guessed: there is nothing in the bytes to go on.
    let le = vec![b'o', 0x00, b'i', 0x00];

    assert_eq!(decode(&le, Encoding::Utf16Le).unwrap(), "oi");
}

#[test]
fn utf16_carries_the_characters_utf8_would() {
    let text = "olá, mundo … ção";

    let bytes = encode(text, Encoding::Utf16Le);

    assert_eq!(decode(&bytes, Encoding::Utf16Le).unwrap(), text);
}

#[test]
fn utf16_handles_a_character_outside_the_basic_plane() {
    // A surrogate pair: two code units for one character, and the place a
    // hand-written decoder gets it wrong.
    let text = "um 😀 aqui";

    let bytes = encode(text, Encoding::Utf16Be);

    assert_eq!(decode(&bytes, Encoding::Utf16Be).unwrap(), text);
}

#[test]
fn a_lone_surrogate_is_refused_rather_than_guessed() {
    // Half of a pair with no other half. Replacing it silently would write a
    // character the file never had.
    let broken = vec![0x00, 0xD8, b'a', 0x00];

    assert!(decode(&broken, Encoding::Utf16Le).is_none());
}

#[test]
fn an_odd_number_of_bytes_is_not_utf16() {
    assert!(decode(&[b'o', 0x00, b'i'], Encoding::Utf16Le).is_none());
}

#[test]
fn windows_1252_reads_the_accented_bytes_latin1_shares() {
    // 0xE7 0xE3 = "çã" in both Latin-1 and Windows-1252.
    let bytes = vec![b'a', 0xE7, 0xE3, b'o'];

    assert_eq!(decode(&bytes, Encoding::Windows1252).unwrap(), "ação");
}

#[test]
fn windows_1252_is_not_latin1_in_the_c1_range() {
    // The whole reason to name it 1252: 0x80..0x9F are printable characters
    // there and control codes in Latin-1. 0x93 and 0x94 are curly quotes,
    // and they turn up in every document a Windows word processor ever
    // exported.
    let bytes = vec![0x93, b'o', b'i', 0x94, 0x85];

    assert_eq!(decode(&bytes, Encoding::Windows1252).unwrap(), "“oi”…");
}

#[test]
fn windows_1252_reads_any_byte_at_all() {
    // Which is exactly why it is never detected, only chosen.
    let bytes: Vec<u8> = (0u8..=255).collect();

    assert!(decode(&bytes, Encoding::Windows1252).is_some());
}

#[test]
fn a_character_windows_1252_cannot_write_is_refused() {
    // Saving would otherwise drop it, or write a `?` the user never typed.
    assert!(encode_checked("um 😀 aqui", Encoding::Windows1252).is_none());
    assert!(encode_checked("ação", Encoding::Windows1252).is_some());
}

#[test]
fn every_encoding_round_trips_the_text_it_can_hold() {
    // The rule that matters most: opening a file in an encoding and saving it
    // back must leave the bytes as they were, or choosing an encoding becomes
    // a way to quietly rewrite a file.
    for enc in [
        Encoding::Utf8,
        Encoding::Utf16Le,
        Encoding::Utf16Be,
        Encoding::Windows1252,
    ] {
        let text = "ação, “aspas” e um traço";
        let bytes = encode(text, enc);
        assert_eq!(decode(&bytes, enc).unwrap(), text, "round trip in {enc:?}");
    }
}

#[test]
fn a_name_survives_the_trip_to_the_front_end_and_back() {
    for enc in [
        Encoding::Utf8,
        Encoding::Utf16Le,
        Encoding::Utf16Be,
        Encoding::Windows1252,
    ] {
        assert_eq!(Encoding::parse(enc.name()), enc);
    }
}

#[test]
fn an_unknown_name_is_read_as_utf8() {
    // This comes off a stored tab; a name from an older version, or from
    // nobody, must not be a reason to fail to open a file.
    assert_eq!(Encoding::parse("koi8-r"), Encoding::Utf8);
    assert_eq!(Encoding::parse(""), Encoding::Utf8);
}

#[test]
fn utf8_bytes_that_are_not_utf8_are_refused() {
    // The caller decides what to do about it (open lossily, or offer another
    // encoding); this function does not guess.
    assert!(decode(&[0xFF, 0xFE_u8.wrapping_add(1), 0x00], Encoding::Utf8).is_none());
}
