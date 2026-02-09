/* Reader + Grifos (um documento)
   - Cola texto puro, organiza em parágrafos
   - Grifos por categorias (Ctrl+1..5)
   - Notas no painel lateral (recolhível)
   - Seções recolhíveis (manual + auto)
   - Busca
   - Auto-save no navegador + export TXT + export/import JSON
*/

const $ = (id) => document.getElementById(id);

const editor = $("editor");
const docTitle = $("docTitle");
const statusText = $("statusText");

const notesPanel = $("notesPanel");
const notesList = $("notesList");

const noteDialog = $("noteDialog");
const noteDialogSubtitle = $("noteDialogSubtitle");
const noteText = $("noteText");
const btnConfirmNote = $("btnConfirmNote");
const btnClean = $("btnClean");
const btnExportPdf = $("btnExportPdf");
const btnExportMd = $("btnExportMd");
const btnUndo = $("btnUndo");
const btnRedo = $("btnRedo");
const btnFocus = $("btnFocus");
const pasteModeSelect = $("pasteMode");
const pasteModeStatus = $("pasteModeStatus");

const fileImportJson = $("fileImportJson");

const STORAGE_KEY = "reader_grifos_v1_current";

const HLCATS = [
  { id: 1, name: "Definição", cls: "hl-1" },
  { id: 2, name: "Conduta", cls: "hl-2" },
  { id: 3, name: "Diagnóstico", cls: "hl-3" },
  { id: 4, name: "DDx/Armadilhas", cls: "hl-4" },
  { id: 5, name: "Evidência/Pérolas", cls: "hl-5" },
];

let state = {
  version: 1,
  title: "",
  contentHTML: "",
  notes: [], // {id, anchorType:'highlight'|'anchor', anchorId, excerpt, text, createdAt}
  savedAt: null,
};

let pendingNoteAnchor = null; // {anchorType, anchorId, excerpt}
let autosaveTimer = null;
let lastSelectionRange = null;
let historyTimer = null;
let pasteMode = "html";

const history = { undo: [], redo: [] };
const HISTORY_LIMIT = 40;

// ---------- Utils ----------
function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function escapeForTextExport(s) {
  return (s || "").replace(/\r/g, "");
}

function isSafeUrl(href) {
  if (!href) return false;
  if (href.startsWith("#")) return true;
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
  } catch (err) {
    return false;
  }
}

function isSafeLinkHref(href) {
  if (!href) return false;
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch (err) {
    return false;
  }
}

function isSafeImgSrc(src) {
  if (!src) return false;
  if (src.startsWith("data:image/")) return true;
  try {
    const url = new URL(src, window.location.href);
    return ["http:", "https:"].includes(url.protocol);
  } catch (err) {
    return false;
  }
}

function parsePlainTextToBlocks(raw) {
  const text = (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = text.split("\n").map(line => line.replace(/\s+$/g, ""));
  const hasBlankLines = lines.some(line => line.trim() === "");
  const nonEmptyLines = lines.filter(line => line.trim() !== "");
  const listPattern = /^\s*(?:[-•]\s+|\d+[.)]\s+)/;
  const hasListLines = nonEmptyLines.some(line => listPattern.test(line));
  const shouldSplitAllLines = !hasBlankLines && nonEmptyLines.length >= 4 && !hasListLines;

  if (shouldSplitAllLines) {
    return nonEmptyLines.map(line => ({
      type: "p",
      text: line.replace(/\s+/g, " ").trim(),
    }));
  }

  const blocks = [];
  const paragraphBuffer = [];
  let listItems = [];
  let listType = null;

  const flushParagraph = () => {
    if (!paragraphBuffer.length) return;
    const textValue = paragraphBuffer.join(" ").replace(/\s+/g, " ").trim();
    if (textValue) blocks.push({ type: "p", text: textValue });
    paragraphBuffer.length = 0;
  };

  const flushList = () => {
    if (!listItems.length || !listType) return;
    blocks.push({ type: listType, items: listItems.slice() });
    listItems = [];
    listType = null;
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }

    const bulletMatch = trimmed.match(/^\s*[-•]\s+(.*)$/);
    const orderedMatch = trimmed.match(/^\s*\d+[.)]\s+(.*)$/);

    if (bulletMatch || orderedMatch) {
      flushParagraph();
      const nextType = bulletMatch ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      const itemText = (bulletMatch ? bulletMatch[1] : orderedMatch[1]).replace(/\s+/g, " ").trim();
      if (itemText) listItems.push(itemText);
      return;
    }

    flushList();
    paragraphBuffer.push(trimmed);
  });

  flushParagraph();
  flushList();

  return blocks;
}

function normalizePastedTextSmart(raw) {
  return parsePlainTextToBlocks(raw);
}

function normalizePastedTextLines(raw) {
  const text = (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return text.split("\n").map(line => line.replace(/\s+$/g, "")).filter(line => line.trim() !== "");
}

function linesToListOrParagraphs(lines) {
  const frag = document.createDocumentFragment();
  let currentList = null;
  let currentListType = null;

  const flushList = () => {
    if (currentList) frag.appendChild(currentList);
    currentList = null;
    currentListType = null;
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const bulletMatch = trimmed.match(/^\s*[-•*]\s+(.*)$/);
    const orderedMatch = trimmed.match(/^\s*(?:\d+|[a-zA-Z])[.)]\s+(.*)$/);
    const isList = bulletMatch || orderedMatch;

    if (isList) {
      const listType = bulletMatch ? "ul" : "ol";
      if (!currentList || currentListType !== listType) {
        flushList();
        currentList = document.createElement(listType);
        currentListType = listType;
      }
      const textValue = (bulletMatch ? bulletMatch[1] : orderedMatch[1]).replace(/\s+/g, " ").trim();
      const li = document.createElement("li");
      li.textContent = textValue || trimmed;
      currentList.appendChild(li);
      return;
    }

    flushList();
    const p = document.createElement("p");
    p.textContent = trimmed.replace(/\s+/g, " ").trim();
    frag.appendChild(p);
  });

  flushList();
  return frag;
}

function buildFragmentFromBlocks(blocks) {
  const frag = document.createDocumentFragment();

  blocks.forEach((block) => {
    if (block.type === "p") {
      const p = document.createElement("p");
      p.textContent = block.text;
      frag.appendChild(p);
      return;
    }

    if (block.type === "ul" || block.type === "ol") {
      const list = document.createElement(block.type);
      block.items.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
      });
      frag.appendChild(list);
    }
  });

  return frag;
}

function wrapLooseTextNodes(container) {
  const nodes = Array.from(container.childNodes);
  nodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) {
        node.remove();
        return;
      }
      const p = document.createElement("p");
      p.textContent = text;
      container.replaceChild(p, node);
    }
  });
}

function sanitizeHTMLToFragment(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";

  const blockedTags = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);
  const allowedTags = new Set([
    "P", "BR", "STRONG", "B", "EM", "I", "U",
    "H1", "H2", "H3", "H4",
    "UL", "OL", "LI",
    "BLOCKQUOTE", "PRE", "CODE",
    "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
    "IMG", "A", "HR", "DIV", "SPAN",
    "DETAILS", "SUMMARY",
  ]);

  const unwrap = (el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  };

  const elements = [];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) elements.push(walker.currentNode);

  elements.forEach((el) => {
    const tag = el.tagName;
    if (blockedTags.has(tag)) {
      el.remove();
      return;
    }

    if (!allowedTags.has(tag)) {
      unwrap(el);
      return;
    }

    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "class") {
        el.removeAttribute(attr.name);
      }
    });

    if (tag === "A") {
      const href = (el.getAttribute("href") || "").trim();
      if (!isSafeLinkHref(href)) {
        el.removeAttribute("href");
      } else {
        el.setAttribute("href", href);
      }
      if (el.hasAttribute("title")) {
        el.setAttribute("title", el.getAttribute("title"));
      }
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
      Array.from(el.attributes).forEach((attr) => {
        if (!["href", "title", "target", "rel"].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      });
    } else if (tag === "IMG") {
      const src = (el.getAttribute("src") || "").trim();
      if (!isSafeImgSrc(src)) {
        el.remove();
        return;
      }
      el.setAttribute("src", src);
      Array.from(el.attributes).forEach((attr) => {
        if (!["src", "alt", "title"].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      });
    } else if (tag === "TH" || tag === "TD") {
      Array.from(el.attributes).forEach((attr) => {
        if (!["colspan", "rowspan"].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      });
    } else if (tag === "DETAILS") {
      Array.from(el.attributes).forEach((attr) => {
        if (!["open"].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      });
    } else {
      Array.from(el.attributes).forEach((attr) => {
        if (!["colspan", "rowspan"].includes(attr.name)) {
          el.removeAttribute(attr.name);
        }
      });
    }
  });

  wrapLooseTextNodes(template.content);
  return template.content;
}

function placeCaretAfter(node) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getSelectionRange() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return sel.getRangeAt(0);
}

function captureSelectionIfInsideEditor() {
  const range = getSelectionRange();
  if (!range) return;
  if (!editor.contains(range.commonAncestorContainer)) return;
  lastSelectionRange = range.cloneRange();
}

function restoreSelection() {
  if (!lastSelectionRange) return false;
  if (!editor.contains(lastSelectionRange.commonAncestorContainer)) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(lastSelectionRange);
  return true;
}

function findClosest(el, selector) {
  let cur = el;
  while (cur && cur !== editor) {
    if (cur.matches && cur.matches(selector)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function getExcerptFromRange(range, maxLen = 120) {
  const text = (range.toString() || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function clearSearchHighlights() {
  const hits = editor.querySelectorAll("span.search-hit[data-search='1']");
  hits.forEach(span => {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

function cleanFormatting() {
  clearSearchHighlights();

  const keepClass = new Set([
    "hl-1",
    "hl-2",
    "hl-3",
    "hl-4",
    "hl-5",
    "note-anchor",
    "section",
    "search-hit",
  ]);

  const all = Array.from(editor.querySelectorAll("*"));
  for (const el of all) {
    el.removeAttribute("style");

    if (el.classList && el.classList.length) {
      const keep = Array.from(el.classList).filter(c => keepClass.has(c));
      el.className = keep.join(" ");
      if (!el.className) el.removeAttribute("class");
    }

    ["align", "width", "height", "color", "bgcolor"].forEach(a => el.removeAttribute(a));

    if (el.tagName === "A") {
      const href = (el.getAttribute("href") || "").trim();
      if (!isSafeUrl(href)) el.removeAttribute("href");
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }

    if (el.tagName === "IMG") {
      const src = (el.getAttribute("src") || "").trim();
      if (!isSafeImgSrc(src)) el.remove();
    }

    if (el.tagName === "SPAN" && !el.className && el.attributes.length === 0) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }

  editor.normalize();
  scheduleAutosave("Formatação limpa.");
  pushHistory("clean");
}

function insertFragmentAtRange(fragment, range) {
  if (!range) return;
  range.deleteContents();
  const marker = document.createElement("span");
  marker.setAttribute("data-caret", "1");
  fragment.appendChild(marker);
  range.insertNode(fragment);
  placeCaretAfter(marker);
  marker.remove();
}

function updatePasteModeStatus() {
  const labels = {
    html: "Estrutura",
    plain: "Texto limpo",
    lines: "Texto + quebras",
  };
  if (pasteModeStatus) {
    pasteModeStatus.textContent = `Colar: ${labels[pasteMode] || "Estrutura"}`;
  }
}

function getSelectionCharacterOffsetsWithin(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const preRange = range.cloneRange();
  preRange.selectNodeContents(root);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;

  const preRangeEnd = range.cloneRange();
  preRangeEnd.selectNodeContents(root);
  preRangeEnd.setEnd(range.endContainer, range.endOffset);
  const end = preRangeEnd.toString().length;

  return { start, end };
}

function setSelectionByCharacterOffsets(root, start, end) {
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentNode = null;
  let charIndex = 0;
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;

  while (walker.nextNode()) {
    currentNode = walker.currentNode;
    const nextIndex = charIndex + currentNode.nodeValue.length;

    if (startNode === null && start <= nextIndex) {
      startNode = currentNode;
      startOffset = Math.max(0, start - charIndex);
    }

    if (endNode === null && end <= nextIndex) {
      endNode = currentNode;
      endOffset = Math.max(0, end - charIndex);
      break;
    }

    charIndex = nextIndex;
  }

  if (!startNode || !endNode) {
    const last = root.lastChild;
    if (last) {
      range.selectNodeContents(last);
      range.collapse(false);
    } else {
      range.setStart(root, 0);
      range.collapse(true);
    }
  } else {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
  }

  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function captureSnapshot() {
  const offsets = getSelectionCharacterOffsetsWithin(editor);
  return {
    editorHTML: editor.innerHTML,
    notes: JSON.parse(JSON.stringify(state.notes || [])),
    title: docTitle.value || "",
    selStart: offsets ? offsets.start : null,
    selEnd: offsets ? offsets.end : null,
  };
}

function pushHistory(reason) {
  const snap = captureSnapshot();
  const last = history.undo[history.undo.length - 1];
  if (last && last.editorHTML === snap.editorHTML && JSON.stringify(last.notes) === JSON.stringify(snap.notes) && last.title === snap.title) {
    return;
  }
  history.undo.push(snap);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
}

function restoreSnapshot(snap) {
  if (!snap) return;
  editor.innerHTML = snap.editorHTML;
  state.notes = Array.isArray(snap.notes) ? snap.notes : [];
  docTitle.value = snap.title || "";
  renderNotes();
  if (typeof snap.selStart === "number" && typeof snap.selEnd === "number") {
    setSelectionByCharacterOffsets(editor, snap.selStart, snap.selEnd);
  }
}

function undo() {
  if (history.undo.length < 2) return;
  const current = history.undo.pop();
  history.redo.push(current);
  const previous = history.undo[history.undo.length - 1];
  restoreSnapshot(previous);
  scheduleAutosave("Undo.");
}

function redo() {
  if (!history.redo.length) return;
  const next = history.redo.pop();
  history.undo.push(next);
  restoreSnapshot(next);
  scheduleAutosave("Redo.");
}

function scheduleHistoryPush(reason) {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    pushHistory(reason || "typing");
  }, 800);
}

// ---------- Paste handling ----------
editor.addEventListener("paste", (e) => {
  e.preventDefault();
  const range = getSelectionRange();
  if (!range) return;

  const clipboard = e.clipboardData || window.clipboardData;
  const html = clipboard.getData("text/html");
  const text = clipboard.getData("text/plain");

  if (pasteMode === "html" && html) {
    const fragment = sanitizeHTMLToFragment(html);
    insertFragmentAtRange(fragment, range);
    scheduleAutosave("Colado com formatação.");
    pushHistory("paste");
    return;
  }

  if (pasteMode === "lines") {
    const lines = normalizePastedTextLines(text);
    const frag = linesToListOrParagraphs(lines);
    insertFragmentAtRange(frag, range);
    scheduleAutosave("Colado com quebras.");
    pushHistory("paste");
    return;
  }

  const blocks = normalizePastedTextSmart(text);
  const frag = buildFragmentFromBlocks(blocks);
  insertFragmentAtRange(frag, range);
  scheduleAutosave("Colado e formatado.");
  pushHistory("paste");
});

// ---------- Highlights ----------
function wrapRangeWithElement(range, el) {
  const contents = range.extractContents();
  el.appendChild(contents);
  range.insertNode(el);
  return el;
}

function applyHighlight(catId) {
  clearSearchHighlights();
  restoreSelection();
  const cat = HLCATS.find(c => c.id === catId);
  if (!cat) return;

  const range = getSelectionRange();
  if (!range || range.collapsed) {
    setStatus("Selecione um trecho para grifar.");
    return;
  }

  // evita tentar grifar fora do editor
  if (!editor.contains(range.commonAncestorContainer)) {
    setStatus("Selecione dentro do texto.");
    return;
  }

  const mark = document.createElement("mark");
  mark.className = `${cat.cls}`;
  mark.setAttribute("data-cat", String(catId));
  const hid = uuid();
  mark.setAttribute("data-hid", hid);
  mark.title = cat.name;

  try {
    wrapRangeWithElement(range, mark);
  } catch (err) {
    // fallback: se o surround falhar em seleções complexas
    setStatus("Não consegui grifar essa seleção (tente selecionar menos).");
    return;
  }

  // normaliza seleção para dentro do mark
  const sel = window.getSelection();
  sel.removeAllRanges();
  const r2 = document.createRange();
  r2.selectNodeContents(mark);
  sel.addRange(r2);

  scheduleAutosave(`Grifo: ${cat.name}`);
  pushHistory("highlight");
}

// Botões de highlight
document.querySelectorAll(".hlBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    const catId = Number(btn.getAttribute("data-cat"));
    applyHighlight(catId);
  });
});

// ---------- Notes ----------
function openNoteDialog(subtitle) {
  noteDialogSubtitle.textContent = subtitle || "";
  noteText.value = "";
  noteDialog.showModal();
  noteText.focus();
}

function createAnchorFromSelection() {
  const range = getSelectionRange();
  if (!range || range.collapsed) return null;
  if (!editor.contains(range.commonAncestorContainer)) return null;

  const excerpt = getExcerptFromRange(range);
  const span = document.createElement("span");
  const aid = uuid();
  span.className = "note-anchor";
  span.setAttribute("data-aid", aid);
  span.title = "Trecho com nota";
  wrapRangeWithElement(range, span);

  return { anchorType: "anchor", anchorId: aid, excerpt };
}

function getHighlightUnderCursorOrSelection() {
  const sel = window.getSelection();
  if (!sel) return null;

  // se houver range, tenta achar mark a partir do startContainer
  if (sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    let node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
    if (!node) return null;
    const mark = findClosest(node, "mark[data-hid]");
    if (mark) {
      return { anchorType: "highlight", anchorId: mark.getAttribute("data-hid"), excerpt: (mark.innerText || "").trim().slice(0, 120) };
    }
  }
  return null;
}

function addNoteFlow() {
  clearSearchHighlights();
  restoreSelection();

  // prioridade 1: nota ligada a grifo sob cursor
  const hl = getHighlightUnderCursorOrSelection();
  if (hl) {
    pendingNoteAnchor = hl;
    openNoteDialog(`Nota vinculada ao grifo: "${hl.excerpt}"`);
    return;
  }

  // prioridade 2: cria âncora na seleção
  const range = getSelectionRange();
  if (range && !range.collapsed) {
    const anchor = createAnchorFromSelection();
    if (anchor) {
      pendingNoteAnchor = anchor;
      openNoteDialog(`Nota vinculada ao trecho: "${anchor.excerpt}"`);
      scheduleAutosave("Âncora de nota criada.");
      pushHistory("note-anchor");
      return;
    }
  }

  setStatus("Para criar nota: coloque o cursor dentro de um grifo OU selecione um trecho.");
}

$("btnNote").addEventListener("click", addNoteFlow);

btnConfirmNote.addEventListener("click", (e) => {
  e.preventDefault();
  const text = (noteText.value || "").trim();
  if (!text) {
    setStatus("Nota vazia.");
    noteDialog.close();
    pendingNoteAnchor = null;
    return;
  }
  if (!pendingNoteAnchor) {
    setStatus("Não há trecho vinculado.");
    noteDialog.close();
    return;
  }

  const note = {
    id: uuid(),
    anchorType: pendingNoteAnchor.anchorType,
    anchorId: pendingNoteAnchor.anchorId,
    excerpt: pendingNoteAnchor.excerpt || "",
    text,
    createdAt: new Date().toISOString(),
  };
  state.notes.unshift(note);
  renderNotes();
  noteDialog.close();
  pendingNoteAnchor = null;

  scheduleAutosave("Nota salva.");
  pushHistory("note");
});

// Clique no texto para focar nota
editor.addEventListener("click", (e) => {
  const t = e.target;
  const mark = t && t.closest ? t.closest("mark[data-hid]") : null;
  const anchor = t && t.closest ? t.closest("span.note-anchor[data-aid]") : null;

  if (mark) {
    flashElement(mark);
  } else if (anchor) {
    flashElement(anchor);
  }
});

function flashElement(el) {
  el.style.outline = "2px solid rgba(17,24,39,.18)";
  el.style.outlineOffset = "3px";
  setTimeout(() => {
    el.style.outline = "";
    el.style.outlineOffset = "";
  }, 500);
}

function scrollToAnchor(note) {
  const sel = note.anchorType === "highlight"
    ? editor.querySelector(`mark[data-hid="${CSS.escape(note.anchorId)}"]`)
    : editor.querySelector(`span.note-anchor[data-aid="${CSS.escape(note.anchorId)}"]`);

  if (sel) {
    sel.scrollIntoView({ behavior: "smooth", block: "center" });
    flashElement(sel);
  }
}

function renderNotes() {
  notesList.innerHTML = "";
  if (!state.notes.length) {
    const empty = document.createElement("div");
    empty.style.color = "var(--muted)";
    empty.style.fontSize = "13px";
    empty.textContent = "Sem notas ainda.";
    notesList.appendChild(empty);
    return;
  }

  state.notes.forEach(note => {
    const card = document.createElement("div");
    card.className = "noteCard";
    card.addEventListener("click", () => scrollToAnchor(note));

    const meta = document.createElement("div");
    meta.className = "noteCard__meta";
    const when = new Date(note.createdAt);
    meta.textContent = `${when.toLocaleString()} • ${note.excerpt || "(sem trecho)"}`;

    const text = document.createElement("div");
    text.className = "noteCard__text";
    text.textContent = note.text;

    card.appendChild(meta);
    card.appendChild(text);
    notesList.appendChild(card);
  });
}

// ---------- Sections ----------
function createSectionFromSelection() {
  clearSearchHighlights();
  restoreSelection();

  const range = getSelectionRange();
  if (!range || range.collapsed) {
    setStatus("Selecione um trecho para virar seção.");
    return;
  }
  if (!editor.contains(range.commonAncestorContainer)) {
    setStatus("Selecione dentro do texto.");
    return;
  }

  const title = prompt("Título da seção:", "Seção");
  if (title === null) return;

  const details = document.createElement("details");
  details.className = "section";
  details.open = true;
  details.setAttribute("data-sid", uuid());

  const summary = document.createElement("summary");
  summary.textContent = (title || "Seção").trim();
  summary.setAttribute("contenteditable", "true");

  details.appendChild(summary);

  try {
    const contents = range.extractContents();
    details.appendChild(contents);
    range.insertNode(details);
    placeCaretAfter(details);
  } catch (err) {
    setStatus("Não consegui criar seção com essa seleção (tente selecionar menos).");
    return;
  }

  scheduleAutosave("Seção criada.");
  pushHistory("section");
}

$("btnSection").addEventListener("click", createSectionFromSelection);

function isHeadingLine(t) {
  const s = (t || "").trim();
  if (!s) return false;
  if (s.length > 90) return false;

  const looksNumbered = /^\d+(\.\d+)*\s+\S+/.test(s);
  const endsWithColon = /:\s*$/.test(s);

  // uppercase ratio heuristic
  const letters = s.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  let upper = 0;
  for (const ch of letters) {
    if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upper++;
  }
  const ratio = letters.length ? (upper / letters.length) : 0;
  const looksCaps = letters.length >= 6 && ratio >= 0.75;

  return looksNumbered || endsWithColon || looksCaps;
}

function autoSections() {
  clearSearchHighlights();

  // 1) converter parágrafos que parecem "título" em h2
  const paras = Array.from(editor.querySelectorAll("p"));
  paras.forEach(p => {
    const t = (p.innerText || "").trim();
    if (isHeadingLine(t)) {
      const h2 = document.createElement("h2");
      h2.textContent = t.replace(/:\s*$/, "");
      p.replaceWith(h2);
    }
  });

  // 2) wrap por h2
  const nodes = Array.from(editor.childNodes);
  const out = document.createDocumentFragment();

  let currentDetails = null;

  function flushDetails() {
    if (currentDetails) {
      out.appendChild(currentDetails);
      currentDetails = null;
    }
  }

  nodes.forEach(node => {
    if (node.nodeType === 1 && node.tagName === "H2") {
      flushDetails();
      const details = document.createElement("details");
      details.className = "section";
      details.open = true;
      details.setAttribute("data-sid", uuid());

      const summary = document.createElement("summary");
      summary.textContent = (node.innerText || "Seção").trim();
      summary.setAttribute("contenteditable", "true");

      details.appendChild(summary);
      currentDetails = details;
    } else {
      if (currentDetails) currentDetails.appendChild(node);
      else out.appendChild(node);
    }
  });

  flushDetails();
  editor.innerHTML = "";
  editor.appendChild(out);

  scheduleAutosave("Auto-seções aplicadas.");
  pushHistory("autosections");
}

$("btnAutoSections").addEventListener("click", autoSections);

if (btnClean) {
  btnClean.addEventListener("click", cleanFormatting);
}

if (btnExportPdf) {
  btnExportPdf.addEventListener("click", () => {
    window.print();
  });
}

// ---------- Search ----------
$("searchInput").addEventListener("input", () => {
  const q = $("searchInput").value.trim();
  clearSearchHighlights();
  if (!q) {
    setStatus("Busca limpa.");
    return;
  }
  applySearch(q);
});

$("btnClearSearch").addEventListener("click", () => {
  $("searchInput").value = "";
  clearSearchHighlights();
  setStatus("Busca limpa.");
});

function applySearch(query) {
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(q, "gi");

  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // não mexe em summaries (títulos de seção) para evitar quebra de UX
      const p = node.parentNode;
      if (p && p.closest && p.closest("summary")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let hits = 0;

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach(textNode => {
    const text = textNode.nodeValue;
    if (!re.test(text)) return;

    re.lastIndex = 0;
    const frag = document.createDocumentFragment();

    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;

      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));

      const span = document.createElement("span");
      span.className = "search-hit";
      span.setAttribute("data-search", "1");
      span.textContent = text.slice(start, end);
      frag.appendChild(span);

      hits++;
      last = end;
    }

    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));

    textNode.parentNode.replaceChild(frag, textNode);
  });

  if (hits) {
    const first = editor.querySelector("span.search-hit[data-search='1']");
    if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus(`Busca: ${hits} ocorrência(s).`);
  } else {
    setStatus("Busca: 0 ocorrência(s).");
  }
}

// ---------- Save / Load ----------
function scheduleAutosave(msg) {
  if (msg) setStatus(msg);

  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    saveToLocal("Auto-salvo.");
  }, 550);
}

function saveToLocal(msg) {
  clearSearchHighlights();
  state.title = (docTitle.value || "").trim();
  state.contentHTML = editor.innerHTML;
  state.savedAt = new Date().toISOString();

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (msg) setStatus(`${msg} (${new Date(state.savedAt).toLocaleTimeString()})`);
}

function loadFromLocal() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (!data || !data.contentHTML) return;

    state = {
      version: 1,
      title: data.title || "",
      contentHTML: data.contentHTML || "",
      notes: Array.isArray(data.notes) ? data.notes : [],
      savedAt: data.savedAt || null,
    };

    docTitle.value = state.title || "";
    editor.innerHTML = state.contentHTML || "";
    renderNotes();

    if (state.savedAt) {
      setStatus(`Recuperado do navegador. (Último save: ${new Date(state.savedAt).toLocaleString()})`);
    } else {
      setStatus("Recuperado do navegador.");
    }
  } catch (e) {
    // se der erro, ignora
  }
}

$("btnSave").addEventListener("click", () => saveToLocal("Salvo."));
$("btnNew").addEventListener("click", () => {
  const ok = confirm("Criar novo documento? Isso limpa o atual (o antigo fica só se você exportou).");
  if (!ok) return;
  editor.innerHTML = "";
  docTitle.value = "";
  state = { version: 1, title: "", contentHTML: "", notes: [], savedAt: null };
  renderNotes();
  saveToLocal("Novo documento criado.");
  pushHistory("new");
});

// autosave em mudanças
editor.addEventListener("input", () => {
  scheduleAutosave();
  scheduleHistoryPush("typing");
});
docTitle.addEventListener("input", () => {
  scheduleAutosave();
  scheduleHistoryPush("title");
});
editor.addEventListener("mouseup", captureSelectionIfInsideEditor);
editor.addEventListener("keyup", captureSelectionIfInsideEditor);
document.addEventListener("selectionchange", captureSelectionIfInsideEditor);

document.querySelectorAll("button, label.toggle").forEach((el) => {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    restoreSelection();
  });
});

function escapeMarkdownText(text) {
  return (text || "").replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdownText(node.nodeValue || "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;

  if (tag === "STRONG" || tag === "B") {
    return `**${serializeMarkdownChildren(node)}**`;
  }
  if (tag === "EM" || tag === "I") {
    return `*${serializeMarkdownChildren(node)}*`;
  }
  if (tag === "CODE") {
    const content = (node.textContent || "").replace(/`/g, "\\`");
    return `\`${content}\``;
  }
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    const text = serializeMarkdown(node) || href;
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "IMG") {
    const alt = node.getAttribute("alt") || "";
    const src = node.getAttribute("src") || "";
    return src ? `![${escapeMarkdownText(alt)}](${src})` : "";
  }
  if (tag === "MARK") {
    return node.outerHTML;
  }
  if (tag === "BR") {
    return "  \n";
  }

  return serializeMarkdownChildren(node);
}

function serializeMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdownText(node.nodeValue || "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;

  if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4") {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${serializeMarkdownChildren(node)}\n\n`;
  }

  if (tag === "P" || tag === "DIV") {
    const content = serializeMarkdownChildren(node).trim();
    return content ? `${content}\n\n` : "\n";
  }

  if (tag === "UL" || tag === "OL") {
    const items = Array.from(node.children).filter((child) => child.tagName === "LI");
    return items.map((li, idx) => {
      const prefix = tag === "OL" ? `${idx + 1}. ` : "- ";
      const text = serializeMarkdownChildren(li).trim();
      return `${prefix}${text}`;
    }).join("\n") + "\n\n";
  }

  if (tag === "BLOCKQUOTE") {
    const text = serializeMarkdownChildren(node).trim();
    const lines = text.split("\n").map(line => `> ${line}`);
    return `${lines.join("\n")}\n\n`;
  }

  if (tag === "PRE") {
    const content = node.textContent || "";
    return `\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }

  if (tag === "TABLE") {
    return `${tableToMarkdown(node)}\n\n`;
  }

  if (tag === "DETAILS") {
    const summary = node.querySelector("summary");
    const summaryText = summary ? serializeMarkdownChildren(summary).trim() : "Seção";
    const bodyNodes = Array.from(node.childNodes).filter((child) => child !== summary);
    const body = bodyNodes.map(child => serializeMarkdown(child)).join("").trim();
    return `\n\n### ${summaryText}\n\n${body}\n\n`;
  }

  return serializeMarkdownChildren(node);
}

function serializeMarkdownChildren(node) {
  return Array.from(node.childNodes).map(child => inlineMarkdown(child)).join("");
}

function tableToMarkdown(table) {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";

  const getCells = (row) => Array.from(row.querySelectorAll("th, td")).map(cell => {
    const text = (cell.textContent || "").trim().replace(/\s+/g, " ");
    return text.replace(/\|/g, "\\|");
  });

  const firstRowCells = getCells(rows[0]);
  if (!firstRowCells.length) return "";
  const header = firstRowCells;
  const separator = header.map(() => "---");
  const bodyRows = rows.slice(1).map(getCells).filter(cells => cells.length);

  const lines = [];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${separator.join(" | ")} |`);
  bodyRows.forEach((cells) => {
    const filled = cells.concat(Array(Math.max(0, header.length - cells.length)).fill(""));
    lines.push(`| ${filled.join(" | ")} |`);
  });

  return lines.join("\n");
}

// ---------- Export / Import ----------
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportTXT() {
  clearSearchHighlights();
  const title = (docTitle.value || "documento").trim() || "documento";
  const body = escapeForTextExport(editor.innerText || "");

  let notesText = "";
  if (state.notes.length) {
    notesText += "\n\n=== NOTAS ===\n";
    state.notes.forEach((n, idx) => {
      notesText += `\n[${idx + 1}] ${n.excerpt ? `"${n.excerpt}"` : "(sem trecho)"}\n${n.text}\n`;
    });
  }

  downloadFile(`${title}.txt`, body + notesText, "text/plain;charset=utf-8");
  setStatus("TXT exportado.");
}

function exportJSON() {
  saveToLocal();
  const title = (docTitle.value || "documento").trim() || "documento";
  downloadFile(`${title}.json`, JSON.stringify(state, null, 2), "application/json;charset=utf-8");
  setStatus("JSON exportado.");
}

function exportMarkdown() {
  clearSearchHighlights();
  const title = (docTitle.value || "documento").trim() || "documento";
  const content = Array.from(editor.childNodes).map(node => serializeMarkdown(node)).join("").trim();
  let md = content || "";

  if (state.notes.length) {
    md += "\n\n## Notas\n";
    state.notes.forEach((note) => {
      const excerpt = note.excerpt ? `“${note.excerpt}”` : "(sem trecho)";
      md += `- **Trecho:** ${excerpt}\n  **Nota:** ${note.text}\n`;
    });
  }

  downloadFile(`${title}.md`, md, "text/markdown;charset=utf-8");
  setStatus("Markdown exportado.");
}

$("btnExportTxt").addEventListener("click", exportTXT);
$("btnExportJson").addEventListener("click", exportJSON);
if (btnExportMd) btnExportMd.addEventListener("click", exportMarkdown);

fileImportJson.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (!data || !data.contentHTML) throw new Error("Formato inválido");

    state = {
      version: 1,
      title: data.title || "",
      contentHTML: data.contentHTML || "",
      notes: Array.isArray(data.notes) ? data.notes : [],
      savedAt: data.savedAt || null,
    };

    docTitle.value = state.title || "";
    editor.innerHTML = state.contentHTML || "";
    renderNotes();
    saveToLocal("Importado e salvo.");
    setStatus("JSON importado.");
    pushHistory("import");
  } catch (err) {
    alert("JSON inválido ou incompatível.");
  } finally {
    fileImportJson.value = "";
  }
});

// ---------- Notes panel toggle ----------
function toggleNotes() {
  notesPanel.classList.toggle("is-collapsed");
}
$("btnToggleNotes").addEventListener("click", toggleNotes);
$("btnCollapseNotes").addEventListener("click", toggleNotes);

function toggleFocusMode() {
  document.body.classList.toggle("is-focus");
  const isFocus = document.body.classList.contains("is-focus");
  localStorage.setItem(`${STORAGE_KEY}_focus`, isFocus ? "1" : "0");
  setStatus(isFocus ? "Modo foco ativado." : "Modo foco desativado.");
}

if (btnFocus) {
  btnFocus.addEventListener("click", toggleFocusMode);
}

if (btnUndo) btnUndo.addEventListener("click", undo);
if (btnRedo) btnRedo.addEventListener("click", redo);

if (pasteModeSelect) {
  pasteModeSelect.addEventListener("change", () => {
    pasteMode = pasteModeSelect.value || "html";
    updatePasteModeStatus();
    setStatus(`Modo de colagem: ${pasteModeStatus.textContent.replace("Colar: ", "")}.`);
  });
}

// ---------- Keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }

  if (ctrl && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
    e.preventDefault();
    redo();
    return;
  }

  // Ctrl+K busca
  if (ctrl && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("searchInput").focus();
    return;
  }

  // Ctrl+B alterna notas
  if (ctrl && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleNotes();
    return;
  }

  // Ctrl+S salvar
  if (ctrl && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveToLocal("Salvo.");
    return;
  }

  // Grifos Ctrl+1..5
  if (ctrl && ["1","2","3","4","5"].includes(e.key)) {
    e.preventDefault();
    applyHighlight(Number(e.key));
    return;
  }

  // Ctrl+Shift+N nova nota
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    addNoteFlow();
    return;
  }

  // Ctrl+Shift+H criar seção
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "h") {
    e.preventDefault();
    createSectionFromSelection();
    return;
  }

  // Ctrl+Shift+E export TXT
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    exportTXT();
    return;
  }

  // Ctrl+Shift+J export JSON
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "j") {
    e.preventDefault();
    exportJSON();
    return;
  }

  // Ctrl+Shift+I import JSON (abre seletor)
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "i") {
    e.preventDefault();
    fileImportJson.click();
    return;
  }

  // Ctrl+Shift+F modo foco
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    toggleFocusMode();
    return;
  }
});

// ---------- Init ----------
loadFromLocal();
renderNotes();
if (pasteModeSelect) {
  pasteMode = pasteModeSelect.value || "html";
  updatePasteModeStatus();
}
const focusPref = localStorage.getItem(`${STORAGE_KEY}_focus`);
if (focusPref === "1") {
  document.body.classList.add("is-focus");
}
pushHistory("init");
setStatus("Pronto. Cole um texto para começar.");
