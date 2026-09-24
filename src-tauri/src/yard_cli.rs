//! The `yard` CLI client: the program `yard.cmd` and the `yard` sh shim in
//! `<data>\bin` run for every `yard` call and every Claude Code hook.
//!
//! It replaces a hop through Windows PowerShell 5.1 (`yard.ps1`), whose cold
//! start alone took 0.5 to 0.7 s, paid by every tool call, prompt and turn end
//! of every agent, because Claude Code waits for its hooks. This one starts in
//! milliseconds.
//!
//! The contract is `yard.ps1`'s, down to what an agent can observe: arguments
//! split the way powershell.exe split them, `--timeout` read the way
//! `[double]` read it, `--file`/`--stdin` rewritten in the same order, the same
//! messages and exit codes. Where the PowerShell client was wrong, this one is
//! not: it decoded piped input and encoded its output in the console's code
//! page (850 on a Brazilian Windows), so a UTF-8 hook payload with an accent
//! reached the app mangled and an accented reply reached the agent as invalid
//! UTF-8. Here standard output and `--file` are UTF-8, and standard input is
//! UTF-8 whenever it is valid UTF-8 or carries a byte order mark; any other
//! input is still read in the console's code page, which is right for what
//! cmd.exe's `echo` and older console tools write into a pipe. Nor
//! does it copy what PowerShell's `-File` parameter binder did to some
//! arguments before `yard.ps1` saw them: a lone `-` killed the script, `-x:`
//! vanished, `-note: text` became `-note` and ` text`, `--%` was dropped.
//! Every argument arrives as the command line split it.
//!
//! Built twice from this one file: `build.rs` compiles it with a bare `rustc`
//! into a console exe (hence std only, no crates and no crate-level
//! attributes), and the lib includes it as `bridge::cli` for its tests and
//! for the probe constants. `yard.ps1` stays on disk as the fallback the
//! bridge points the shims at when this exe cannot run on the machine.

use std::io::{self, BufRead, Read, Write};

/// The sole argument that makes the exe print `PROBE_TOKEN` and exit 0 before
/// anything else: how the bridge checks that the exe runs on this machine at
/// all (an antivirus or Smart App Control may block an unsigned program).
pub const PROBE_FLAG: &str = "--yard-cli-probe";
pub const PROBE_TOKEN: &str = "yard-cli ok";

/// `NamedPipeClientStream.Connect(4000)`: how long the app's pipe may take to
/// appear or to have a free instance.
pub const CONNECT_TIMEOUT_MS: u64 = 4000;

const DEFAULT_TIMEOUT_MS: i32 = 180_000;
/// `ask`, `recruit` and `wait` block on another agent; the server caps it.
const LONG_VERB_TIMEOUT_MS: i32 = 600_000;

/// `ERROR_PIPE_BUSY`: every instance of the pipe is serving someone.
const ERROR_PIPE_BUSY: i32 = 231;
/// `ERROR_INVALID_NAME`: what Windows answers for `a*b` or `a?b`, which
/// `Test-Path` reported as simply absent.
const ERROR_INVALID_NAME: i32 = 123;

/// What goes to the app: the request line minus the caller's identity.
#[derive(Debug, PartialEq)]
pub struct Request {
    pub argv: Vec<String>,
    pub stdin: Option<String>,
    pub timeout_ms: i32,
}

/// A way out before the app is asked anything: the exit code and the line
/// for standard error.
#[derive(Debug, PartialEq)]
pub struct Exit {
    pub code: i32,
    pub message: String,
}

/// What reading a `--file` path came to.
pub enum FileText {
    Text(String),
    /// `Test-Path` said no: exit 2, "arquivo nao encontrado".
    Missing,
    /// It exists but cannot be read (a folder, a locked file): exit 1.
    Unreadable(String),
}

/// What the app answered.
#[derive(Debug, PartialEq)]
pub struct Reply {
    pub output: Option<String>,
    pub code: i32,
}

// ---------------------------------------------------------------------------
// the command line
// ---------------------------------------------------------------------------

fn is_blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// The script's arguments out of the process's whole command line, split the
/// way powershell.exe split the line `yard.cmd` handed it (the rules of
/// `CommandLineToArgvW`). They part from Rust's own `std::env::args` in one
/// place: inside quotes, `""` is a literal quote that also ends the quoted
/// run. The program path has its own rule: it ends at the next quote when it
/// starts with one, else at the first blank.
pub fn script_args(command_line: &str) -> Vec<String> {
    let chars: Vec<char> = command_line.chars().collect();
    let mut i = 0;
    if chars.first() == Some(&'"') {
        i = 1;
        while i < chars.len() {
            i += 1;
            if chars[i - 1] == '"' {
                break;
            }
        }
    } else {
        while i < chars.len() && !is_blank(chars[i]) {
            i += 1;
        }
    }
    while i < chars.len() && is_blank(chars[i]) {
        i += 1;
    }

    let mut args = Vec::new();
    if i >= chars.len() {
        return args;
    }
    let mut arg = String::new();
    // 0 outside quotes, 1 inside; 2 and 3 only while counting a run of quotes.
    let mut quotes = 0;
    let mut backslashes = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_blank(c) && quotes == 0 {
            args.push(std::mem::take(&mut arg));
            while i < chars.len() && is_blank(chars[i]) {
                i += 1;
            }
            if i >= chars.len() {
                return args;
            }
            backslashes = 0;
        } else if c == '\\' {
            arg.push('\\');
            backslashes += 1;
            i += 1;
        } else if c == '"' {
            if backslashes % 2 == 0 {
                // An even run of backslashes before a quote: half of them
                // stay, and the quote opens or closes a quoted run.
                for _ in 0..backslashes / 2 {
                    arg.pop();
                }
                quotes += 1;
            } else {
                // An odd run: half stay, the last one makes the quote literal.
                for _ in 0..backslashes / 2 + 1 {
                    arg.pop();
                }
                arg.push('"');
            }
            i += 1;
            backslashes = 0;
            while i < chars.len() && chars[i] == '"' {
                quotes += 1;
                if quotes == 3 {
                    arg.push('"');
                    quotes = 0;
                }
                i += 1;
            }
            if quotes == 2 {
                quotes = 0;
            }
        } else {
            arg.push(c);
            backslashes = 0;
            i += 1;
        }
    }
    args.push(arg);
    args
}

// ---------------------------------------------------------------------------
// --timeout: `[int]([double]$s * 1000)`
// ---------------------------------------------------------------------------

/// `[int]([double]$text * 1000)` as Windows PowerShell 5.1 computed it, or
/// `None` where that cast threw (which ended the PowerShell client with exit 1).
pub fn seconds_to_ms(text: &str) -> Option<i32> {
    dotnet_int(dotnet_double(text)? * 1000.0)
}

/// `[double]` over a string: `Double.Parse` with the invariant culture,
/// leading and trailing white space, a leading sign, a decimal point, an
/// exponent and thousands separators (`,`, only among the integer digits and
/// only after the first one). PowerShell alone turns `""` into 0.
fn dotnet_double(text: &str) -> Option<f64> {
    if text.is_empty() {
        return Some(0.0);
    }
    let body = text.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r'));
    let mut chars = body.chars().peekable();
    let mut plain = String::new();
    if let Some(&sign @ ('+' | '-')) = chars.peek() {
        plain.push(sign);
        chars.next();
    }
    let mut digits = 0;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            plain.push(c);
            digits += 1;
        } else if c != ',' || digits == 0 {
            break;
        }
        chars.next();
    }
    if chars.peek() == Some(&'.') {
        plain.push('.');
        chars.next();
        while let Some(&c) = chars.peek().filter(|c| c.is_ascii_digit()) {
            plain.push(c);
            digits += 1;
            chars.next();
        }
    }
    if digits == 0 {
        return None;
    }
    if let Some(&('e' | 'E')) = chars.peek() {
        plain.push('e');
        chars.next();
        if let Some(&sign @ ('+' | '-')) = chars.peek() {
            plain.push(sign);
            chars.next();
        }
        let mut exponent_digits = 0;
        while let Some(&c) = chars.peek().filter(|c| c.is_ascii_digit()) {
            plain.push(c);
            exponent_digits += 1;
            chars.next();
        }
        if exponent_digits == 0 {
            return None;
        }
    }
    if chars.next().is_some() {
        return None;
    }
    // Out of range is an `OverflowException` in .NET, not infinity.
    plain.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `Convert.ToInt32(double)`: halves round to even, and anything that rounds
/// outside `Int32` is an overflow.
fn dotnet_int(value: f64) -> Option<i32> {
    if value >= 0.0 {
        if value < 2_147_483_647.5 {
            let whole = value.trunc();
            let rest = value - whole;
            let mut result = whole as i64;
            if rest > 0.5 || (rest == 0.5 && result & 1 != 0) {
                result += 1;
            }
            return Some(result as i32);
        }
    } else if value >= -2_147_483_648.5 {
        let whole = value.trunc();
        let rest = value - whole;
        let mut result = whole as i64;
        if rest < -0.5 || (rest == -0.5 && result & 1 != 0) {
            result -= 1;
        }
        return Some(result as i32);
    }
    None
}

// ---------------------------------------------------------------------------
// the argument plan
// ---------------------------------------------------------------------------

/// `-eq` between strings in PowerShell ignores case.
fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// `yard.ps1`'s two loops over its arguments, in its order, so the errors
/// come out in the same precedence: every `--timeout` first (a bad one is
/// exit 1 before any file or input is touched), then the ten-minute floor
/// for `ask`/`recruit`/`wait`, then `--file` and `--stdin` left to right.
/// `--file <path>` becomes `--stdin` with the file's text; `--stdin` reads
/// standard input once, and only while no text has been set yet.
pub fn plan(
    args: &[String],
    home: Option<&str>,
    mut read_file: impl FnMut(&str) -> FileText,
    mut read_stdin: impl FnMut() -> String,
) -> Result<Request, Exit> {
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    for (i, arg) in args.iter().enumerate() {
        if let (true, Some(value)) = (same(arg, "--timeout"), args.get(i + 1)) {
            timeout_ms = seconds_to_ms(value).ok_or_else(|| Exit {
                code: 1,
                message: format!("yard: valor invalido para --timeout: {value}"),
            })?;
        }
    }
    if args
        .first()
        .is_some_and(|verb| ["ask", "recruit", "wait"].iter().any(|long| same(verb, long)))
    {
        timeout_ms = timeout_ms.max(LONG_VERB_TIMEOUT_MS);
    }

    let mut stdin = None;
    let mut argv = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if same(arg, "--file") && i + 1 < args.len() {
            stdin = Some(file_text(&args[i + 1], home, &mut read_file)?);
            argv.push("--stdin".to_string());
            i += 2;
            continue;
        }
        if same(arg, "--stdin") {
            if stdin.is_none() {
                stdin = Some(read_stdin());
            }
            argv.push("--stdin".to_string());
        } else {
            argv.push(arg.clone());
        }
        i += 1;
    }
    Ok(Request { argv, stdin, timeout_ms })
}

/// `Test-Path -LiteralPath $p` and then `ReadAllText(Resolve-Path $p)`.
fn file_text(
    path: &str,
    home: Option<&str>,
    read_file: &mut impl FnMut(&str) -> FileText,
) -> Result<String, Exit> {
    // `Test-Path` threw on these instead of answering: exit 1, not 2.
    if path.is_empty() {
        return Err(Exit { code: 1, message: "yard: caminho vazio em --file".to_string() });
    }
    if path.chars().any(|c| matches!(c, '"' | '<' | '>' | '|') || c < ' ') {
        return Err(Exit { code: 1, message: format!("yard: caminho invalido em --file: {path}") });
    }
    // The FileSystem provider reads `~` as the user profile.
    let resolved = match (home, path.strip_prefix('~')) {
        (Some(home), Some(rest)) if rest.is_empty() || rest.starts_with(['\\', '/']) => {
            format!("{home}{rest}")
        }
        _ => path.to_string(),
    };
    match read_file(&resolved) {
        FileText::Text(text) => Ok(text),
        FileText::Missing => Err(Exit { code: 2, message: format!("yard: arquivo nao encontrado: {path}") }),
        FileText::Unreadable(reason) => Err(Exit {
            code: 1,
            message: format!("yard: nao consegui ler o arquivo {path} ({reason})"),
        }),
    }
}

// ---------------------------------------------------------------------------
// the request line
// ---------------------------------------------------------------------------

fn push_json_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn push_json_optional(out: &mut String, text: Option<&str>) {
    match text {
        Some(text) => push_json_string(out, text),
        None => out.push_str("null"),
    }
}

/// The one JSON line the server reads (without its line break): the fields
/// `yard.ps1` sent. The server looks them up by name, so their order is free.
pub fn encode_request(terminal: Option<&str>, cwd: &str, request: &Request) -> String {
    let mut out = String::with_capacity(96 + request.stdin.as_ref().map_or(0, |s| s.len()));
    out.push_str("{\"v\":1,\"terminal\":");
    push_json_optional(&mut out, terminal);
    out.push_str(",\"cwd\":");
    push_json_string(&mut out, cwd);
    out.push_str(",\"argv\":[");
    for (i, arg) in request.argv.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_json_string(&mut out, arg);
    }
    out.push_str("],\"stdin\":");
    push_json_optional(&mut out, request.stdin.as_deref());
    out.push_str(",\"timeoutMs\":");
    out.push_str(&request.timeout_ms.to_string());
    out.push('}');
    out
}

// ---------------------------------------------------------------------------
// the reply line: just enough JSON to read `output` and `code`
// ---------------------------------------------------------------------------

/// Only what the reply needs: arrays and booleans are checked and dropped.
enum Json {
    Null,
    Num(f64),
    Str(String),
    Obj(Vec<(String, Json)>),
    Other,
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn error(&self) -> String {
        format!("JSON invalido na posicao {}", self.at)
    }

    fn skip_blanks(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(self.error())
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_blanks();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.word("true", Json::Other),
            Some(b'f') => self.word("false", Json::Other),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.error()),
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error())
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect(b'{')?;
        let mut fields = Vec::new();
        self.skip_blanks();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.skip_blanks();
            let key = self.string()?;
            self.skip_blanks();
            self.expect(b':')?;
            let value = self.value()?;
            fields.push((key, value));
            self.skip_blanks();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Json::Obj(fields));
                }
                _ => return Err(self.error()),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect(b'[')?;
        self.skip_blanks();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Json::Other);
        }
        loop {
            self.value()?;
            self.skip_blanks();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Other);
                }
                _ => return Err(self.error()),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.error()),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(self.error());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(self.error());
            }
        }
        self.text[start..self.at].parse().map(Json::Num).map_err(|_| self.error())
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            // Stops only on ASCII bytes, so the slice stays on char boundaries.
            let start = self.at;
            while matches!(self.peek(), Some(b) if b != b'"' && b != b'\\' && b >= b' ') {
                self.at += 1;
            }
            out.push_str(&self.text[start..self.at]);
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    self.escape(&mut out)?;
                }
                _ => return Err(self.error()),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self.text.get(self.at..self.at + 4).ok_or_else(|| self.error())?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(self.error());
        }
        self.at += 4;
        u32::from_str_radix(digits, 16).map_err(|_| self.error())
    }

    fn escape(&mut self, out: &mut String) -> Result<(), String> {
        let byte = self.peek().ok_or_else(|| self.error())?;
        self.at += 1;
        match byte {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{8}'),
            b'f' => out.push('\u{c}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
                let unit = self.hex4()?;
                if (0xD800..0xDC00).contains(&unit) && self.text[self.at..].starts_with("\\u") {
                    let partner_at = self.at;
                    self.at += 2;
                    let low = self.hex4()?;
                    if (0xDC00..0xE000).contains(&low) {
                        let joined = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                        out.push(char::from_u32(joined).unwrap_or('\u{fffd}'));
                        return Ok(());
                    }
                    // Not its partner: that escape is read again on its own.
                    self.at = partner_at;
                }
                // A lone surrogate cannot be text.
                out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
            }
            _ => return Err(self.error()),
        }
        Ok(())
    }
}

/// `$res = $line | ConvertFrom-Json`, then `if ($res.output)` and
/// `exit [int]$res.code`: an empty or absent output prints nothing, an absent
/// code is `[int]$null`, zero, and PowerShell's property reads ignore case.
pub fn decode_reply(line: &str) -> Result<Reply, String> {
    let mut parser = Parser { text: line, at: 0 };
    let value = parser.value()?;
    parser.skip_blanks();
    if parser.at != line.len() {
        return Err(parser.error());
    }
    let Json::Obj(fields) = value else {
        return Ok(Reply { output: None, code: 0 });
    };
    let field = |name: &str| {
        fields.iter().rev().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, v)| v)
    };
    let output = match field("output") {
        Some(Json::Str(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    };
    let code = match field("code") {
        None | Some(Json::Null) => 0,
        Some(Json::Num(n)) => {
            dotnet_int(*n).ok_or_else(|| format!("codigo de saida fora do intervalo: {n}"))?
        }
        Some(_) => return Err("codigo de saida que nao e numero".to_string()),
    };
    Ok(Reply { output, code })
}

// ---------------------------------------------------------------------------
// text in
// ---------------------------------------------------------------------------

fn decode_units(bytes: &[u8], width: usize, unit: fn(&[u8]) -> u32) -> String {
    let chunks = bytes.chunks_exact(width);
    let dangling = !chunks.remainder().is_empty();
    let mut text = if width == 2 {
        char::decode_utf16(chunks.map(|c| unit(c) as u16))
            .map(|c| c.unwrap_or('\u{fffd}'))
            .collect::<String>()
    } else {
        chunks.map(|c| char::from_u32(unit(c)).unwrap_or('\u{fffd}')).collect()
    };
    if dangling {
        text.push('\u{fffd}');
    }
    text
}

/// The text after a byte order mark, in the encoding the mark names (UTF-8,
/// UTF-16 or UTF-32, either byte order); `None` when there is no mark.
fn decode_marked(bytes: &[u8]) -> Option<String> {
    Some(match bytes {
        [0xFE, 0xFF, rest @ ..] => decode_units(rest, 2, |c| u32::from(u16::from_be_bytes([c[0], c[1]]))),
        [0xFF, 0xFE, 0, 0, rest @ ..] => {
            decode_units(rest, 4, |c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        }
        [0xFF, 0xFE, rest @ ..] => decode_units(rest, 2, |c| u32::from(u16::from_le_bytes([c[0], c[1]]))),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        [0, 0, 0xFE, 0xFF, rest @ ..] => {
            decode_units(rest, 4, |c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
        }
        _ => return None,
    })
}

/// Text as `[IO.File]::ReadAllText` read it, which is how `--file` reads:
/// a byte order mark decides the encoding and is dropped; without one it is
/// UTF-8, invalid bytes becoming U+FFFD.
pub fn decode_text(bytes: &[u8]) -> String {
    decode_marked(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

/// Piped standard input. A byte order mark or valid UTF-8 (a Claude Code
/// hook payload, Git Bash, pwsh 7) is read as `decode_text` reads it; any
/// other bytes are text in the console's code page, handed to `console`,
/// which is what cmd.exe's `echo` and `dir` and older console tools write
/// into a pipe and what `[Console]::In` in `yard.ps1` decoded.
pub fn decode_stdin(bytes: &[u8], console: impl FnOnce(&[u8]) -> String) -> String {
    if let Some(text) = decode_marked(bytes) {
        return text;
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => console(bytes),
    }
}

/// `bytes` in the Windows code page `code_page`, as .NET's
/// `Encoding.GetEncoding(code_page)` read them (0 is the ANSI code page).
pub fn decode_code_page(bytes: &[u8], code_page: u32) -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            source: *const u8,
            source_len: i32,
            wide: *mut u16,
            wide_len: i32,
        ) -> i32;
    }
    if bytes.is_empty() {
        return String::new();
    }
    let Ok(len) = i32::try_from(bytes.len()) else {
        return String::from_utf8_lossy(bytes).into_owned();
    };
    // SAFETY: both calls read exactly `len` bytes of `bytes`; the first only
    // measures, the second writes at most `size` units into a buffer of `size`.
    unsafe {
        let size = MultiByteToWideChar(code_page, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0);
        if size <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; size as usize];
        let written = MultiByteToWideChar(code_page, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), size);
        wide.truncate(written.max(0) as usize);
        String::from_utf16_lossy(&wide)
    }
}

// ---------------------------------------------------------------------------
// the pipe
// ---------------------------------------------------------------------------

/// `NamedPipeClientStream.Connect(limit)`: try at least once, and keep trying
/// while the pipe does not exist yet (the app is still starting) or has no
/// free instance, until `limit_ms` has passed. Any other failure is final.
/// The clock and the pause come in so the rule can be tested without a pipe;
/// where .NET spun on the CPU, the caller here sleeps a millisecond.
pub fn connect_with_retry<T>(
    mut open: impl FnMut() -> io::Result<T>,
    mut now_ms: impl FnMut() -> u64,
    mut pause: impl FnMut(),
    limit_ms: u64,
) -> Result<T, String> {
    let start = now_ms();
    loop {
        match open() {
            Ok(pipe) => return Ok(pipe),
            Err(e) if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                if now_ms().saturating_sub(start) >= limit_ms {
                    return Err(format!("tempo limite de {limit_ms} ms esgotado"));
                }
                pause();
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// the exe
// ---------------------------------------------------------------------------

/// The process's command line as Windows holds it, so the arguments can be
/// split by powershell.exe's rules rather than std's (see `script_args`).
fn command_line() -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCommandLineW() -> *const u16;
    }
    // SAFETY: `GetCommandLineW` returns the process's own NUL-terminated
    // command line, valid and unchanged for the life of the process.
    unsafe {
        let start = GetCommandLineW();
        if start.is_null() {
            return String::new();
        }
        let mut len = 0;
        while *start.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(start, len))
    }
}

fn read_file(path: &str) -> FileText {
    match std::fs::read(path) {
        Ok(bytes) => FileText::Text(decode_text(&bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(ERROR_INVALID_NAME) => {
            FileText::Missing
        }
        Err(e) => FileText::Unreadable(e.to_string()),
    }
}

fn read_stdin() -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleCP() -> u32;
    }
    let mut bytes = Vec::new();
    // A closed or absent standard input is simply empty, as `ReadToEnd` saw it.
    let _ = io::stdin().lock().read_to_end(&mut bytes);
    // SAFETY: no arguments. Without a console it answers 0, the ANSI code
    // page, which is also what .NET's `Console.InputEncoding` fell back to.
    decode_stdin(&bytes, |bytes| decode_code_page(bytes, unsafe { GetConsoleCP() }))
}

/// `[Console]::Error.WriteLine`: the message and a CRLF.
fn fail(message: &str, code: i32) -> i32 {
    let mut err = io::stderr().lock();
    let _ = err.write_all(message.as_bytes());
    let _ = err.write_all(b"\r\n");
    let _ = err.flush();
    code
}

/// `[Console]::Out.Write`: the text as it came, no line break added. A reader
/// that went away is not an error (.NET ignored a broken pipe too).
fn print(text: &str) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// `$reader.ReadLine()`: up to the first line break, which is dropped. A pipe
/// that breaks reads as the end, so a silent server is an empty reply.
fn read_reply(pipe: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = io::BufReader::new(pipe).read_until(b'\n', &mut bytes);
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn run() -> i32 {
    let args = script_args(&command_line());
    if args.len() == 1 && args[0] == PROBE_FLAG {
        print(PROBE_TOKEN);
        return 0;
    }
    let pipe_name = match std::env::var_os("YARD_PIPE") {
        Some(name) if !name.is_empty() => name.to_string_lossy().into_owned(),
        _ => return fail("yard: fora de um terminal do Yard (YARD_PIPE ausente)", 2),
    };
    let home = std::env::var_os("USERPROFILE")
        .filter(|home| !home.is_empty())
        .map(|home| home.to_string_lossy().into_owned());
    let request = match plan(&args, home.as_deref(), read_file, read_stdin) {
        Ok(request) => request,
        Err(exit) => return fail(&exit.message, exit.code),
    };
    let terminal = std::env::var_os("YARD_PTY_ID").map(|id| id.to_string_lossy().into_owned());
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut line = encode_request(terminal.as_deref(), &cwd, &request);
    // `StreamWriter.WriteLine`: the line ends in CRLF.
    line.push_str("\r\n");

    let path = format!(r"\\.\pipe\{pipe_name}");
    let started = std::time::Instant::now();
    let pipe = connect_with_retry(
        || std::fs::OpenOptions::new().read(true).write(true).open(&path),
        || started.elapsed().as_millis() as u64,
        || std::thread::sleep(std::time::Duration::from_millis(1)),
        CONNECT_TIMEOUT_MS,
    );
    let mut pipe = match pipe {
        Ok(pipe) => pipe,
        Err(reason) => {
            return fail(&format!("yard: nao consegui falar com o app Yard ({reason}); ele esta aberto?"), 2)
        }
    };
    if let Err(e) = pipe.write_all(line.as_bytes()) {
        return fail(&format!("yard: a conexao com o app caiu ({e})"), 1);
    }
    let reply = read_reply(&pipe);
    if reply.is_empty() {
        return fail("yard: resposta vazia do app", 1);
    }
    match decode_reply(&reply) {
        Ok(reply) => {
            if let Some(output) = reply.output {
                print(&output);
            }
            reply.code
        }
        Err(reason) => fail(&format!("yard: resposta invalida do app ({reason})"), 1),
    }
}

pub fn main() {
    std::process::exit(run());
}

#[cfg(test)]
mod tests {
    //! The client replaces `yard.ps1` under every agent hook and every `yard`
    //! call, so these pin it to what the PowerShell client did. The tables of
    //! arguments and numbers were read from a real Windows PowerShell 5.1 on
    //! this machine, not derived from documentation: an agent that worked
    //! yesterday has to keep working when the launcher changes under it.
    use super::*;

    fn args(line: &str) -> Vec<String> {
        script_args(line)
    }

    // --- the command line, as powershell.exe split it -------------------------

    #[test]
    fn plain_words_and_quoted_phrases_split_like_a_windows_command_line() {
        assert_eq!(args(r#"yard.exe a "b c" d"#), ["a", "b c", "d"]);
        assert_eq!(args("yard.exe a   b\tc"), ["a", "b", "c"]);
        assert_eq!(args(r#"yard.exe a"b"c"#), ["abc"]);
        assert_eq!(args(r#"yard.exe "a b"c d"#), ["a bc", "d"]);
    }

    #[test]
    fn an_empty_quoted_argument_is_kept_as_an_empty_string() {
        assert_eq!(args(r#"yard.exe """#), [""]);
        assert_eq!(args(r#"yard.exe "" x"#), ["", "x"]);
    }

    #[test]
    fn no_arguments_and_trailing_blanks_give_no_empty_argument() {
        assert!(args("yard.exe").is_empty());
        assert!(args("yard.exe   ").is_empty());
        assert!(args(r#""C:\Program Files\Yard\bin\yard-cli.exe""#).is_empty());
        assert_eq!(args("yard.exe a  "), ["a"]);
    }

    #[test]
    fn the_program_path_ends_at_its_closing_quote_whatever_it_holds() {
        assert_eq!(
            args(r#""C:\Users\Ana Lima\bin\yard-cli.exe" hook tool --stdin"#),
            ["hook", "tool", "--stdin"]
        );
        assert_eq!(args(r#""C:\dir\" a"#), ["a"]);
        assert_eq!(args(r"C:\bin\yard-cli.exe list"), ["list"]);
    }

    #[test]
    fn backslashes_are_literal_unless_they_precede_a_quote() {
        assert_eq!(args(r#"yard.exe a\\"b c""#), [r"a\b c"]);
        assert_eq!(args(r#"yard.exe "x\" y"#), [r#"x" y"#]);
        assert_eq!(args(r#"yard.exe "x\\" y"#), [r"x\", "y"]);
        assert_eq!(args(r"yard.exe a\b\ c"), [r"a\b\", "c"]);
        assert_eq!(args(r#"yard.exe a\\\"b"#), [r#"a\"b"#]);
        assert_eq!(args(r#"yard.exe "\"x\"""#), [r#""x""#]);
    }

    /// Where powershell.exe and Rust's own `std::env::args` disagree: inside
    /// quotes, `""` is a literal quote AND the end of the quoted run. With
    /// std's rules `"a""b c"` would be one argument; `yard.ps1` saw two.
    #[test]
    fn a_doubled_quote_inside_quotes_is_a_quote_that_also_closes_them() {
        assert_eq!(args(r#"yard.exe "a""b c""#), [r#"a"b"#, "c"]);
        assert_eq!(args(r#"yard.exe "a""b" c"#), [r#"a"b c"#]);
        assert_eq!(args(r#"yard.exe "a "" b""#), [r#"a ""#, "b"]);
        assert_eq!(args(r#"yard.exe "say "hi"""#), ["say hi"]);
        assert_eq!(args(r#"yard.exe "a"""b""#), [r#"a"b"#]);
        assert_eq!(args(r#"yard.exe """a""""#), [r#""a""#]);
    }

    #[test]
    fn an_unterminated_quote_runs_to_the_end_of_the_line() {
        assert_eq!(args(r#"yard.exe "unterminated"#), ["unterminated"]);
        assert_eq!(args(r#"yard.exe "a b"#), ["a b"]);
    }

    // --- --timeout, as `[int]([double]$s * 1000)` computed it -----------------

    #[test]
    fn timeout_seconds_convert_the_way_windows_powershell_casts_them() {
        for (text, ms) in [
            ("2.5", 2500),
            ("30", 30_000),
            ("1e1", 10_000),
            ("1e+2", 100_000),
            ("1E2", 100_000),
            ("1.5e-3", 2),
            ("+2", 2000),
            ("-2", -2000),
            (".5", 500),
            ("5.", 5000),
            ("1.", 1000),
            ("-.5", -500),
            ("00012", 12_000),
            ("  2 ", 2000),
            ("\t3\t", 3000),
            ("-0", 0),
            ("1e-400", 0),
            ("4e-4", 0),
            // `[double]""` is 0 in PowerShell; a blank string is not.
            ("", 0),
        ] {
            assert_eq!(seconds_to_ms(text), Some(ms), "{text:?}");
        }
    }

    /// `[double]` parses with the invariant culture and allows thousands
    /// separators: `--timeout 1,5` meant fifteen seconds, not one and a half.
    #[test]
    fn a_comma_in_a_timeout_is_a_thousands_separator_not_a_decimal_point() {
        for (text, ms) in [
            ("1,5", 15_000),
            ("1,000.5", 1_000_500),
            ("5,", 5000),
            ("1,,5", 15_000),
            ("1,5e1", 150_000),
        ] {
            assert_eq!(seconds_to_ms(text), Some(ms), "{text:?}");
        }
        for text in [",5", "1.5,0", "0.5e1,0"] {
            assert_eq!(seconds_to_ms(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_timeout_half_millisecond_rounds_to_even_like_a_dotnet_int_cast() {
        assert_eq!(seconds_to_ms("0.0015"), Some(2));
        assert_eq!(seconds_to_ms("0.0025"), Some(2));
        assert_eq!(seconds_to_ms("-0.0005"), Some(0));
        assert_eq!(seconds_to_ms("-0.0006"), Some(-1));
        assert_eq!(seconds_to_ms("2147483.647"), Some(i32::MAX));
        // 2147483647.5 rounds up past `Int32.MaxValue`: an overflow, an error.
        assert_eq!(seconds_to_ms("2147483.6475"), None);
        assert_eq!(seconds_to_ms("2147483.648"), None);
    }

    #[test]
    fn a_timeout_powershell_could_not_cast_is_refused() {
        for text in [
            " ", "1kb", "1_000", "NaN", "Infinity", "1e400", "1d", "1e", "e5", "1.5.2", "0x10",
            "(2)", "2-", "2$", "1 000", "- 2", "+-2", ".", "abc",
        ] {
            assert_eq!(seconds_to_ms(text), None, "{text:?}");
        }
    }

    // --- the argument plan: yard.ps1's two loops, in its order -----------------

    struct Planned {
        result: Result<Request, Exit>,
        file_reads: Vec<String>,
        stdin_reads: usize,
    }

    /// Runs `plan` against an in-memory disk: `files` maps a path to its text,
    /// and the text `<unreadable>` stands for a file that exists but cannot be
    /// read (a folder, a locked file). Standard input always holds `STDIN`.
    fn plan_with(argv: &[&str], files: &[(&str, &str)]) -> Planned {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let mut file_reads = Vec::new();
        let mut stdin_reads = 0;
        let result = plan(
            &argv,
            Some(r"C:\Users\ana"),
            |path| {
                file_reads.push(path.to_string());
                match files.iter().find(|(name, _)| *name == path) {
                    Some((_, "<unreadable>")) => FileText::Unreadable("Acesso negado.".to_string()),
                    Some((_, text)) => FileText::Text(text.to_string()),
                    None => FileText::Missing,
                }
            },
            || {
                stdin_reads += 1;
                "STDIN".to_string()
            },
        );
        Planned { result, file_reads, stdin_reads }
    }

    fn ok(p: &Planned) -> &Request {
        p.result.as_ref().expect("plan succeeds")
    }

    fn failure(p: &Planned) -> &Exit {
        p.result.as_ref().expect_err("plan fails")
    }

    #[test]
    fn without_flags_the_arguments_pass_through_with_the_default_three_minutes() {
        let p = plan_with(&["list"], &[]);
        assert_eq!(
            ok(&p),
            &Request { argv: vec!["list".into()], stdin: None, timeout_ms: 180_000 }
        );
        assert_eq!(p.stdin_reads, 0);
        let p = plan_with(&[], &[]);
        assert_eq!(ok(&p).argv, Vec::<String>::new());
    }

    #[test]
    fn the_last_timeout_wins_and_the_flag_stays_in_argv_for_the_app() {
        let p = plan_with(&["check", "--timeout", "5", "--timeout", "7"], &[]);
        assert_eq!(ok(&p).timeout_ms, 7000);
        assert_eq!(ok(&p).argv, ["check", "--timeout", "5", "--timeout", "7"]);
    }

    #[test]
    fn a_timeout_flag_without_a_value_is_left_alone() {
        let p = plan_with(&["check", "--timeout"], &[]);
        assert_eq!(ok(&p).timeout_ms, 180_000);
        assert_eq!(ok(&p).argv, ["check", "--timeout"]);
    }

    /// PowerShell's `-eq` ignores case, so `--TIMEOUT` counted and `ASK`
    /// got the long wait too.
    #[test]
    fn flags_and_the_long_verbs_match_whatever_their_case() {
        assert_eq!(ok(&plan_with(&["x", "--TIMEOUT", "2"], &[])).timeout_ms, 2000);
        for verb in ["ask", "ASK", "Recruit", "wait"] {
            let p = plan_with(&[verb, "--timeout", "5"], &[]);
            assert_eq!(ok(&p).timeout_ms, 600_000, "{verb}");
        }
    }

    #[test]
    fn ask_recruit_and_wait_wait_ten_minutes_at_least_but_may_wait_longer() {
        assert_eq!(ok(&plan_with(&["ask", "Bob", "oi"], &[])).timeout_ms, 600_000);
        assert_eq!(ok(&plan_with(&["wait", "--timeout", "900"], &[])).timeout_ms, 900_000);
        // Only the first argument names the verb.
        assert_eq!(ok(&plan_with(&["list", "ask"], &[])).timeout_ms, 180_000);
    }

    #[test]
    fn a_timeout_that_is_not_a_number_fails_with_exit_1_before_anything_is_read() {
        let p = plan_with(&["note", "--stdin", "--file", "nope.md", "--timeout", "abc"], &[]);
        assert_eq!(failure(&p).code, 1);
        assert!(failure(&p).message.starts_with("yard: "), "{:?}", failure(&p));
        assert!(failure(&p).message.contains("abc"), "{:?}", failure(&p));
        assert_eq!(p.stdin_reads, 0);
        assert!(p.file_reads.is_empty());
    }

    #[test]
    fn a_file_becomes_the_request_text_and_the_flag_becomes_stdin() {
        let p = plan_with(&["note", "write", "N", "--file", "plan.md"], &[("plan.md", "linha 1\r\nlinha 2")]);
        assert_eq!(ok(&p).argv, ["note", "write", "N", "--stdin"]);
        assert_eq!(ok(&p).stdin.as_deref(), Some("linha 1\r\nlinha 2"));
        assert_eq!(p.file_reads, ["plan.md"]);
        assert_eq!(p.stdin_reads, 0);
    }

    #[test]
    fn a_missing_file_fails_with_exit_2_naming_the_path_as_typed() {
        let p = plan_with(&["note", "write", "N", "--file", "nope.md", "--stdin"], &[]);
        assert_eq!(
            failure(&p),
            &Exit { code: 2, message: "yard: arquivo nao encontrado: nope.md".to_string() }
        );
        // The check comes before the later `--stdin` is reached.
        assert_eq!(p.stdin_reads, 0);
    }

    #[test]
    fn a_file_that_exists_but_cannot_be_read_fails_with_exit_1() {
        let p = plan_with(&["note", "--file", "pasta"], &[("pasta", "<unreadable>")]);
        assert_eq!(failure(&p).code, 1);
        assert!(failure(&p).message.contains("pasta"), "{:?}", failure(&p));
    }

    /// `Test-Path -LiteralPath` threw on these instead of answering "no", so
    /// the PowerShell client died with exit 1, not with "file not found".
    #[test]
    fn an_empty_or_malformed_file_path_fails_with_exit_1_without_touching_the_disk() {
        for path in ["", "a|b", "a<b", "a>b", "a\"b", "a\u{1}b"] {
            let p = plan_with(&["note", "--file", path], &[]);
            assert_eq!(failure(&p).code, 1, "{path:?}");
            assert!(p.file_reads.is_empty(), "{path:?}");
        }
        // Wildcards are merely names that do not exist.
        let p = plan_with(&["note", "--file", "a*b"], &[]);
        assert_eq!(failure(&p).code, 2);
    }

    #[test]
    fn a_file_path_starting_with_a_tilde_is_under_the_user_profile() {
        let p = plan_with(&["note", "--file", r"~\plan.md"], &[(r"C:\Users\ana\plan.md", "x")]);
        assert_eq!(ok(&p).stdin.as_deref(), Some("x"));
        let p = plan_with(&["note", "--file", "~/plan.md"], &[(r"C:\Users\ana/plan.md", "y")]);
        assert_eq!(ok(&p).stdin.as_deref(), Some("y"));
        let p = plan_with(&["note", "--file", "~"], &[]);
        assert_eq!(p.file_reads, [r"C:\Users\ana"]);
        // `~x` is a file called `~x`, not someone's home.
        let p = plan_with(&["note", "--file", "~x"], &[]);
        assert_eq!(p.file_reads, ["~x"]);
    }

    /// `--FILE` and `--STDIN` counted (case-insensitive `-eq`), and what
    /// reached the app was the lowercase `--stdin` it knows.
    #[test]
    fn file_and_stdin_flags_match_any_case_and_reach_the_app_as_lowercase_stdin() {
        let p = plan_with(&["x", "--FILE", "a", "--STDIN"], &[("a", "A")]);
        assert_eq!(ok(&p).argv, ["x", "--stdin", "--stdin"]);
        assert_eq!(ok(&p).stdin.as_deref(), Some("A"));
    }

    #[test]
    fn standard_input_is_read_once_however_many_times_the_flag_appears() {
        let p = plan_with(&["x", "--stdin", "--stdin"], &[]);
        assert_eq!(ok(&p).argv, ["x", "--stdin", "--stdin"]);
        assert_eq!(ok(&p).stdin.as_deref(), Some("STDIN"));
        assert_eq!(p.stdin_reads, 1);
    }

    #[test]
    fn a_file_after_stdin_replaces_it_and_stdin_after_a_file_is_not_read() {
        let p = plan_with(&["x", "--stdin", "--file", "a", "--stdin"], &[("a", "A")]);
        assert_eq!(ok(&p).stdin.as_deref(), Some("A"));
        assert_eq!(ok(&p).argv, ["x", "--stdin", "--stdin", "--stdin"]);
        assert_eq!(p.stdin_reads, 1);
    }

    #[test]
    fn a_file_flag_with_no_path_after_it_is_just_an_argument() {
        let p = plan_with(&["x", "--file"], &[]);
        assert_eq!(ok(&p).argv, ["x", "--file"]);
        assert_eq!(ok(&p).stdin, None);
        assert!(p.file_reads.is_empty());
    }

    // --- the request line -------------------------------------------------------

    fn request(argv: &[&str], stdin: Option<&str>) -> Request {
        Request {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            stdin: stdin.map(str::to_string),
            timeout_ms: 180_000,
        }
    }

    #[test]
    fn the_request_is_one_json_line_with_the_fields_the_server_reads() {
        let line = encode_request(Some("t-1"), r"C:\Work\app", &request(&["ask", "Bob"], None));
        assert!(!line.contains('\n') && !line.contains('\r'), "{line}");
        let value: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(
            value,
            serde_json::json!({
                "v": 1,
                "terminal": "t-1",
                "cwd": r"C:\Work\app",
                "argv": ["ask", "Bob"],
                "stdin": null,
                "timeoutMs": 180000,
            })
        );
    }

    #[test]
    fn a_caller_outside_a_yard_terminal_and_no_arguments_are_null_and_empty() {
        let line = encode_request(None, "C:\\", &request(&[], Some("")));
        let value: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(value["terminal"], serde_json::Value::Null);
        assert_eq!(value["argv"], serde_json::json!([]));
        assert_eq!(value["stdin"], "");
        assert_eq!(value["cwd"], "C:\\");
    }

    #[test]
    fn quotes_backslashes_control_characters_and_accents_survive_the_trip() {
        let tricky = [
            "a\"b",
            r"C:\dir\",
            "tab\there",
            "line\nbreak\r\n",
            "\u{0}\u{1}\u{8}\u{c}\u{1f}\u{7f}",
            "ação € 😀",
            "\u{2028}\u{2029}",
            "</script>",
        ];
        let text = tricky.join("|");
        let line = encode_request(Some("t\"x"), r"C:\Usuários\ação", &request(&tricky, Some(&text)));
        assert!(!line.contains('\n') && !line.contains('\r'), "{line}");
        let value: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(value["argv"], serde_json::json!(tricky));
        assert_eq!(value["stdin"], text.as_str());
        assert_eq!(value["terminal"], "t\"x");
        assert_eq!(value["cwd"], r"C:\Usuários\ação");
    }

    // --- the reply line ---------------------------------------------------------

    fn reply(line: &str) -> Reply {
        decode_reply(line).expect("reply decodes")
    }

    #[test]
    fn the_reply_carries_the_output_and_the_exit_code() {
        assert_eq!(
            reply(r#"{"code":3,"output":"hi\n"}"#),
            Reply { output: Some("hi\n".to_string()), code: 3 }
        );
        assert_eq!(reply(r#"{"output":"não ✓","code":1}"#).output.as_deref(), Some("não ✓"));
    }

    #[test]
    fn escapes_in_the_output_decode_including_surrogate_pairs() {
        let r = reply(r#"{"output":"a\u00e7\u00e3o \ud83d\ude00 \"q\" \\ \/ \b\f\n\r\t","code":0}"#);
        assert_eq!(r.output.as_deref(), Some("ação 😀 \"q\" \\ / \u{8}\u{c}\n\r\t"));
        // A surrogate with no partner cannot be text; it becomes U+FFFD.
        assert_eq!(reply(r#"{"output":"x\ud800y"}"#).output.as_deref(), Some("x\u{fffd}y"));
        assert_eq!(reply(r#"{"output":"\udc00"}"#).output.as_deref(), Some("\u{fffd}"));
    }

    /// `if ($res.output)` and `exit [int]$res.code`: an empty or absent
    /// output prints nothing, an absent code is `[int]$null`, zero.
    #[test]
    fn an_empty_or_absent_output_prints_nothing_and_an_absent_code_is_zero() {
        assert_eq!(reply(r#"{"code":0,"output":""}"#), Reply { output: None, code: 0 });
        assert_eq!(reply(r#"{"code":2}"#), Reply { output: None, code: 2 });
        assert_eq!(reply(r#"{"output":"x"}"#).code, 0);
        assert_eq!(reply(r#"{"output":null,"code":null}"#), Reply { output: None, code: 0 });
        assert_eq!(reply("null"), Reply { output: None, code: 0 });
    }

    /// `$res.output` and `$res.code` are PowerShell property reads, and those
    /// ignore case.
    #[test]
    fn the_reply_fields_are_found_whatever_their_case() {
        assert_eq!(
            reply(r#"{"Output":"x","CODE":2}"#),
            Reply { output: Some("x".to_string()), code: 2 }
        );
    }

    #[test]
    fn other_fields_of_any_shape_are_skipped() {
        let r = reply(
            r#" { "extra" : {"a":[1,2,{"b":"}\"]"}],"n":-1.5e3,"t":true,"f":false,"z":null} , "code" : 2 , "output" : "ok" } "#,
        );
        assert_eq!(r, Reply { output: Some("ok".to_string()), code: 2 });
    }

    #[test]
    fn a_fractional_code_rounds_like_an_int_cast_and_an_enormous_one_is_an_error() {
        assert_eq!(reply(r#"{"code":2.5}"#).code, 2);
        assert_eq!(reply(r#"{"code":3.5}"#).code, 4);
        assert_eq!(reply(r#"{"code":-1}"#).code, -1);
        assert!(decode_reply(r#"{"code":1e10}"#).is_err());
    }

    #[test]
    fn a_reply_that_is_not_json_is_an_error() {
        for line in ["{", "nope", r#"{"code":}"#, r#"{"code":1} x"#, r#"{"output":"a"#, "   ", "{\"output\":\"a\u{1}\"}"] {
            assert!(decode_reply(line).is_err(), "{line:?}");
        }
    }

    // --- text read from --file and standard input -------------------------------

    #[test]
    fn text_without_a_byte_order_mark_is_utf8() {
        assert_eq!(decode_text("ação €".as_bytes()), "ação €");
        assert_eq!(decode_text(b""), "");
        assert_eq!(decode_text(b"a\xffb"), "a\u{fffd}b");
    }

    /// `[IO.File]::ReadAllText` let the byte order mark decide; a file saved as
    /// "Unicode" by Notepad or PowerShell 5.1 has to arrive as the same text.
    #[test]
    fn a_byte_order_mark_decides_the_encoding_and_is_dropped() {
        assert_eq!(decode_text(b"\xef\xbb\xbfa\xc3\xa7"), "aç");
        assert_eq!(decode_text(b"\xff\xfea\x00\xe7\x00"), "aç");
        assert_eq!(decode_text(b"\xfe\xff\x00a\x00\xe7"), "aç");
        assert_eq!(decode_text(b"\xff\xfe\x00\x00a\x00\x00\x00"), "a");
        assert_eq!(decode_text(b"\x00\x00\xfe\xff\x00\x00\x00a"), "a");
        // A dangling half of a UTF-16 unit is a replacement character.
        assert_eq!(decode_text(b"\xff\xfea\x00b"), "a\u{fffd}");
    }

    /// The regression: cmd.exe's `echo ação|` writes the console's code page
    /// (850 on a Brazilian Windows) into the pipe, `[Console]::In` read it as
    /// such, and the native client turned it into `a\u{fffd}\u{fffd}o`.
    #[test]
    fn standard_input_that_is_not_utf8_is_read_in_the_console_code_page() {
        assert_eq!(
            decode_stdin(b"\x61\x87\xc6\x6f\r\n", |bytes| decode_code_page(bytes, 850)),
            "ação\r\n"
        );
    }

    /// What the native client fixed stays fixed: a Claude Code hook payload,
    /// Git Bash and pwsh 7 write UTF-8, and a byte order mark still decides,
    /// exactly as `decode_text` reads them.
    #[test]
    fn utf8_or_a_byte_order_mark_on_standard_input_never_goes_to_the_console_code_page() {
        let marked_utf16: &[u8] = b"\xff\xfea\x00\xe7\x00";
        let marked_utf8_with_a_bad_byte: &[u8] = b"\xef\xbb\xbfa\xff";
        for bytes in [
            r#"{"prompt":"ação €"}"#.as_bytes(),
            b"",
            b"\xef\xbb\xbfa\xc3\xa7",
            marked_utf16,
            marked_utf8_with_a_bad_byte,
        ] {
            let text = decode_stdin(bytes, |_| panic!("{bytes:?} went to the console code page"));
            assert_eq!(text, decode_text(bytes), "{bytes:?}");
        }
    }

    /// `Encoding.GetEncoding(cp)`, as `[Console]::InputEncoding` gave it; 0 is
    /// the ANSI code page, what .NET fell back to without a console.
    #[test]
    fn bytes_in_a_windows_code_page_decode_to_their_characters() {
        assert_eq!(decode_code_page(b"a\x87\xc6o", 850), "ação");
        assert_eq!(decode_code_page(b"a\xe7\xe3o", 1252), "ação");
        assert_eq!(decode_code_page(b"", 850), "");
        assert_eq!(decode_code_page(b"plain", 0), "plain");
    }

    // --- connecting to the pipe ---------------------------------------------------

    fn not_found() -> io::Error {
        io::Error::from_raw_os_error(2)
    }

    #[test]
    fn a_pipe_that_does_not_exist_yet_is_retried_until_it_appears() {
        let mut attempts = 0;
        let mut pauses = 0;
        let got = connect_with_retry(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(not_found())
                } else {
                    Ok(7)
                }
            },
            || 0,
            || pauses += 1,
            4000,
        );
        assert_eq!(got, Ok(7));
        assert_eq!((attempts, pauses), (3, 2));
    }

    /// Between accepting one client and listening again the server has no free
    /// instance: `ERROR_PIPE_BUSY`, which `Connect(4000)` waited out.
    #[test]
    fn a_busy_pipe_is_retried_too() {
        let mut attempts = 0;
        let got = connect_with_retry(
            || {
                attempts += 1;
                if attempts == 1 {
                    Err(io::Error::from_raw_os_error(231))
                } else {
                    Ok("conectado")
                }
            },
            || 0,
            || {},
            4000,
        );
        assert_eq!(got, Ok("conectado"));
    }

    #[test]
    fn the_wait_gives_up_after_the_limit_with_a_timeout_as_the_reason() {
        let mut clock = 0;
        let mut attempts = 0;
        let got: Result<(), String> = connect_with_retry(
            || {
                attempts += 1;
                Err(not_found())
            },
            || {
                clock += 1000;
                clock
            },
            || {},
            4000,
        );
        let reason = got.expect_err("gives up");
        assert!(reason.contains("4000"), "{reason}");
        assert!((3..=5).contains(&attempts), "{attempts}");
    }

    #[test]
    fn any_other_error_fails_at_once_with_its_own_reason() {
        let mut attempts = 0;
        let got: Result<(), String> = connect_with_retry(
            || {
                attempts += 1;
                Err(io::Error::from_raw_os_error(5))
            },
            || 0,
            || panic!("must not wait"),
            4000,
        );
        assert!(got.is_err());
        assert_eq!(attempts, 1);
    }
}
