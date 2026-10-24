//! gb-mcp [--db <knowledge.json>] [--rom <file.gbc>]
//! An MCP server on stdio. The knowledge DB path may also come from GB_MCP_DB; without one,
//! labels live only as long as the process.
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut db, mut rom) = (std::env::var_os("GB_MCP_DB").map(PathBuf::from), None);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--db" => db = args.next().map(PathBuf::from),
            "--rom" => rom = args.next(),
            "--version" => return println!("gb-mcp {}", env!("CARGO_PKG_VERSION")),
            _ => {
                eprintln!("usage: gb-mcp [--db <knowledge.json>] [--rom <file.gbc>]   (MCP over stdio; see README.md)");
                std::process::exit(2);
            }
        }
    }
    if let Some(repo) = db.as_deref().and_then(gb_mcp::inside_git_repo) {
        eprintln!("gb-mcp: refusing a knowledge DB inside the git repository {}: it holds game-specific labels; keep it outside any repository", repo.display());
        std::process::exit(2);
    }
    let db = match gb_mcp::db::Db::open(db) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("gb-mcp: {e}");
            std::process::exit(2);
        }
    };
    if db.path().is_none() {
        eprintln!("gb-mcp: no --db / GB_MCP_DB: labels and comments will not persist");
    }
    let mut server = gb_mcp::Server::new(db);
    if let Some(r) = rom {
        if let Err(e) = server.call_tool("rom_open", &serde_json::json!({"path": r})) {
            eprintln!("gb-mcp: {e}");
            std::process::exit(2);
        }
    }
    if let Err(e) = gb_mcp::serve(&mut server, std::io::stdin().lock(), std::io::stdout().lock()) {
        eprintln!("gb-mcp: {e}");
        std::process::exit(1);
    }
}
