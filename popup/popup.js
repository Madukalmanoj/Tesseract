// OmniExtract — Popup Script

let extractedData = null;
let currentProvider = "groq";

const $ = id => document.getElementById(id);

function updateProgressBar(show, status = "", percent = 0) {
  const pContainer = $("extract-progress");
  if (!pContainer) return;
  if (!show) {
    pContainer.style.display = "none";
    return;
  }
  pContainer.style.display = "block";
  const statusEl = $("extract-progress-status");
  const percentEl = $("extract-progress-percent");
  const barEl = $("extract-progress-bar");
  if (statusEl) statusEl.textContent = status;
  if (percentEl) percentEl.textContent = percent + "%";
  if (barEl) barEl.style.width = percent + "%";
}

function openSettings() {
  document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
  $("tab-settings").classList.add("active");
  $("apiKeyInput").focus();
}

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

  const stored = await chrome.storage.local.get(["apiKeys","lastProvider","llmEnabled","open_tab","autoExtract"]);
  if (stored.lastProvider) setProvider(stored.lastProvider);
  $("apiKeyInput").value = stored.apiKeys?.[currentProvider] || "";

  // Restore LLM enabled state
  if (stored.llmEnabled) {
    $("llmEnabled").checked = true;
    updateProviderBadge();
  }

  if (stored.open_tab === "settings") {
    await chrome.storage.local.remove(["open_tab"]);
    openSettings();
  } else if (stored.open_tab === "capsules" || stored.open_tab === "tesseracts") {
    await chrome.storage.local.remove(["open_tab"]);
    const tesseractsTab = document.querySelector('.tab[data-tab="tesseracts"]');
    if (tesseractsTab) {
      tesseractsTab.click();
    }
  } else if (location.hash === "#tab-capsules" || location.hash === "#tab-tesseracts") {
    const tesseractsTab = document.querySelector('.tab[data-tab="tesseracts"]');
    if (tesseractsTab) {
      tesseractsTab.click();
    }
  } else if (location.hash === "#tab-settings") {
    openSettings();
  } else {
    renderTesseractList();
  }

  if (stored.autoExtract) {
    await chrome.storage.local.remove(["autoExtract"]);
    runExtractionFlow(true);
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", async () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("tab-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "tesseracts") renderTesseractList();
    if (t.dataset.tab === "extract") {
      const stored = await chrome.storage.local.get(["apiKeys"]);
      const key = stored.apiKeys?.[currentProvider] || "";
      if (key) {
        const statusEl = $("extractStatus");
        if (statusEl && (statusEl.innerHTML.includes("configure your") || statusEl.innerHTML.includes("API key"))) {
          statusEl.style.display = "none";
          statusEl.innerHTML = "";
        }
      }
    }
  });
});

// ── LLM toggle ────────────────────────────────────────────────────────────────
$("llmEnabled").addEventListener("change", async () => {
  const on = $("llmEnabled").checked;
  if (on) {
    const stored = await chrome.storage.local.get(["apiKeys"]);
    const key = stored.apiKeys?.[currentProvider] || "";
    if (!key) {
      $("llmEnabled").checked = false;
      openSettings();
      showStatus("extractStatus", "warn", `Please configure your ${currentProvider} API key to enable LLM auto-refining.`);
      return;
    }
  }
  // Clear any stale warning/error if LLM toggle succeeds or is turned off
  $("extractStatus").style.display = "none";
  $("extractStatus").innerHTML = "";
  chrome.storage.local.set({ llmEnabled: on });
  updateProviderBadge();
});

$("btnSettings").addEventListener("click", openSettings);
$("btnBackExtract").addEventListener("click", () => {
  const extractTab = document.querySelector('.tab[data-tab="extract"]');
  if (extractTab) extractTab.click();
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
  const statusEl = $("testKeyStatus");
  if (statusEl) {
    statusEl.style.display = "none";
    statusEl.innerHTML = "";
  }
}

$("toggleKey").addEventListener("click", () => {
  const inp = $("apiKeyInput");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "hide" : "show";
});

$("btnTestKey").addEventListener("click", async () => {
  const key = $("apiKeyInput").value.trim();
  const statusEl = $("testKeyStatus");
  if (!key) {
    statusEl.textContent = "Enter a key first.";
    statusEl.style.color = "var(--red)";
    statusEl.style.display = "inline";
    return;
  }
  
  statusEl.textContent = "Testing...";
  statusEl.style.color = "var(--t2)";
  statusEl.style.display = "inline";
  $("btnTestKey").disabled = true;
  
  try {
    const res = await chrome.runtime.sendMessage({ action: "testLLMKey", provider: currentProvider, apiKey: key });
    if (res.error) {
      statusEl.textContent = "Failed ✗";
      statusEl.style.color = "var(--red)";
      statusEl.title = res.error;
      alert(`Connection failed:\n\n${res.error}`);
    } else {
      statusEl.textContent = "Success ✓";
      statusEl.style.color = "var(--green)";
      statusEl.title = "Connection successful!";
    }
  } catch(e) {
    statusEl.textContent = "Error ✗";
    statusEl.style.color = "var(--red)";
    statusEl.title = e.message;
  } finally {
    $("btnTestKey").disabled = false;
  }
});

$("apiKeyInput").addEventListener("input", async () => {
  const key = $("apiKeyInput").value.trim();
  const r = await chrome.storage.local.get(["apiKeys"]);
  const keys = r.apiKeys || {};
  keys[currentProvider] = key;
  await chrome.storage.local.set({ apiKeys: keys });
  
  if (key) {
    const statusEl = $("extractStatus");
    if (statusEl && (statusEl.innerHTML.includes("configure your") || statusEl.innerHTML.includes("API key"))) {
      statusEl.style.display = "none";
      statusEl.innerHTML = "";
    }
  }
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
  updateProgressBar(true, "Connecting to tab...", 15);
  $("btnExtract").disabled = true;
  document.querySelectorAll(".tport-btn").forEach(b => b.disabled = true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    updateProgressBar(true, "Extracting chat details...", 35);
    const res = await chrome.tabs.sendMessage(tab.id, { action: "extract" });
    if (!res?.success) throw new Error(res?.error || "Content script error");
    extractedData = res.data;
    updateProgressBar(true, "Processing messages & files...", 60);

    // Auto-fill tesseract name
    if (!$("capNameInput").value) {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      $("capNameInput").value = (t?.title || "Chat").replace(/ [-|].*$/, "").trim().slice(0, 50);
    }

    const tesseractName = $("capNameInput").value.trim() || "Chat Tesseract";

    // Check if the chat has any assistant/AI responses
    const hasAssistant = (extractedData.messages || []).some(m => m.role === 'assistant');

    // LLM refine — only perform if LLM is enabled AND there is actual assistant/AI response history to refine
    let refinedText = null;
    if (useLLM && hasAssistant) {
      showStatus("extractStatus","info",`<span class="spin"></span>Extracting… then refining with ${currentProvider}…`);
      updateProgressBar(true, `Refining with ${currentProvider}...`, 80);
      try {
        const chatText = cleanForLLM(buildPlainText(extractedData));
        const r2 = await chrome.runtime.sendMessage({ action: "llmRefine", provider: currentProvider, apiKey, chatText, tesseractName });
        if (r2.error) throw new Error(r2.error);
        refinedText = r2.text;
      } catch(e) {
        showStatus("extractStatus","warn",`<svg class="icon-svg" style="width:12px;height:12px;color:var(--amber);margin-right:4px;" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> LLM refine failed: ` + e.message + " — saving raw text.");
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

    const tess = {
      id: Date.now().toString(),
      name: tesseractName,
      promptText: refinedText || defaultPromptText,
      rawText: buildPlainText(extractedData),
      images: (extractedData.allImages||[]).filter(i=>i.dataUrl),
      files: (extractedData.allFiles||[]),
      platform: extractedData.platform,
      sourceUrl: extractedData.url,
      createdAt: new Date().toISOString(),
      llmRefined: !!refinedText,
    };

    // Save tesseract automatically only if requested
    if (shouldSave) {
      updateProgressBar(true, "Saving tesseract...", 95);
      await saveTesseract(tess);
    }

    renderExtractResults(extractedData, refinedText);
    return tess;

  } catch(e) {
    showStatus("extractStatus","err","Error: " + e.message);
    return null;
  } finally {
    updateProgressBar(false);
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
    const tess = await runExtractionFlow(false);
    if (!tess) return;

    // Store pending transfer
    const transfer = {
      targetPlatform: target,
      tesseract: tess,
      capsule: tess,
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
      let icon = `<svg class="icon-svg" style="width:12px;height:12px;color:var(--t2)" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
      if (ext === "pdf") {
        icon = `<svg class="icon-svg" style="width:12px;height:12px;color:var(--red)" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
      } else if (ext === "zip") {
        icon = `<svg class="icon-svg" style="width:12px;height:12px;color:var(--amber)" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="12" y1="12" x2="10" y2="12"></line><line x1="12" y1="15" x2="14" y2="15"></line></svg>`;
      } else if (["doc","docx"].includes(ext)) {
        icon = `<svg class="icon-svg" style="width:12px;height:12px;color:var(--acc2)" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
      } else if (["xls","xlsx"].includes(ext)) {
        icon = `<svg class="icon-svg" style="width:12px;height:12px;color:var(--green)" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><rect x="8" y="13" width="8" height="4"></rect><line x1="12" y1="13" x2="12" y2="17"></line></svg>`;
      }
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
        <span class="file-icon" style="display:flex;align-items:center">${icon}</span>
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
  // Status
  const chipsOnly = files.filter(f => !f.dataUrl).length;
  let statusParts = [`<svg class="icon-svg" style="width:12px;height:12px;color:var(--green);margin-right:2px;" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Tesseract saved! ${msgs.length} messages`];
  if (goodImgs.length) statusParts.push(`${goodImgs.length} image${goodImgs.length>1?"s":""}`);
  else if (imgs.length) statusParts.push(`0/${imgs.length} images captured`);
  statusParts.push(`${files.length} file${files.length!==1?"s":""}`);
  if (refinedText) statusParts.push(`refined <svg class="icon-svg" style="width:10px;height:10px;color:var(--acc);margin-left:2px;" viewBox="0 0 24 24"><path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9Z"></path></svg>`);
  let statusMsg = statusParts.join(" · ");
  const warns = [];
  if (failedImgs.length) warns.push(`<svg class="icon-svg" style="width:12px;height:12px;color:var(--amber);margin-right:4px;" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> ${failedImgs.length} image(s) couldn't be fetched (may be expired)`);
  if (chipsOnly) warns.push(`<svg class="icon-svg" style="width:12px;height:12px;color:var(--amber);margin-right:4px;" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> ${chipsOnly} file(s) found by name only (no binary available in DOM)`);
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

// ── Tesseracts tab ──────────────────────────────────────────────────────────────
$("capSearch").addEventListener("input", renderTesseractList);



$("btnClearAll")?.addEventListener("click", async () => {
  const tesses = await loadTesseracts();
  if (!tesses.length) return;
  if (!confirm(`Are you sure you want to delete all ${tesses.length} tesseracts?`)) return;
  await deleteAllTesseracts();
  renderTesseractList();
});

async function renderTesseractList() {
  const tesses = await loadTesseracts();
  const q = $("capSearch").value.trim().toLowerCase();
  const filtered = q ? tesses.filter(c => {
    const haystack = [
      c.name,
      c.promptText,
      c.rawText,
      c.platform,
      ...(c.files || []).map(f => f.name || f.filename || '')
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  }) : tesses;

  const list = $("capList");
  list.innerHTML = "";

  const clearBtn = $("btnClearAll");
  if (clearBtn) {
    clearBtn.style.display = filtered.length ? "flex" : "none";
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="cap-empty">${tesses.length ? "No matches." : "No tesseracts yet.\nExtract a chat to create one."}</div>`;
    return;
  }

  filtered.forEach(tess => {
    const imgCount  = (tess.images||[]).filter(i=>i.dataUrl).length;
    const fileCount = (tess.files||[]).length;
    const fileDataCount = (tess.files||[]).filter(f=>f.dataUrl).length;

    const card = document.createElement("div");
    card.className = "cap-card";
    card.innerHTML = `
      <button class="cap-pin-btn ${tess.pinned ? 'pinned' : ''}" data-pin="${tess.id}" title="${tess.pinned ? 'Unpin tesseract' : 'Pin tesseract'}">
        <svg class="icon-svg" style="width:12px;height:12px;" viewBox="0 0 24 24">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="${tess.pinned ? 'var(--amber)' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="cap-name" style="display:flex;align-items:center;gap:6px;padding-right:20px">
        <svg class="icon-svg" style="width:12px;height:12px;transform:rotate(-45deg);color:var(--acc)" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="5" ry="5"></rect><line x1="12" y1="7" x2="12" y2="17"></line></svg>
        ${esc(tess.name)}
      </div>
      <div class="cap-meta" style="display:flex;align-items:center;gap:8px">
        <span>${tess.platform || "chat"}</span>
        ${tess.llmRefined ? `<span style="color:var(--acc);display:flex;align-items:center;gap:3px"><svg class="icon-svg" style="width:10px;height:10px;color:var(--acc)" viewBox="0 0 24 24"><path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9Z"></path></svg>refined</span>` : ""}
        ${imgCount  ? `<span style="display:flex;align-items:center;gap:3px"><svg class="icon-svg" style="width:11px;height:11px" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> ${imgCount}</span>` : ""}
        ${fileCount ? `<span style="display:flex;align-items:center;gap:3px"><svg class="icon-svg" style="width:11px;height:11px" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg> ${fileDataCount}/${fileCount}</span>` : ""}
        <span style="margin-left:auto">${fmtDate(tess.createdAt)}</span>
      </div>
      <div class="cap-actions">
        <button class="cap-act drop" data-id="${tess.id}" style="display:flex;align-items:center;justify-content:center;gap:4px">
          <svg class="icon-svg" style="width:11px;height:11px" viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"></path></svg>
          Drop
        </button>
        <button class="cap-act" data-copy="${tess.id}" style="display:flex;align-items:center;justify-content:center;gap:4px">
          <svg class="icon-svg" style="width:11px;height:11px" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          Copy
        </button>
        <button class="cap-act del" data-del="${tess.id}" style="display:flex;align-items:center;justify-content:center;gap:4px">
          <svg class="icon-svg" style="width:11px;height:11px;color:var(--red)" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;

    card.querySelector("[data-id]").addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { action: "dropTesseract", tesseract: tess, capsule: tess });
      window.close();
    });
    card.querySelector("[data-copy]").addEventListener("click", async () => {
      await navigator.clipboard.writeText(tess.promptText || tess.rawText || "");
      flash(card.querySelector("[data-copy]"), "✓");
    });
    card.querySelector("[data-pin]").addEventListener("click", async (e) => {
      e.stopPropagation();
      await togglePinTesseract(tess.id);
      renderTesseractList();
    });
    card.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm(`Delete "${tess.name}"?`)) return;
      await deleteTesseract(tess.id);
      renderTesseractList();
    });

    list.appendChild(card);
  });
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function loadTesseracts() {
  const r = await chrome.storage.local.get(["tesseracts", "cubes", "capsules"]);
  const list = r.tesseracts || r.cubes || r.capsules || [];
  return list.sort((a,b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}
async function togglePinTesseract(id) {
  const r = await chrome.storage.local.get(["tesseracts", "cubes", "capsules"]);
  const list = r.tesseracts || r.cubes || r.capsules || [];
  const updated = list.map(c => {
    if (c.id === id) {
      return { ...c, pinned: !c.pinned };
    }
    return c;
  });
  await chrome.storage.local.set({ tesseracts: updated });
}
async function saveTesseract(tess) {
  const imgCount = (tess.images||[]).filter(i=>i.dataUrl).length;
  const size = JSON.stringify(tess).length;
  console.log(`[CEP] Saving tesseract "${tess.name}": ${imgCount} images, ~${(size/1024).toFixed(0)}KB`);

  const r = await chrome.storage.local.get(["tesseracts", "cubes", "capsules"]);
  const list = r.tesseracts || r.cubes || r.capsules || [];
  list.push(tess);
  while (list.length > 50) list.shift();
  try {
    await chrome.storage.local.set({ tesseracts: list });
    const verify = await chrome.storage.local.get(["tesseracts"]);
    const savedList = verify.tesseracts || [];
    const saved = savedList.find(c => c.id === tess.id);
    const savedImgs = saved ? (saved.images||[]).filter(i=>i.dataUrl).length : 0;
    if (savedImgs < imgCount) {
      console.warn(`[CEP] Storage lost images! Saved ${savedImgs}/${imgCount}. Storage quota may be exceeded.`);
    }
  } catch(e) {
    console.error('[CEP] Storage save failed:', e);
    tess._imagesStripped = true;
    const stripped = {...tess, images: []};
    list[list.length - 1] = stripped;
    await chrome.storage.local.set({ tesseracts: list });
    showStatus("extractStatus","warn","⚠ Storage full — tesseract saved without images. Try deleting old tesseracts.");
  }
}
async function deleteTesseract(id) {
  const r = await chrome.storage.local.get(["tesseracts", "cubes", "capsules"]);
  const list = (r.tesseracts || r.cubes || r.capsules || []).filter(c => c.id !== id);
  await chrome.storage.local.set({ tesseracts: list });
}
async function deleteAllTesseracts() {
  await chrome.storage.local.set({ tesseracts: [] });
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
    .replace(/You are out of free messages until [0-9: AM|PM|am|pm\s]+Upgrade/gi, '')
    // Strip potential API keys / sensitive tokens to avoid safety filter blocks (e.g. GitHub tokens, OpenAI keys, etc.)
    .replace(/\bghp_[a-zA-Z0-9]{36,255}\b/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[a-zA-Z0-9_]{82}\b/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsk-[a-zA-Z0-9]{48}\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\bsk-proj-[a-zA-Z0-9]{152}\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\bsk-ant-[a-zA-Z0-9-]{95,150}\b/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/\bgsk_[a-zA-Z0-9]{50,100}\b/g, '[REDACTED_GROQ_KEY]')
    .replace(/\bAIzaSy[a-zA-Z0-9_-]{33}\b/g, '[REDACTED_GEMINI_KEY]');

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