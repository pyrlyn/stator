//! C ABI over Oxc for the Stator Zig compiler core (docs/zig-core.md).
//!
//! `stator_oxc_parse` parses one file with `oxc_parser`, runs `oxc_semantic` (scopes, symbols,
//! references) and flattens the result into plain arrays the Zig side reads through a handle:
//!
//! - nodes in Oxc's pre-order (`AstNodes`), each `{ kind, parent, start, end }`; `kind` indexes a
//!   per-handle table of kind names, `parent` is a node index (`u32::MAX` for the root), offsets
//!   are UTF-8 bytes;
//! - parse and semantic diagnostics as `{ start, end, message }`;
//! - scope, symbol and reference counts.
//!
//! The Oxc arena is dropped before returning, so the handle owns only flat copies. Every handle
//! must be released with `stator_oxc_free`.
//!
//! # Safety
//! Every function taking a handle requires a live pointer returned by `stator_oxc_parse`; index
//! arguments must be below the matching count. Returned slices live until `stator_oxc_free`.

#![allow(clippy::missing_safety_doc)]

use std::collections::HashMap;
use std::ffi::c_char;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct StatorOxcNode {
    pub kind: u32,
    pub parent: u32,
    pub start: u32,
    pub end: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct StatorOxcStats {
    pub nodes: u32,
    pub scopes: u32,
    pub symbols: u32,
    pub references: u32,
    pub parse_errors: u32,
    pub semantic_errors: u32,
    /// 1 when the parser gave up (unrecoverable syntax error); the AST is then empty.
    pub panicked: u32,
}

struct Diag {
    start: u32,
    end: u32,
    message: String,
}

pub struct StatorOxcResult {
    nodes: Vec<StatorOxcNode>,
    kinds: Vec<String>,
    diags: Vec<Diag>,
    stats: StatorOxcStats,
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

fn diag(d: &oxc_diagnostics::OxcDiagnostic) -> Diag {
    let (start, end) = d
        .labels
        .first()
        .map(|l| (l.offset() as u32, (l.offset() + l.len()) as u32))
        .unwrap_or((0, 0));
    Diag {
        start,
        end,
        message: d.message.to_string(),
    }
}

fn parse(path: &str, source: &str) -> StatorOxcResult {
    let source_type = SourceType::from_path(Path::new(path)).unwrap_or_else(|_| SourceType::ts());
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, source, source_type).parse();
    let mut diags: Vec<Diag> = ret.diagnostics.errors().map(diag).collect();
    let mut stats = StatorOxcStats {
        parse_errors: diags.len() as u32,
        panicked: ret.fatal_error as u32,
        ..Default::default()
    };
    let sem = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .build(&ret.program);
    let before = diags.len();
    diags.extend(sem.diagnostics.errors().map(diag));
    stats.semantic_errors = (diags.len() - before) as u32;
    let semantic = sem.semantic;
    let scoping = semantic.scoping();
    stats.scopes = scoping.scopes_len() as u32;
    stats.symbols = scoping.symbols_len() as u32;
    stats.references = scoping.references_len() as u32;

    let mut kinds: Vec<String> = Vec::new();
    let mut kind_ids: HashMap<String, u32> = HashMap::new();
    let ast = semantic.nodes();
    let mut nodes = Vec::with_capacity(ast.len());
    for node in ast.iter() {
        let kind = node.kind();
        let name = kind.debug_name().to_string();
        let name = name.split('(').next().unwrap_or("").trim().to_string();
        let id = *kind_ids.entry(name.clone()).or_insert_with(|| {
            kinds.push(name);
            (kinds.len() - 1) as u32
        });
        let parent = ast.parent_id(node.id());
        let parent = if parent == node.id() {
            u32::MAX
        } else {
            parent.index() as u32
        };
        let span = kind.span();
        nodes.push(StatorOxcNode {
            kind: id,
            parent,
            start: span.start,
            end: span.end,
        });
    }
    stats.nodes = nodes.len() as u32;
    StatorOxcResult {
        nodes,
        kinds,
        diags,
        stats,
    }
}

/// Parses `source` (UTF-8, `source_len` bytes); `path` only selects the dialect (`.ts`, `.tsx`,
/// `.js`, `.mjs`, `.d.ts`, …). Returns null only when `source` is not valid UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_parse(
    path: *const u8,
    path_len: usize,
    source: *const u8,
    source_len: usize,
) -> *mut StatorOxcResult {
    let path = String::from_utf8_lossy(unsafe { slice(path, path_len) }).into_owned();
    let Ok(source) = std::str::from_utf8(unsafe { slice(source, source_len) }) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(parse(&path, source)))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_free(r: *mut StatorOxcResult) {
    if !r.is_null() {
        drop(unsafe { Box::from_raw(r) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_stats(r: *const StatorOxcResult) -> StatorOxcStats {
    unsafe { (*r).stats }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_nodes(
    r: *const StatorOxcResult,
    len: *mut usize,
) -> *const StatorOxcNode {
    let r = unsafe { &*r };
    unsafe { *len = r.nodes.len() };
    r.nodes.as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_kind_count(r: *const StatorOxcResult) -> u32 {
    unsafe { (&*r).kinds.len() as u32 }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_kind_name(
    r: *const StatorOxcResult,
    kind: u32,
    len: *mut usize,
) -> *const c_char {
    let s = unsafe { &(&*r).kinds[kind as usize] };
    unsafe { *len = s.len() };
    s.as_ptr().cast()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_diag_count(r: *const StatorOxcResult) -> u32 {
    unsafe { (&*r).diags.len() as u32 }
}

/// Message of diagnostic `i`; `start`/`end` receive its first label's byte span (0, 0 if none).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn stator_oxc_diag(
    r: *const StatorOxcResult,
    i: u32,
    start: *mut u32,
    end: *mut u32,
    len: *mut usize,
) -> *const c_char {
    let d = unsafe { &(&*r).diags[i as usize] };
    unsafe {
        *start = d.start;
        *end = d.end;
        *len = d.message.len();
    }
    d.message.as_ptr().cast()
}
