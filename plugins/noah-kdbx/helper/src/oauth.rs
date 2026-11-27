use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use url::Url;

#[derive(Deserialize)]
struct Request {
    port: u16,
    state: String,
}

const CALLBACK: &str = "/oauth/callback";

pub fn run() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin().lock().take(4096).read_to_end(&mut input)?;
    let request: Request = serde_json::from_slice(&input).map_err(io::Error::other)?;
    if request.state.len() < 20
        || !request
            .state
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(io::Error::other("invalid OAuth state"));
    }
    let listener = TcpListener::bind(("127.0.0.1", request.port))?;
    listener.set_nonblocking(true)?;
    let mut out = io::stdout().lock();
    writeln!(out, "{}", listener.local_addr()?.port())?;
    out.flush()?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Ok(true) = callback(&mut stream, &request.state) {
                    return Ok(());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(30))
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("OAuth callback timed out"))
}

fn redirect(line: &str, state: &str) -> Option<Url> {
    let mut request = line.split_ascii_whitespace();
    if request.next()? != "GET" {
        return None;
    }
    let target = request.next()?;
    if !target.starts_with('/') || target.starts_with("//") {
        return None;
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != CALLBACK || url.fragment().is_some() {
        return None;
    }
    let mut params = url.query_pairs();
    let states: Vec<_> = params.clone().filter(|(name, _)| name == "state").collect();
    let replies: Vec<_> = params
        .by_ref()
        .filter(|(name, _)| name == "code" || name == "error")
        .collect();
    if states.len() != 1 || states[0].1 != state || replies.len() != 1 || replies[0].1.is_empty() {
        return None;
    }
    let mut redirect = Url::parse("raycast://oauth").ok()?;
    redirect
        .query_pairs_mut()
        .append_pair("state", state)
        .append_pair(&replies[0].0, &replies[0].1);
    Some(redirect)
}

fn callback(stream: &mut TcpStream, state: &str) -> io::Result<bool> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut line = String::new();
    let mut request = BufReader::new(&mut *stream).take(24 * 1024);
    let size = request.read_line(&mut line)?;
    let mut header = String::new();
    loop {
        header.clear();
        if request.read_line(&mut header)? == 0 {
            return Ok(false);
        }
        if header == "\r\n" || header == "\n" {
            break;
        }
    }
    if let Some(url) = (size < 8192).then(|| redirect(&line, state)).flatten() {
        let body = "Return to Tinycast to finish opening your vault.";
        write!(
            stream,
            "HTTP/1.1 302 Found\r\nLocation: {url}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )?;
        Ok(true)
    } else {
        stream.write_all(b"HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relays_only_the_exact_callback_and_single_matching_state() {
        let expected = "a_test_state";
        let reply = redirect(
            "GET /oauth/callback?state=a_test_state&code=fixture%2Bcode HTTP/1.1",
            expected,
        )
        .unwrap();
        assert_eq!(
            reply.as_str(),
            "raycast://oauth?state=a_test_state&code=fixture%2Bcode"
        );
        for target in [
            "/oauth/callback?state=other&code=fixture",
            "/oauth/callback?state=a_test_state&state=a_test_state&code=fixture",
            "/oauth/callback?state=a_test_state&code=fixture&error=access_denied",
            "/unrelated?state=a_test_state&code=fixture",
            "//unrelated/oauth/callback?state=a_test_state&code=fixture",
        ] {
            assert!(redirect(&format!("GET {target} HTTP/1.1"), expected).is_none());
        }
    }
}
