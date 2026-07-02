"use strict";

/* ------------------------------------------------------------------ *
 * Markdowned — convert the current page to clean Markdown
 *
 * Pipeline:
 *   1. Inject a scraper into the active tab: pick the main content
 *      (article/main/…), strip navigation, ads, scripts and other
 *      junk, absolutize every link/image URL, fix lazy-loaded
 *      images, and pull in same-origin iframe content.
 *   2. Convert the extracted HTML with Turndown (heading, bullet and
 *      code-fence styles are configurable) plus custom rules for
 *      GFM tables and <figure> captions.
 *   3. Show the result in an editor with copy / download actions.
 *      The last conversion is cached per-URL and restored when the
 *      popup reopens on the same page.
 *
 * Everything is timeout-bounded — the popup never hangs.
 * ------------------------------------------------------------------ */

const state = { markdown: "", title: "", url: "" };

/* ================================================================== *
 *  1. PAGE SCRAPER  (serialised and run INSIDE the page)
 * ================================================================== */
function extractPageContent(opts) {
  const scope = (opts && opts.scope) || "main";
  try {
    if (!document || !document.body) throw new Error("Document body not found");

    const clone = document.body.cloneNode(true);

    // -- strip junk
    const JUNK =
      "script, style, noscript, template, nav, footer, aside, form, " +
      "iframe, svg, canvas, [role='navigation'], [role='complementary'], " +
      "[role='banner'], [role='contentinfo'], [aria-hidden='true'], " +
      ".ads, .ad, .advertisement, .comments, .comment-section, " +
      ".cookie-banner, .popup, .overlay, .modal, .newsletter, .share, " +
      ".social-share, .related-posts, .sidebar, .breadcrumb";
    clone.querySelectorAll(JUNK).forEach((el) => el.remove());

    // -- fix lazy-loaded images, then absolutize URLs
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return v; } };
    for (const img of clone.querySelectorAll("img")) {
      const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") ||
                   img.getAttribute("data-original");
      if (lazy && !img.getAttribute("src")) img.setAttribute("src", lazy);
      const src = img.getAttribute("src");
      if (src) img.setAttribute("src", abs(src));
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
    }
    for (const a of clone.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
        a.setAttribute("href", abs(href));
      }
    }

    // -- find the main content region (Readability-style scoring)
    const SEMANTIC = [
      "article", "[role='main']", "main", "#content", "#main-content",
      ".post-content", ".article-content", ".entry-content",
      ".content", ".post", ".entry", ".main",
    ];
    const POSITIVE = /article|body|content|entry|main|page|post|text|blog|story/i;
    const NEGATIVE = /comment|sidebar|foot|head|nav|menu|related|share|social|promo|advert|banner|widget|breadcrumb|pagination|masthead|meta|recommend/i;

    const bodyTextLen = Math.max((clone.textContent || "").trim().length, 1);
    let root = null;

    if (scope !== "full") {
      // 1) score containers by the text-bearing blocks they hold
      const scores = new Map();
      const bump = (el, pts) => {
        if (el && el !== clone) scores.set(el, (scores.get(el) || 0) + pts);
      };
      for (const node of clone.querySelectorAll("p, pre, blockquote, li")) {
        const len = (node.textContent || "").trim().length;
        if (len < (node.tagName === "LI" ? 30 : 25)) continue;
        let pts = 1 + Math.min(Math.floor(len / 100), 3);
        if (node.tagName === "LI") pts *= 0.5;
        bump(node.parentElement, pts);
        bump(node.parentElement?.parentElement, pts / 2);
      }

      // 2) adjust by class/id hints and link density, pick the winner
      let best = null;
      let bestScore = 0;
      for (const [el, raw] of scores) {
        const hint = `${el.getAttribute("class") || ""} ${el.id || ""}`;
        let score = raw;
        if (POSITIVE.test(hint)) score *= 1.25;
        if (NEGATIVE.test(hint)) score *= 0.4;
        const textLen = (el.textContent || "").length || 1;
        let linkLen = 0;
        for (const a of el.querySelectorAll("a")) linkLen += (a.textContent || "").length;
        score *= 1 - Math.min(linkLen / textLen, 1); // menus & link farms → ~0
        if (score > bestScore) { bestScore = score; best = el; }
      }

      if (best && (best.textContent || "").trim().length >= 250) {
        // 3) climb to pull in the article's own heading/byline wrappers,
        //    but stop before a parent that adds substantial extra text
        //    (real title wrappers add ~5-10%; menus and rails add far more)
        let node = best;
        for (let i = 0; i < 3; i++) {
          const parent = node.parentElement;
          if (!parent || parent === clone) break;
          const ratio = ((parent.textContent || "").length || 1) /
                        ((node.textContent || "").length || 1);
          if (ratio <= 1.15) node = parent;
          else break;
        }
        // 4) snap to a clean semantic boundary when one wraps us tightly
        let snapped = null;
        for (const sel of SEMANTIC) {
          for (const cand of clone.querySelectorAll(sel)) {
            if (!cand.contains(node)) continue;
            const ratio = ((cand.textContent || "").length || 1) /
                          ((node.textContent || "").length || 1);
            if (ratio <= 1.5 &&
                (!snapped || cand.textContent.length < snapped.textContent.length)) {
              snapped = cand;
            }
          }
        }
        root = snapped || node;
      } else {
        // no paragraph signal (rare) — first plausible semantic region
        for (const sel of SEMANTIC) {
          const found = clone.querySelector(sel);
          if (found && (found.textContent || "").trim().length > 200) { root = found; break; }
        }
      }
    }

    const picked = root || clone;
    const share = Math.min(
      100,
      Math.round(((picked.textContent || "").trim().length / bodyTextLen) * 100)
    );
    let html = picked.innerHTML;

    // -- same-origin iframe content (from the live document)
    const iframeParts = [];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc || !doc.body) continue;
        const ic = doc.body.cloneNode(true);
        ic.querySelectorAll("script, style, noscript, nav, footer, aside").forEach((el) => el.remove());
        const text = (ic.textContent || "").trim();
        if (text.length > 80) iframeParts.push(ic.innerHTML);
      } catch { /* cross-origin — skip */ }
    }
    if (iframeParts.length) {
      html += "<h2>Embedded content</h2>" + iframeParts.join("<hr>");
    }

    return {
      success: true,
      title: document.title || "Untitled page",
      url: location.href,
      html,
      usedMain: !!root,
      share,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/* ================================================================== *
 *  2. MARKDOWN CONVERSION
 * ================================================================== */
function buildTurndown(settings) {
  const service = new TurndownService({
    headingStyle: settings.headingStyle,
    bulletListMarker: settings.bulletListMarker,
    codeBlockStyle: settings.codeBlockStyle,
    hr: "---",
    emDelimiter: settings.emphasis,
    linkStyle: settings.links === "referenced" ? "referenced" : "inlined",
    linkReferenceStyle: "full",
  });

  // strip links → keep only their text
  if (settings.links === "strip") {
    service.addRule("stripLinks", {
      filter: (node) => node.nodeName === "A" && node.getAttribute("href"),
      replacement: (content) => content,
    });
  }

  // remove images entirely
  if (settings.images === "remove") {
    service.addRule("stripImages", { filter: "img", replacement: () => "" });
  }

  // <figure> → image + caption (or nothing when images are off)
  service.addRule("figures", {
    filter: "figure",
    replacement: (content, node) => {
      const img = node.querySelector("img");
      if (!img) return content;
      if (settings.images === "remove") return "";
      const alt = img.getAttribute("alt") || "";
      const src = img.getAttribute("src") || "";
      const caption = (node.querySelector("figcaption")?.textContent || "").trim();
      return `\n\n![${alt}](${src})` + (caption ? `\n*${caption}*` : "") + "\n\n";
    },
  });

  // GFM tables (core Turndown flattens them to plain text)
  service.addRule("gfmTables", {
    filter: "table",
    replacement: (content, node) => tableToMarkdown(node) || content,
  });
  service.addRule("tableInternals", {
    filter: ["thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col"],
    replacement: (content) => content,
  });

  return service;
}

function tableToMarkdown(table) {
  const cellText = (cell) =>
    (cell.textContent || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

  const rows = [];
  for (const tr of table.querySelectorAll("tr")) {
    if (tr.closest("table") !== table) continue; // skip nested tables
    const cells = [...tr.children].filter((c) => /^(TH|TD)$/.test(c.tagName));
    if (cells.length) rows.push(cells.map(cellText));
  }
  if (!rows.length) return null;

  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2 && rows.length < 2) return null; // not a real table
  const pad = (r) => { while (r.length < width) r.push(""); return r; };

  const hasHeader = !!table.querySelector("thead th, tr:first-child th");
  const header = hasHeader ? pad(rows.shift()) : new Array(width).fill(" ");
  const line = (cells) => "| " + cells.join(" | ") + " |";

  const out = [line(header), "| " + new Array(width).fill("---").join(" | ") + " |"];
  for (const r of rows) out.push(line(pad(r)));
  return "\n\n" + out.join("\n") + "\n\n";
}

function toMarkdown(page, settings) {
  const service = buildTurndown(settings);
  // don't duplicate the title if the content already starts with its own <h1>
  const hasH1 = /<h1[\s>]/i.test(page.html);
  const wrapped = (hasH1 ? "" : `<h1>${escapeHtml(page.title)}</h1>`) + page.html;
  let md = service.turndown(wrapped);
  md = md
    .replace(/^(\s*)([-*+])\s{2,}/gm, "$1$2 ") // "-   item" → "- item"
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (settings.frontmatter) {
    const date = new Date().toISOString().slice(0, 10);
    md = `---\ntitle: "${page.title.replace(/"/g, '\\"')}"\nurl: "${page.url}"\ndate: ${date}\n---\n\n` + md;
  }
  return md;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ================================================================== *
 *  3. SETTINGS
 * ================================================================== */
const DEFAULT_SETTINGS = {
  frontmatter: false,
  scope: "full",
  links: "inlined",
  images: "keep",
  emphasis: "_",
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = (await chrome.storage.local.get("settings")).settings;
    if (stored) settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch { /* defaults */ }
  $("setting-frontmatter").checked = settings.frontmatter;
  $("setting-scope").value = settings.scope;
  $("setting-links").value = settings.links;
  $("setting-images").value = settings.images;
  $("setting-emphasis").value = settings.emphasis;
  $("setting-heading").value = settings.headingStyle;
  $("setting-bullet").value = settings.bulletListMarker;
  $("setting-code").value = settings.codeBlockStyle;
}

async function saveSetting(key, value) {
  settings[key] = value;
  try { await chrome.storage.local.set({ settings }); } catch { /* */ }
}

/* ================================================================== *
 *  4. UTIL
 * ================================================================== */
const $ = (id) => document.getElementById(id);

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function slugify(title) {
  const s = String(title).toLowerCase()
    .replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g").replace(/[ıİi̇]/g, "i")
    .replace(/[öÖ]/g, "o").replace(/[şŞ]/g, "s").replace(/[üÜ]/g, "u")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "page";
}

let toastTimer = null;
function toast(message, kind = "info") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 1600);
}

function setBusy(busy) {
  const btn = $("convert-btn");
  btn.disabled = busy;
  btn.querySelector(".btn-label").textContent = busy ? "Converting…" : "Convert page";
  btn.classList.toggle("busy", busy);
}

function setOutput(md, note) {
  state.markdown = md;
  $("output").value = md;
  const words = md ? (md.match(/\S+/g) || []).length : 0;
  $("stats").textContent = md
    ? `${words.toLocaleString()} words · ${md.length.toLocaleString()} chars` + (note ? ` · ${note}` : "")
    : "";
  $("copy-btn").disabled = !md;
  $("download-btn").disabled = !md;
}

/* ================================================================== *
 *  5. ACTIONS
 * ================================================================== */
async function convert() {
  setBusy(true);
  try {
    const [tab] = await withTimeout(
      chrome.tabs.query({ active: true, currentWindow: true }),
      2500, "Couldn't read the active tab"
    );
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
      throw new Error("Open a normal web page (http/https) and try again.");
    }

    let res;
    try {
      [res] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractPageContent,
          args: [{ scope: settings.scope }],
        }),
        8000, "Page scan timed out"
      );
    } catch (e) {
      if (/Cannot access|chrome:\/\/|extension/i.test(e.message || "")) {
        throw new Error("This page can't be inspected by extensions.");
      }
      throw e;
    }

    const page = res?.result;
    if (!page?.success) throw new Error(page?.error || "Failed to extract page content");

    const md = toMarkdown(page, settings);
    state.title = page.title;
    state.url = page.url;
    setOutput(md, page.usedMain ? `main content · ~${page.share}% of page` : "full page");
    toast("Converted", "success");

    try {
      await chrome.storage.local.set({
        lastConversion: { url: page.url, title: page.title, markdown: md, at: Date.now() },
      });
    } catch { /* */ }
  } catch (error) {
    setOutput("");
    toast(error.message || "Conversion failed", "error");
  } finally {
    setBusy(false);
  }
}

async function restoreLast() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const last = (await chrome.storage.local.get("lastConversion")).lastConversion;
    if (last?.markdown && tab?.url === last.url) {
      state.title = last.title;
      state.url = last.url;
      setOutput(last.markdown, "restored");
    }
  } catch { /* fresh start */ }
}

async function copyOutput() {
  if (!state.markdown) return;
  try {
    await navigator.clipboard.writeText(state.markdown);
    toast("Copied to clipboard", "success");
  } catch {
    toast("Copy failed", "error");
  }
}

function downloadOutput() {
  if (!state.markdown) return;
  try {
    const blob = new Blob([state.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(state.title)}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Download started", "success");
  } catch {
    toast("Download failed", "error");
  }
}

/* ================================================================== *
 *  6. INIT
 * ================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await restoreLast();

  $("convert-btn").addEventListener("click", convert);
  $("copy-btn").addEventListener("click", copyOutput);
  $("download-btn").addEventListener("click", downloadOutput);

  $("settings-btn").addEventListener("click", () => {
    const panel = $("settings-panel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("settings-btn").classList.toggle("active", open);
    $("settings-btn").setAttribute("aria-expanded", open ? "true" : "false");
  });

  $("setting-frontmatter").addEventListener("change", (e) => saveSetting("frontmatter", e.target.checked));
  $("setting-scope").addEventListener("change", (e) => saveSetting("scope", e.target.value));
  $("setting-links").addEventListener("change", (e) => saveSetting("links", e.target.value));
  $("setting-images").addEventListener("change", (e) => saveSetting("images", e.target.value));
  $("setting-emphasis").addEventListener("change", (e) => saveSetting("emphasis", e.target.value));
  $("setting-heading").addEventListener("change", (e) => saveSetting("headingStyle", e.target.value));
  $("setting-bullet").addEventListener("change", (e) => saveSetting("bulletListMarker", e.target.value));
  $("setting-code").addEventListener("change", (e) => saveSetting("codeBlockStyle", e.target.value));
});
