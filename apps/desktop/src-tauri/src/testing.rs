//! A tiny HTTP/1.1 server for tests: it records every request and answers from a closure,
//! so API code can be pointed at it instead of Feishu or DeepSeek.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }

    pub fn path(&self) -> String {
        self.url().path().to_string()
    }

    pub fn query(&self, key: &str) -> Option<String> {
        self.url().query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }

    fn url(&self) -> Url {
        Url::parse(&format!("http://test{}", self.target)).unwrap()
    }
}

/// Status, extra response headers, body.
type Handler = dyn Fn(&Request) -> (u16, Vec<(String, String)>, String) + Send + Sync;

pub struct Server {
    addr: std::net::SocketAddr,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Server {
    pub async fn start(handler: impl Fn(&Request) -> (u16, String) + Send + Sync + 'static) -> Self {
        Self::start_with_headers(move |request| {
            let (status, body) = handler(request);
            (status, Vec::new(), body)
        })
        .await
    }

    pub async fn start_with_headers(handler: impl Fn(&Request) -> (u16, Vec<(String, String)>, String) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = requests.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (log, handler) = (log.clone(), handler.clone());
                tokio::spawn(async move { serve(stream, log, handler).await });
            }
        });
        Self { addr, requests }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

async fn serve(mut stream: TcpStream, log: Arc<Mutex<Vec<Request>>>, handler: Arc<Handler>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match stream.read(&mut chunk).await {
            Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
            _ => return,
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let (method, target) = (first.next().unwrap_or_default().to_string(), first.next().unwrap_or_default().to_string());
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let length = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + length {
        match stream.read(&mut chunk).await {
            Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
            _ => break,
        }
    }
    let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
    let request = Request { method, target, headers, body };
    let (status, extra, reply) = handler(&request);
    log.lock().unwrap().push(request);
    let extra: String = extra.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
    let response = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json; charset=utf-8\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}
