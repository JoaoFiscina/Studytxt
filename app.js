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

function normalizePastedText(raw) {
  // 1) padroniza newlines
  let text = (raw || "").replace(/\r\n/g, "\n");

  // 2) blocos por linhas em branco (parágrafos)
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  // 3) em cada bloco, quebra simples vira espaço (bom p/ PDF)
  return blocks.map(b => b.replace(/\n+/g, " ").replace(/\s+/g, " ").trim());
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

// ---------- Paste handling (texto puro) ----------
editor.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  const blocks = normalizePastedText(text);

  const range = getSelectionRange();
  if (!range) return;

  // remove seleção atual
  range.deleteContents();

  const marker = document.createElement("span");
  marker.setAttribute("data-caret", "1");

  const frag = document.createDocumentFragment();
  blocks.forEach((b) => {
    const p = document.createElement("p");
    p.textContent = b;
    frag.appendChild(p);
  });

  frag.appendChild(marker);
  range.insertNode(frag);

  placeCaretAfter(marker);
  marker.remove();

  scheduleAutosave("Colado e formatado.");
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
}

$("btnAutoSections").addEventListener("click", autoSections);

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
});

// autosave em mudanças
editor.addEventListener("input", () => scheduleAutosave());
docTitle.addEventListener("input", () => scheduleAutosave());

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

$("btnExportTxt").addEventListener("click", exportTXT);
$("btnExportJson").addEventListener("click", exportJSON);

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

// ---------- Keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

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
});

// ---------- Init ----------
loadFromLocal();
renderNotes();
setStatus("Pronto. Cole um texto para começar.");
