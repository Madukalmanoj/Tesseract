// OmniExtract — Popup Script

let extractedData = null;
let currentProvider = "groq";

const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let isSupported = false;
  try {
    const h = new URL(tab.url).hostname;
    const badge = $("platBadge");
    if (h.includes("claude.ai"))  { badge.textContent = "Claude";  badge.className = "plat claude"; isSupported = true; }
    else if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) { badge.textContent = "ChatGPT"; badge.className = "plat chatgpt"; isSupported = true; }
    else if (h.includes("gemini.google.com")) { badge.textContent = "Gemini"; badge.className = "plat gemini"; isSupported = true; }
    else if (h.includes("grok.com") || h.includes("x.com")) { badge.textContent = "Grok"; badge.className = "plat grok"; isSupported = true; }
    else { badge.textContent = "N/A"; showStatus("extractStatus","err","Platform not supported."); $("btnExtract").disabled = true; }
  } catch(_) {}

  if (!isSupported) {
    document.querySelectorAll(".tport-btn").forEach(b => b.disabled = true);
  }

  const stored = await chrome.storage.local.get(["apiKeys","lastProvider","llmEnabled"]);
  if (stored.lastProvider) setProvider(stored.lastProvider);
  if (stored.apiKeys?.[currentProvider]) $("apiKeyInput").value = stored.apiKeys[currentProvider];

  // Restore LLM enabled state
  if (stored.llmEnabled) {
    $("llmEnabled").checked = true;
    $("llmSection").classList.add("expanded");
    updateProviderBadge();
  }

  renderCapsuleList();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("tab-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "capsules") renderCapsuleList();
  });
});

// ── LLM toggle ────────────────────────────────────────────────────────────────
$("llmEnabled").addEventListener("change", () => {
  const on = $("llmEnabled").checked;
  $("llmSection").classList.toggle("expanded", on);
  chrome.storage.local.set({ llmEnabled: on });
  updateProviderBadge();
});

function updateProviderBadge() {
  const on = $("llmEnabled").checked;
  $("llmProviderBadge").textContent = on ? currentProvider : "";
}

// ── Provider tabs ─────────────────────────────────────────────────────────────
document.querySelectorAll(".pvt").forEach(btn => {
  btn.addEventListener("click", () => {
    setProvider(btn.dataset.prov);
    chrome.storage.local.get(["apiKeys"], r => {
      $("apiKeyInput").value = r.apiKeys?.[currentProvider] || "";
    });
  });
});

function setProvider(prov) {
  currentProvider = prov;
  document.querySelectorAll(".pvt").forEach(b => b.classList.toggle("sel", b.dataset.prov === prov));
  chrome.storage.local.set({ lastProvider: prov });
  updateProviderBadge();
}

$("toggleKey").addEventListener("click", () => {
  const inp = $("apiKeyInput");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "hide" : "show";
});

$("apiKeyInput").addEventListener("change", async () => {
  const key = $("apiKeyInput").value.trim();
  const r = await chrome.storage.local.get(["apiKeys"]);
  const keys = r.apiKeys || {};
  keys[currentProvider] = key;
  chrome.storage.local.set({ apiKeys: keys });
});

// ── Extract ───────────────────────────────────────────────────────────────────
// ── Extract ───────────────────────────────────────────────────────────────────
async function runExtractionFlow(shouldSave = false) {
  extractedData = null;
  $("extractResults").style.display = "none";
  $("imgPreview").style.display = "none";
  $("fileList").style.display = "none";
  $("imgGrid").innerHTML = "";
  $("fileItems").innerHTML = "";

  const useLLM = $("llmEnabled").checked;
  const apiKey = $("apiKeyInput").value.trim();

  if (useLLM && !apiKey) {
    showStatus("extractStatus","err","LLM is enabled — paste an API key first.");
    return null;
  }

  showStatus("extractStatus","info",'<span class="spin"></span>Extracting chat…');
  $("btnExtract").disabled = true;
  document.querySelectorAll(".tport-btn").forEach(b => b.disabled = true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.tabs.sendMessage(tab.id, { action: "extract" });
    if (!res?.success) throw new Error(res?.error || "Content script error");
    extractedData = res.data;

    // Auto-fill capsule name
    if (!$("capNameInput").value) {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      $("capNameInput").value = (t?.title || "Chat").replace(/ [-|].*$/, "").trim().slice(0, 50);
    }

    const capsuleName = $("capNameInput").value.trim() || "Chat Capsule";

    // Check if the chat has any assistant/AI responses
    const hasAssistant = (extractedData.messages || []).some(m => m.role === 'assistant');

    // LLM refine — only perform if LLM is enabled AND there is actual assistant/AI response history to refine
    let refinedText = null;
    if (useLLM && hasAssistant) {
      showStatus("extractStatus","info",`<span class="spin"></span>Extracting… then refining with ${currentProvider}…`);
      try {
        const chatText = cleanForLLM(buildPlainText(extractedData));
        const r2 = await chrome.runtime.sendMessage({ action: "llmRefine", provider: currentProvider, apiKey, chatText, capsuleName });
        if (r2.error) throw new Error(r2.error);
        refinedText = r2.text;
      } catch(e) {
        showStatus("extractStatus","warn","⚠ LLM refine failed: " + e.message + " — saving raw text.");
      }
    }

    // Determine default prompt text (if not LLM-refined)
    let defaultPromptText;
    if (!hasAssistant) {
      // Direct raw user messages without headers/tags for simple single-turn prompts
      defaultPromptText = (extractedData.messages || [])
        .map(m => cleanForLLM(m.text))
        .filter(Boolean)
        .join('\n\n');
    } else {
      defaultPromptText = buildPlainText(extractedData);
    }

    const cap = {
      id: Date.now().toString(),
      name: capsuleName,
      promptText: refinedText || defaultPromptText,
      rawText: buildPlainText(extractedData),
      images: (extractedData.allImages||[]).filter(i=>i.dataUrl),
      files: (extractedData.allFiles||[]),
      platform: extractedData.platform,
      sourceUrl: extractedData.url,
      createdAt: new Date().toISOString(),
      llmRefined: !!refinedText,
    };

    // Save capsule automatically only if requested
    if (shouldSave) {
      await saveCapsule(cap);
    }

    renderExtractResults(extractedData, refinedText);
    return cap;

  } catch(e) {
    showStatus("extractStatus","err","Error: " + e.message);
    return null;
  } finally {
    $("btnExtract").disabled = false;
    // Re-enable teleport buttons only if we are on a supported platform
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      try {
        const h = new URL(tab.url).hostname;
        const isSupported = h.includes("claude.ai") || h.includes("chatgpt.com") || h.includes("chat.openai.com") || h.includes("gemini.google.com") || h.includes("grok.com") || h.includes("x.com");
        if (isSupported) {
          document.querySelectorAll(".tport-btn").forEach(b => b.disabled = false);
        }
      } catch(_) {}
    }
  }
}

$("btnExtract").addEventListener("click", async () => {
  await runExtractionFlow(true);
});

document.querySelectorAll(".tport-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const target = btn.dataset.target;
    const cap = await runExtractionFlow(false);
    if (!cap) return;

    // Store pending transfer
    const transfer = {
      targetPlatform: target,
      capsule: cap,
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ pending_transfer: transfer });

    // Open target platform chat page in a new tab
    const urls = {
      claude: "https://claude.ai/new",
      chatgpt: "https://chatgpt.com/",
      gemini: "https://gemini.google.com/app",
      grok: "https://grok.com/"
    };
    chrome.tabs.create({ url: urls[target] });
    window.close();
  });
});

function renderExtractResults(data, refinedText) {
  const msgs  = data.messages || [];
  const imgs  = data.allImages || [];
  const files = data.allFiles || [];

  $("sMsg").textContent  = msgs.length;
  $("sImg").textContent  = imgs.length;
  $("sFile").textContent = files.length;

  // Files
  if (files.length) {
    $("fileList").style.display = "block";
    $("fileItems").innerHTML = "";
    files.forEach(f => {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      const icon = ext === "pdf" ? "📄" : ext === "zip" ? "🗜" : ["doc","docx"].includes(ext) ? "📝" : ["xls","xlsx"].includes(ext) ? "📊" : "📎";
      const hasData = !!f.dataUrl;
      const div = document.createElement("div");
      div.className = "file-item" + (hasData ? " clickable" : "");
      if (hasData) {
        div.title = "Click to download " + f.name;
        div.addEventListener("click", () => {
          chrome.runtime.sendMessage({ action: "downloadDataUrl", dataUrl: f.dataUrl, filename: f.name });
        });
      }
      div.innerHTML = `
        <span class="file-icon">${icon}</span>
        <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="file-badge ${hasData ? 'ok' : 'chip'}">${hasData ? "✓ data" : "name only"}</span>
      `;
      $("fileItems").appendChild(div);
    });
  }

  // Images
  const goodImgs = imgs.filter(i => i.dataUrl);
  const failedImgs = imgs.filter(i => i.error);
  if (goodImgs.length) {
    $("imgPreview").style.display = "block";
    $("imgPreviewCount").textContent = goodImgs.length + " ready";
    goodImgs.forEach(img => {
      const d = document.createElement("div"); d.className = "img-thumb";
      const el = document.createElement("img"); el.src = img.dataUrl;
      d.appendChild(el); $("imgGrid").appendChild(d);
    });
    $("btnImgs").disabled = false;
  } else { $("btnImgs").disabled = true; }

  // Status
  const chipsOnly = files.filter(f => !f.dataUrl).length;
  let statusParts = [`✓ Capsule saved! ${msgs.length} messages`];
  if (goodImgs.length) statusParts.push(`${goodImgs.length} image${goodImgs.length>1?"s":""}`);
  else if (imgs.length) statusParts.push(`0/${imgs.length} images captured`);
  statusParts.push(`${files.length} file${files.length!==1?"s":""}`);
  if (refinedText) statusParts.push("LLM refined ✦");
  let statusMsg = statusParts.join(" · ");
  const warns = [];
  if (failedImgs.length) warns.push(`⚠ ${failedImgs.length} image(s) couldn't be fetched (may be expired)`);
  if (chipsOnly) warns.push(`⚠ ${chipsOnly} file(s) found by name only (no binary available in DOM)`);
  if (warns.length) statusMsg += "<br>" + warns.join("<br>");

  showStatus("extractStatus", warns.length ? "warn" : "ok", statusMsg);
  $("extractResults").style.display = "block";
}

$("btnCopy").addEventListener("click", async () => {
  if (!extractedData) return;
  await navigator.clipboard.writeText(buildPlainText(extractedData));
  flash($("btnCopy"), "✓ Copied");
});
$("btnTxt").addEventListener("click", () => {
  if (!extractedData) return;
  chrome.runtime.sendMessage({ action:"downloadText", text: buildPlainText(extractedData), filename:`chat_${Date.now()}.txt` });
});
$("btnJson").addEventListener("click", () => {
  if (!extractedData) return;
  chrome.runtime.sendMessage({ action:"downloadJson", json: JSON.stringify(extractedData,null,2), filename:`chat_${Date.now()}.json` });
});
$("btnImgs").addEventListener("click", async () => {
  if (!extractedData) return;
  const imgs = (extractedData.allImages||[]).filter(i=>i.dataUrl);
  for (let i=0;i<imgs.length;i++) {
    await delay(250*i);
    const ext = imgs[i].mimeType?.split("/")[1] || "jpg";
    chrome.runtime.sendMessage({ action:"downloadDataUrl", dataUrl: imgs[i].dataUrl, filename:`img_${i+1}.${ext}` });
  }
  flash($("btnImgs"), `⬇ Saving ${imgs.length}…`);
});

// ── Capsules tab ──────────────────────────────────────────────────────────────
$("capSearch").addEventListener("input", renderCapsuleList);

$("btnShowTray").addEventListener("click", async () => {
  const caps = await loadCapsules();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, { action: "showCapsuleTray", capsules: caps });
  window.close();
});

$("btnClearAll")?.addEventListener("click", async () => {
  const caps = await loadCapsules();
  if (!caps.length) return;
  if (!confirm(`Are you sure you want to delete all ${caps.length} capsules?`)) return;
  await deleteAllCapsules();
  renderCapsuleList();
});

async function renderCapsuleList() {
  const caps = await loadCapsules();
  const q = $("capSearch").value.toLowerCase();
  const filtered = q ? caps.filter(c => c.name.toLowerCase().includes(q) || c.promptText?.toLowerCase().includes(q)) : caps;

  const list = $("capList");
  list.innerHTML = "";

  const clearBtn = $("btnClearAll");
  if (clearBtn) {
    clearBtn.style.display = filtered.length ? "flex" : "none";
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="cap-empty">${caps.length ? "No matches." : "No capsules yet.\nExtract a chat to create one."}</div>`;
    return;
  }

  filtered.forEach(cap => {
    const imgCount  = (cap.images||[]).filter(i=>i.dataUrl).length;
    const fileCount = (cap.files||[]).length;
    const fileDataCount = (cap.files||[]).filter(f=>f.dataUrl).length;
    const tokCount  = cap.promptText ? Math.ceil(cap.promptText.length / 4) : 0;

    const card = document.createElement("div");
    card.className = "cap-card";
    card.innerHTML = `
      <div class="cap-name">💊 ${esc(cap.name)}</div>
      <div class="cap-meta">
        <span>${cap.platform || "chat"}</span>
        <span>${tokCount} tokens</span>
        ${cap.llmRefined ? `<span style="color:var(--acc)">✦ refined</span>` : ""}
        ${imgCount  ? `<span>🖼 ${imgCount}</span>` : ""}
        ${fileCount ? `<span>📎 ${fileDataCount}/${fileCount} files</span>` : ""}
        <span style="margin-left:auto">${fmtDate(cap.createdAt)}</span>
      </div>
      <div class="cap-actions">
        <button class="cap-act drop" data-id="${cap.id}">💧 Drop</button>
        <button class="cap-act" data-copy="${cap.id}">📋 Copy</button>
        <button class="cap-act del" data-del="${cap.id}">🗑</button>
      </div>
    `;

    card.querySelector("[data-id]").addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { action: "dropCapsule", capsule: cap });
      window.close();
    });
    card.querySelector("[data-copy]").addEventListener("click", async () => {
      await navigator.clipboard.writeText(cap.promptText || cap.rawText || "");
      flash(card.querySelector("[data-copy]"), "✓");
    });
    card.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm(`Delete "${cap.name}"?`)) return;
      await deleteCapsule(cap.id);
      renderCapsuleList();
    });

    list.appendChild(card);
  });
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function loadCapsules() {
  const r = await chrome.storage.local.get(["capsules"]);
  return (r.capsules || []).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function saveCapsule(cap) {
  // Log capsule size for debugging
  const imgCount = (cap.images||[]).filter(i=>i.dataUrl).length;
  const capSize = JSON.stringify(cap).length;
  console.log(`[CEP] Saving capsule "${cap.name}": ${imgCount} images, ~${(capSize/1024).toFixed(0)}KB`);

  const r = await chrome.storage.local.get(["capsules"]);
  const caps = r.capsules || [];
  caps.push(cap);
  while (caps.length > 50) caps.shift();
  try {
    await chrome.storage.local.set({ capsules: caps });
    // Verify images survived storage round-trip
    const verify = await chrome.storage.local.get(["capsules"]);
    const saved = (verify.capsules||[]).find(c => c.id === cap.id);
    const savedImgs = saved ? (saved.images||[]).filter(i=>i.dataUrl).length : 0;
    if (savedImgs < imgCount) {
      console.warn(`[CEP] Storage lost images! Saved ${savedImgs}/${imgCount}. Storage quota may be exceeded.`);
    }
  } catch(e) {
    console.error('[CEP] Storage save failed:', e);
    // Try saving without images as fallback, then store images separately
    cap._imagesStripped = true;
    const stripped = {...cap, images: []};
    caps[caps.length - 1] = stripped;
    await chrome.storage.local.set({ capsules: caps });
    showStatus("extractStatus","warn","⚠ Storage full — capsule saved without images. Try deleting old capsules.");
  }
}
async function deleteCapsule(id) {
  const r = await chrome.storage.local.get(["capsules"]);
  const caps = (r.capsules||[]).filter(c => c.id !== id);
  await chrome.storage.local.set({ capsules: caps });
}
async function deleteAllCapsules() {
  await chrome.storage.local.set({ capsules: [] });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildPlainText(data) {
  const lines = [`# ${data.platform} Chat — ${data.extractedAt}`, `# ${data.url}`, ""];
  for (const msg of data.messages||[]) {
    if (msg.role && msg.role !== 'unknown') {
      lines.push(`[${msg.role.toUpperCase()}]`);
    }
    if (msg.text) {
      const cleaned = cleanForLLM(msg.text);
      if (cleaned) lines.push(cleaned);
    }
    if (msg.images?.length) lines.push(`[${msg.images.length} image(s)]`);
    if (msg.files?.length)  lines.push(`[Files: ${msg.files.map(f=>f.name).join(", ")}]`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{4,}/g, '\n\n\n');
}

// Clean extracted text before sending to LLM for refinement
function cleanForLLM(rawText) {
  if (!rawText) return '';
  
  // 1. Strip out inline UI warnings and timestamps that might be glued to the text
  let processed = rawText
    // Timestamps like 7:42 PM or 12:30 AM (also strip if glued to text like page7:42 PM)
    .replace(/\b\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)\b/g, '')
    // Interrupted message
    .replace(/Claude's response was interrupted\.?/gi, '')
    // Claude availability banner (specifically handling variations like Claude Fable 5 is currently unavailable.Learn more)
    .replace(/Claude\s+[Ff]able\s+\d+\s+is\s+currently\s+unavailable\.?\s*Learn\s+more(?:\(opens\s+in\s+new\s+tab\))?/gi, '')
    .replace(/Claude\s+[Ff]able\s+\d+\s+is\s+currently\s+unavailable\.?\s*Learn\s+more/gi, '')
    .replace(/Claude is AI and can make mistakes\. Please double-check responses\.?/gi, '')
    // Generic out of free messages
    .replace(/You are out of free messages until [0-9: AM|PM|am|pm\s]+Upgrade/gi, '');

  const lines = processed.split('\n');
  const cleaned = [];
  const seenBlocks = new Set();

  for (let line of lines) {
    const t = line.trim();
    if (!t) continue;

    // Remove UI noise patterns
    if (/^New chat(Ctrl|⌘)/i.test(t)) continue;
    if (/^(Chats|Projects|Artifacts|Customize|Products|Cowork|Code|Starred)/i.test(t) && t.length > 100) continue;
    if (/(Free plan|You are out of free messages|Upgrade)/i.test(t) && t.length < 200) continue;
    if (/^(Upgrade|Learn more|All chats|Download all)$/i.test(t)) continue;
    if (/Claude.*(unavailable|currently|interrupted)/i.test(t) && t.length < 200) continue;
    
    // Conversation wrapper/noise elements
    if (/^[a-f0-9]{16,}\.zip/i.test(t) && t.length < 100) continue;
    if (/^(Done|Content|Script|Table · CSV|PY)$/i.test(t)) continue;
    if (/^(sasuke|Settings|Language|Get help|Upgrade plan|Log out)/i.test(t) && t.length < 300) continue;
    if (/^(Add files or photos|Take a screenshot|Add to project|Skills|Add connectors)/i.test(t)) continue;
    if (/^(Sonnet|Claude|Opus|Haiku|Fable)\s+\d/i.test(t) && t.length < 200) continue;
    if (/^(Unstar|Star|Rename|Add to project|Delete|Group by)/i.test(t) && t.length < 100) continue;
    if (/^(Microphone|Hold to record)/i.test(t) && t.length < 100) continue;
    
    // Usage/Context warnings
    if (/^(Session|Weekly): \d+%/.test(t)) continue;
    if (/^(Approximate tokens|Messages sent while cached|5-hour session|7-day usage|Dynamic Context|Bar scale:)/i.test(t)) continue;

    // Skip bare [UNKNOWN] role markers (keep [USER] and [ASSISTANT])
    if (t === '[UNKNOWN]') continue;

    // Deduplicate identical blocks (same text seen before)
    if (t.length > 30) {
      const blockKey = t.slice(0, 200);
      if (seenBlocks.has(blockKey)) continue;
      seenBlocks.add(blockKey);
    }

    cleaned.push(line);
  }

  return cleaned.join('\n')
    .replace(/\n{4,}/g, '\n\n\n')  // Collapse excessive blank lines
    .trim();
}
function showStatus(id, type, msg) {
  const el = $(id);
  el.className = "status " + type;
  el.innerHTML = msg;
  el.style.display = "block";
}
function flash(el, msg) {
  const orig = el.innerHTML;
  el.innerHTML = msg;
  setTimeout(() => el.innerHTML = orig, 1800);
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff/60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString();
}


init();