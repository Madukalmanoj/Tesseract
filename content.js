// ChatExtract Pro v4 — Content Script
(function() {
'use strict';

const PLAT = location.hostname.includes('claude.ai') ? 'claude'
           : (location.hostname.includes('chatgpt.com')||location.hostname.includes('chat.openai.com')) ? 'chatgpt'
           : location.hostname.includes('gemini.google.com') ? 'gemini'
           : (location.hostname.includes('grok.com')||location.hostname.includes('x.com')) ? 'grok'
           : 'unknown';

// ── Background proxy (no CORS) ───────────────────────────────────────────────
function bg(action, data) {
  return new Promise(ok => {
    chrome.runtime.sendMessage({action,...data}, r => {
      ok(chrome.runtime.lastError ? {error:chrome.runtime.lastError.message} : (r||{error:'no response'}));
    });
  });
}

// ── Get intercepted store from page hook ─────────────────────────────────────
function getStore() {
  return new Promise(ok => {
    const t = setTimeout(()=>ok({files:{},orgId:null}), 1500);
    window.addEventListener('__cepReply', function h(e) {
      clearTimeout(t); window.removeEventListener('__cepReply',h);
      ok(e.detail||{files:{},orgId:null});
    }, {once:true});
    window.dispatchEvent(new CustomEvent('__cepQuery'));
  });
}

// ── Org ID for Claude ────────────────────────────────────────────────────────
function getOrgId() {
  try {
    const m = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/);
    if (m) return m[1];
    for (const k of Object.keys(localStorage)) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v?.uuid) return v.uuid;
        if (v?.id && /^[a-f0-9-]{36}$/.test(v.id)) return v.id;
      } catch(_) {}
    }
    const pm = location.pathname.match(/\/([a-f0-9-]{36})\//);
    if (pm) return pm[1];
  } catch(_) {}
  return null;
}

// ── Fuzzy store lookup ───────────────────────────────────────────────────────
function fromStore(name, store) {
  if (!store||!name) return null;
  const k = name.toLowerCase().trim();
  if (store[k]) return store[k];
  const noext = k.replace(/\.[^.]+$/,'');
  for (const [sk,sv] of Object.entries(store)) {
    if (sk===noext||sk.includes(noext)||noext.includes(sk.replace(/\.[^.]+$/,''))) return sv;
  }
  return null;
}

// ── MIME → extension ─────────────────────────────────────────────────────────
function mext(mime) {
  const m=(mime||'').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('zip')) return 'zip';
  if (m.includes('wordprocessingml')||m.includes('msword')) return 'docx';
  if (m.includes('spreadsheetml')) return 'xlsx';
  if (m.includes('presentationml')) return 'pptx';
  return 'bin';
}

// ── Selectors ────────────────────────────────────────────────────────────────
// Claude: turns wrap everything; text lives in .whitespace-pre-wrap or prose divs
// ChatGPT: articles contain turns, role in data attribute
// ── Turn detection ───────────────────────────────────────────────────────────
// Claude confirmed selectors (stable data-testid attributes):
//   [data-testid="human-turn"]  — user message wrapper
//   [data-testid="ai-turn"]     — AI message wrapper
// These elements contain the full turn including text + attachments.
// We sort them by DOM order to preserve conversation sequence.

function findTurns() {
  const found = [];
  const seen  = new Set();

  if (PLAT === 'chatgpt') {
    for (const s of ['article[data-testid]','[data-message-id]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
    if (found.length) return found.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }

  else if (PLAT === 'gemini') {
    for (const s of ['user-query', 'model-response', 'model-turn', '[class*="user-query"]', '[class*="model-response"]', '[class*="model-turn"]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
    if (found.length) return found.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }

  else if (PLAT === 'claude') {
    for (const s of ['[data-testid="human-turn"]', '[data-testid="ai-turn"]', '[data-testid$="-turn"]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
    if (found.length) return found.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }

  else if (PLAT === 'grok') {
    for (const s of ['[data-testid="messageEntry"]', '[class*="messageEntry"]', 'article', '[class*="MessageContent"]', '[class*="message-content"]']) {
      for (const el of document.querySelectorAll(s)) {
        if (!seen.has(el)) { seen.add(el); found.push(el); }
      }
    }
    if (found.length) return found.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }

  // Strategy 1: Known turn selectors (Fuzzy fallback)
  const exactSels = [
    '[data-testid="human-turn"],[data-testid="ai-turn"]',
    '[data-testid$="-turn"]',
    '[class*="turn-"][class*="human"],[class*="turn-"][class*="assistant"]',
    '[class*="MessageContent"],[class*="message-content"]',
    '[class*="ConversationTurn"],[class*="conversation-turn"]',
    'user-query, model-response, model-turn, [class*="user-query"], [class*="model-response"], [class*="model-turn"]'
  ];
  for (const sel of exactSels) {
    for (const el of document.querySelectorAll(sel)) {
      if (!seen.has(el)) { seen.add(el); found.push(el); }
    }
    if (found.length) return found.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
  }

  // Strategy 2: Look for 'sr-only' markers (You said: / Claude responded:)
  for (const el of document.querySelectorAll('div, span')) {
    if (el.className && typeof el.className === 'string' && el.className.includes('sr-only')) {
      const t = el.innerText || el.textContent || '';
      if (t.includes('You said:') || t.includes('responded:')) {
         let wrapper = el.parentElement;
         if (wrapper && !seen.has(wrapper)) { seen.add(wrapper); found.push(wrapper); }
      }
    }
  }
  if (found.length) return found.sort((a,b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);

  // Strategy 3: Nuclear Fallback - Grab the main content area
  const chatArea = document.querySelector('main') || document.body;
  return [chatArea];
}

// Detect text that is clearly sidebar/navigation/UI noise, not chat content
function isUINoiseText(text) {
  const t = text.trim();
  // Sidebar nav concatenated text (e.g. "New chatCtrl+⇧+OChatsProjects...")
  if (/^New chat(Ctrl|⌘)/i.test(t)) return true;
  // Chat history list items (long concatenated titles)
  if (/^(Chats|Projects|Artifacts|Customize|Products|Cowork|Code|Starred)/i.test(t) && t.length > 100) return true;
  // Upgrade/subscription banners
  if (/^(Free plan|You are out of free messages|Upgrade)/i.test(t)) return true;
  // Claude availability messages
  if (/Claude .* (unavailable|currently)/i.test(t) && t.length < 200) return true;
  if (/Claude is AI and can make mistakes/i.test(t) && t.length < 200) return true;
  // Just a list of chat titles (no sentence structure, lots of title-case words)
  if (/^(Starred|Recents|All chats)/.test(t) && t.length > 200) return true;
  // Conversation wrapper blocks: contain "You said:" + "Claude responded:" patterns
  if (/You said:/.test(t) && /Claude responded:/.test(t) && t.length < 500) return true;
  // Tiny noise: zip filenames, single words like "Done", "Content", "Script"
  if (/^[a-f0-9]{16,}\.zip/i.test(t) && t.length < 100) return true;
  if (/^(Done|Content|Script|Table · CSV|PY)$/i.test(t)) return true;
  // Settings/account menu text
  if (/^(sasuke|Settings|Language|Get help|Upgrade plan|Log out)/i.test(t) && t.length < 300) return true;
  // Input area controls
  if (/^(Add files or photos|Take a screenshot|Add to project|Skills|Add connectors)/i.test(t)) return true;
  // Model selector
  if (/^(Sonnet|Claude|Opus|Haiku|Fable)\s+\d/i.test(t) && t.length < 200) return true;
  // Star/Rename/Delete context menus
  if (/^(Unstar|Star|Rename|Add to project|Delete|Group by)/i.test(t) && t.length < 100) return true;
  // Microphone label
  if (/^(Microphone|Hold to record)/i.test(t) && t.length < 100) return true;
  
  // Usage/Context warnings
  if (/^(Session|Weekly): \d+%/.test(t)) return true;
  if (/^(Approximate tokens|Messages sent while cached|5-hour session|7-day usage|Dynamic Context|Bar scale:)/i.test(t)) return true;

  return false;
}

// ── Role detection ────────────────────────────────────────────────────────────
function getRole(turn) {
  // Gemini tags or classes
  if (PLAT === 'gemini') {
    const tag = turn.tagName?.toLowerCase();
    if (tag === 'user-query' || turn.classList?.contains('user-query') || turn.closest('user-query') || turn.className?.includes?.('user-query')) return 'user';
    if (tag === 'model-turn' || tag === 'model-response' || turn.classList?.contains('model-turn') || turn.classList?.contains('model-response') || turn.closest('model-turn') || turn.closest('model-response') || turn.className?.includes?.('model-turn') || turn.className?.includes?.('model-response')) return 'assistant';
  }

  // Gemini tags fallback (non-Gemini platforms)
  const tag = turn.tagName?.toLowerCase();
  if (tag === 'user-query') return 'user';
  if (tag === 'model-turn' || tag === 'model-response') return 'assistant';

  // ChatGPT
  const gptRole = turn.getAttribute('data-message-author-role') ||
                  turn.querySelector('[data-message-author-role]')
                      ?.getAttribute('data-message-author-role');
  if (gptRole) return gptRole === 'user' ? 'user' : 'assistant';

  // Claude — data-testid on the element itself or ancestors/descendants
  const testid = turn.getAttribute('data-testid') || '';
  if (testid.includes('human')) return 'user';
  if (testid.includes('ai'))    return 'assistant';

  // Check children for testid hints
  const childTestId = turn.querySelector('[data-testid*="human"]') ? 'user'
                    : turn.querySelector('[data-testid*="ai"]')    ? 'assistant'
                    : null;
  if (childTestId) return childTestId;

  // Check ancestor for testid
  const ancestor = turn.closest('[data-testid*="human-turn"],[data-testid*="ai-turn"]');
  if (ancestor) {
    const aid = ancestor.getAttribute('data-testid') || '';
    if (aid.includes('human')) return 'user';
    if (aid.includes('ai'))    return 'assistant';
  }

  // Claude class-based hints
  const cls = (turn.className || '') + ' ' + (turn.parentElement?.className || '');
  if (/\b(human|user)\b/i.test(cls)) return 'user';
  if (/\b(assistant|ai|claude|bot|model)\b/i.test(cls)) return 'assistant';

  // Content-based heuristic: if it has .font-claude-message, it's AI
  if (turn.querySelector('.font-claude-message,[class*="claude-message"]')) return 'assistant';

  return 'unknown';
}

// ── Text extraction ───────────────────────────────────────────────────────────
function extractText(turn) {
  const clone = turn.cloneNode(true);
  
  // Strip all UI noise containers before extracting text
  for (const el of clone.querySelectorAll(
    'script, style, noscript, iframe, button, svg, nav, aside, header, footer, form, ' +
    '[role="navigation"], [role="menu"], [role="toolbar"], [role="dialog"], ' +
    '[class*="sidebar" i], [class*="Sidebar"], ' +
    '[class*="toolbar" i], [class*="Toolbar"], ' +
    '[class*="action"], [class*="copy"], [class*="feedback"], ' +
    '[class*="tooltip"], [class*="thumb"], [aria-hidden="true"], ' +
    '[class*="sr-only" i], [class*="visually-hidden" i], [class*="assistive-text" i]'
  )) {
    el.remove();
  }
  
  const text = clone.innerText?.trim() || '';
  return isUINoiseText(text) ? '' : text;
}

const SEL = {
  claude:  { input: '.ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder]' },
  chatgpt: { input: '#prompt-textarea, [contenteditable][data-id="root"]' },
  gemini:  { input: 'rich-textarea div[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea' },
  grok:    { input: 'textarea, div[role="textbox"][contenteditable="true"]' }
};

// Check if an element or its ancestor is part of the UI container or noise
function isInsideUI(el) {
  if (!el) return false;
  return !!el.closest(
    'nav, aside, header, footer, form, ' +
    '[role="navigation"], [role="menu"], [role="toolbar"], [role="dialog"], ' +
    '[class*="sidebar" i], [class*="Sidebar"], ' +
    '[class*="toolbar" i], [class*="Toolbar"]'
  );
}

// Check if a resolved chip text is actually just UI noise rather than a filename
function isUINoiseFileName(name) {
  const t = name.trim();
  if (!t) return true;
  // If it has a typical file extension, it's likely a real file
  if (/\.(pdf|docx|zip|csv|xlsx|pptx|txt|py|json|png|jpe?g|gif|webp|sh|js|html|css|md)$/i.test(t)) return false;
  // Claude paste representations
  if (t === 'PASTED' || t === 'ZIP') return false;
  // Common UI labels
  if (/^(Get apps|Help|Settings|Close|Cancel|Send|Upload|Attach|Menu|Log out|Upgrade|Feedback|Model|Show more|View more|See more|Star|Delete|Rename|All chats|Download all)/i.test(t)) return true;
  // Long phrase that doesn't look like a filename
  if (t.length > 50 && !t.includes('.')) return true;
  return false;
}

// ── Extract images from a turn (bg proxy for CORS) ──────────────────────────
async function extractImages(turn) {
  const imgs = [];
  for (const img of turn.querySelectorAll('img')) {
    if (isInsideUI(img)) continue;
    const src = img.src || '';
    if (!src||src.startsWith('data:image/svg')) continue;
    if (img.getAttribute('aria-hidden')==='true') continue;
    const sl = src.toLowerCase();
    if (sl.includes('/favicon')||sl.includes('/_next/')||sl.includes('/icons/')) continue;
    const nw=img.naturalWidth, nh=img.naturalHeight;
    if (nw>0&&nh>0&&nw<24&&nh<24) continue;
    // Skip avatars on non-upload URLs
    const isUpload = sl.includes('blob:')||sl.includes('/files/')||sl.includes('oaiusercontent')||
                     sl.includes('upload')||sl.includes('/api/organizations/')||sl.includes('fileuploads');
    if (!isUpload&&sl.includes('avatar')) continue;

    const r = await bg('fetchAsBase64', {url:src});
    if (!r.error && r.size > 200) {
      imgs.push({src, dataUrl:r.dataUrl, mimeType:r.mimeType, size:r.size, alt:img.alt||''});
    }
  }
  return imgs;
}

// ── Extract files from a turn ────────────────────────────────────────────────
async function extractFiles(turn, store, orgId) {
  const files = [];
  const seen  = new Set();

  function add(fd) {
    const k = fd.name?.toLowerCase();
    if (!k||seen.has(k)) return;
    seen.add(k);
    files.push(fd);
  }

  // ── ChatGPT: blobs already in store (intercepted by inject-early) ────────
  if (PLAT === 'chatgpt') {
    // Everything in the store that isn't an image
    for (const [k,v] of Object.entries(store||{})) {
      if (!v.filename) continue;
      const mime = (v.mimeType||'').toLowerCase();
      // Skip images — handled separately
      if (mime.startsWith('image/')) continue;
      add({name:v.filename, dataUrl:v.dataUrl, mimeType:v.mimeType, source:'intercepted', note:'✓ data'});
    }
    // Also scan for any file chips with text name
    for (const chip of turn.querySelectorAll('[class*="FileCard"],[class*="AttachmentTile"],[class*="file-tile"],[data-message-file-name]')) {
      if (isInsideUI(chip)) continue;
      const name = chip.dataset?.messageFileName || chipText(chip);
      if (!name||isUINoiseFileName(name)||seen.has(name.toLowerCase())) continue;
      const stored = fromStore(name, store);
      if (stored) add({name, dataUrl:stored.dataUrl, mimeType:stored.mimeType, source:'chip-matched', note:'✓ data'});
      else add({name, source:'chip', note:'name only'});
    }
  }

  // ── Claude: scan chips, fetch via Files API ──────────────────────────────
  if (PLAT === 'claude') {
    const chipSels = [
      '[data-testid="file-thumbnail"]','[data-testid*="attachment"]',
      '[class*="FilePreview"]','[class*="FileChip"]','[class*="DocumentChip"]',
      '[class*="AttachmentChip"]','[class*="file-attachment"]','[class*="uploaded-file"]',
      'button[aria-label*=".pdf"]','button[aria-label*=".docx"]','button[aria-label*=".zip"]',
      'div[role="button"][aria-label]',
    ];
    for (const sel of chipSels) {
      for (const chip of turn.querySelectorAll(sel)) {
        if (isInsideUI(chip)) continue;
        const name = chipText(chip);
        if (!name||isUINoiseFileName(name)||seen.has(name.toLowerCase())) continue;
        const fd = {name, source:'claude-chip', note:'name only'};

        // Check store first
        const stored = fromStore(name, store);
        if (stored) { fd.dataUrl=stored.dataUrl; fd.mimeType=stored.mimeType; fd.note='✓ intercepted'; add(fd); continue; }

        // Find file ID
        let fileId = null;
        for (const attr of chip.attributes) {
          if (/^[a-f0-9-]{36}$/.test(attr.value)) { fileId=attr.value; break; }
          const m=attr.value.match(/\/files\/([a-f0-9-]{36})/); if (m){fileId=m[1];break;}
        }
        if (!fileId) {
          const m=chip.innerHTML.match(/\/files\/([a-f0-9-]{36})/); if(m) fileId=m[1];
        }

        if (fileId && orgId) {
          // Register name with page hook
          window.dispatchEvent(new CustomEvent('__cepRegName',{detail:{fileId,filename:name}}));
          // Try Claude Files API via background
          for (const suf of ['/content','']) {
            const url=`https://api2.claude.ai/api/organizations/${orgId}/files/${fileId}${suf}`;
            const r=await bg('fetchAsBase64',{url});
            if (!r.error) { fd.dataUrl=r.dataUrl; fd.mimeType=r.mimeType; fd.note='✓ claude-api'; break; }
          }
        }
        add(fd);
      }
    }
  }

  return files;
}

function chipText(el) {
  const al = el.getAttribute('aria-label')||el.title||'';
  if (al&&al.length<200&&(al.includes('.')||al.length>2)) return al.trim();
  for (const s of el.querySelectorAll('span,p,[class*="name"],[class*="title"],[class*="filename"]')) {
    const t=s.innerText?.trim();
    if (t&&t.length>1&&t.length<200&&!t.includes('\n')) return t;
  }
  return el.innerText?.trim()?.split('\n')[0]?.trim()||null;
}

// ── Auto-expand collapsed sections before extraction ──────────────────────────
// Claude hides tool results ("Ran X commands"), artifacts, and long messages
// behind collapsible panels. We click them open so innerText captures everything.
// IMPORTANT: Only target buttons INSIDE the conversation area — never touch
// sidebar, menus, toolbars, model selectors, or any other UI controls.
async function expandCollapsedSections() {
  // Find the conversation container — do NOT touch anything outside it
  const chatArea = document.querySelector(
    '[data-testid="human-turn"], [data-testid="ai-turn"]'
  )?.closest('[class*="conversation" i], [class*="thread" i], main')
    || document.querySelector('main')
    || null;

  if (!chatArea) return;

  const clicked = new Set();

  // Only look for buttons INSIDE the conversation area
  const buttons = chatArea.querySelectorAll('button');
  for (const el of buttons) {
    // NEVER click buttons inside nav, sidebar, toolbar, menu, header, footer
    if (el.closest(
      'nav, aside, header, footer, ' +
      '[role="navigation"], [role="menu"], [role="toolbar"], [role="menubar"], ' +
      '[class*="sidebar" i], [class*="Sidebar"], ' +
      '[class*="composer" i], [class*="input-area" i], ' +
      'form'
    )) continue;

    const txt = (el.innerText || el.textContent || '').trim();

    // Only click buttons that match Claude's tool result toggle patterns
    const isToolResultToggle =
      /^ran \d+ commands?/i.test(txt) ||
      /^ran a command/i.test(txt) ||
      /^ran \d+ commands?, (viewed|created|read)/i.test(txt) ||
      /^(viewed|created|read) (a file|\d+ files?)/i.test(txt) ||
      /^show more$/i.test(txt) ||
      /^view more$/i.test(txt) ||
      /^see more$/i.test(txt);

    if (isToolResultToggle && !clicked.has(el)) {
      clicked.add(el);
      try {
        el.click();
        await new Promise(r => setTimeout(r, 200));
      } catch(_) {}
    }
  }

  // Also open <details> elements inside the chat area only
  for (const d of chatArea.querySelectorAll('details:not([open])')) {
    d.setAttribute('open', '');
  }

  // Wait for DOM to update after expansions
  if (clicked.size > 0) {
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Main extraction ───────────────────────────────────────────────────────────
async function extractAll() {
  // Expand all collapsed sections first so we can capture hidden content
  await expandCollapsedSections();

  const orgId = PLAT==='claude' ? getOrgId() : null;
  const {files:store} = await getStore();

  const result = {
    platform:PLAT, url:location.href,
    extractedAt:new Date().toISOString(),
    messages:[], allImages:[], allFiles:[], errors:[]
  };

  const turns = findTurns();
  const seenTexts = new Set();  // Track seen text to deduplicate messages

  for (let i=0; i<turns.length; i++) {
    const turn  = turns[i];
    const role  = getRole(turn);
    const text  = extractText(turn);

    // Skip UI noise that slipped through turn detection
    if (text && isUINoiseText(text)) continue;

    // Deduplicate: skip messages with identical text content
    const textKey = text.trim().slice(0, 300);
    if (textKey && seenTexts.has(textKey)) continue;
    if (textKey) seenTexts.add(textKey);

    const images= await extractImages(turn);
    const files = await extractFiles(turn, store, orgId);

    result.allImages.push(...images);
    result.allFiles.push(...files);
    if (text||images.length||files.length) {
      result.messages.push({index:i, role, text, images, files});
    }
  }

  // Deduplicate images and files
  const si=new Set(), sf=new Set();
  result.allImages = result.allImages.filter(i=>{if(si.has(i.src))return false;si.add(i.src);return true;});
  result.allFiles  = result.allFiles.filter(f=>{if(sf.has(f.name))return false;sf.add(f.name);return true;});

  return result;
}

// ── File drop injection ───────────────────────────────────────────────────────
function dataUrlToFile(dataUrl, name) {
  const arr=dataUrl.split(','), mime=arr[0].match(/:(.*?);/)[1];
  const bytes=Uint8Array.from(atob(arr[1]),c=>c.charCodeAt(0));
  return new File([bytes], name, {type:mime||'application/octet-stream'});
}

async function dropCapsule(cap) {
  const inputSel = (SEL[PLAT]||SEL.claude).input;
  const input = document.querySelector(inputSel);
  if (!input) { toast('❌ Input not found', true); return; }

  // ── 1. Inject text ────────────────────────────────────────────────────────
  const text = cap.promptText||cap.rawText||'';
  if (text) {
    input.focus();
    if (input.tagName==='TEXTAREA') {
      const ns=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;
      ns?.call(input,text);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    } else {
      input.focus();
      document.execCommand('selectAll',false);
      document.execCommand('insertText',false,text);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    }
    // Wait for ProseMirror/React to finish re-rendering after text insertion
    // before injecting files. This prevents the editor from swallowing file events.
    await new Promise(r => setTimeout(r, 500));
  }

  // ── 2. Build file objects ─────────────────────────────────────────────────
  const allFiles=[];
  let ii=0;
  for (const img of (cap.images||[]).filter(i=>i.dataUrl)) {
    try {
      const mime=img.dataUrl.split(',')[0].match(/:(.*?);/)[1];
      const ext=mime.split('/')[1]?.split(';')[0]||'jpg';
      allFiles.push(dataUrlToFile(img.dataUrl,`image_${++ii}.${ext}`));
    } catch(e) { console.warn('[CEP] Bad image dataUrl:', e); }
  }
  for (const f of (cap.files||[]).filter(f=>f.dataUrl)) {
    try { allFiles.push(dataUrlToFile(f.dataUrl, f.name)); } catch(e) { console.warn('[CEP] Bad file dataUrl:', e); }
  }

  if (!allFiles.length) { toast(`💊 "${cap.name}" dropped!`); return; }

  // ── 3. Inject files ───────────────────────────────────────────────────────
  let injected = false;

  // Strategy A: find hidden file input and set files directly (universal primary)
  if (PLAT === 'chatgpt' || PLAT === 'gemini' || PLAT === 'grok' || PLAT === 'claude') {
    // Find composer container first to narrow down file input selection
    const composer = document.querySelector('form') || 
                     input.closest('[class*="composer" i],[class*="Composer" i],[class*="input" i],[class*="Input" i]') ||
                     document.body;
    let fileInputs = Array.from(composer.querySelectorAll('input[type="file"]'));
    if (fileInputs.length === 0) {
      fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    }

    for (const fi of fileInputs) {
      try {
        const dt = new DataTransfer();
        allFiles.forEach(f => dt.items.add(f));
        Object.defineProperty(fi, 'files', { value: dt.files, configurable: true, writable: true });
        fi.dispatchEvent(new Event('change', { bubbles: true }));
        fi.dispatchEvent(new Event('input',  { bubbles: true }));
        injected = true;
        await new Promise(r => setTimeout(r, 150));
        break; // Break on first successful injection to prevent duplicate uploads
      } catch(e) {
        console.warn('[CEP] Strategy A file input injection failed:', fi, e);
      }
    }
  }

  // Strategy B: paste with files on the editor (works for images in Claude, Gemini, and Grok)
  // IMPORTANT: Always run on Claude/Gemini/Grok even if Strategy A "succeeded", because
  // modern rich text editors rely on intercepting paste events to upload attachments.
  if (!injected || PLAT === 'claude' || PLAT === 'gemini' || PLAT === 'grok') {
    input.focus();
    const dt = new DataTransfer();
    allFiles.forEach(f => dt.items.add(f));
    
    const pasteEvt = new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, clipboardData: dt
    });
    try {
      Object.defineProperty(pasteEvt, 'clipboardData', { get() { return dt; }, configurable: true });
    } catch(_) {}
    
    input.dispatchEvent(pasteEvt);
    await new Promise(r => setTimeout(r, 150));
    // If ProseMirror/Lexical didn't handle it, escalate to document
    if (!pasteEvt.defaultPrevented) {
      const dt2 = new DataTransfer();
      allFiles.forEach(f => dt2.items.add(f));
      const docPasteEvt = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt2
      });
      try {
        Object.defineProperty(docPasteEvt, 'clipboardData', { get() { return dt2; }, configurable: true });
      } catch(_) {}
      document.dispatchEvent(docPasteEvt);
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Strategy C: drag-and-drop on the composer area (ChatGPT primary)
  if (PLAT === 'chatgpt') {
    const zone = document.querySelector('form') ||
                 input.closest('[class*="composer" i],[class*="Composer" i]') ||
                 input.closest('form') ||
                 input.parentElement;
    if (zone) {
      const dt = new DataTransfer();
      allFiles.forEach(f => dt.items.add(f));
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      zone.dispatchEvent(new DragEvent('dragenter', opts));
      await new Promise(r => setTimeout(r, 50));
      zone.dispatchEvent(new DragEvent('dragover',  opts));
      await new Promise(r => setTimeout(r, 50));
      zone.dispatchEvent(new DragEvent('drop',      opts));
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Strategy D: simulate user clicking the upload button then set files
  if (PLAT === 'claude' && !injected) {
    const uploadBtn = document.querySelector(
      'button[aria-label*="upload" i], button[aria-label*="attach" i], ' +
      'button[aria-label*="file" i], button[data-testid*="upload" i], ' +
      'label[for] input[type="file"]'
    );
    if (uploadBtn) {
      const fi = uploadBtn.tagName === 'INPUT' ? uploadBtn
               : uploadBtn.querySelector('input[type="file"]')
               || document.querySelector('input[type="file"]');
      if (fi) {
        const dt = new DataTransfer();
        allFiles.forEach(f => dt.items.add(f));
        Object.defineProperty(fi, 'files', { value: dt.files, configurable: true });
        fi.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  toast(`💊 "${cap.name}" — text + ${allFiles.length} file(s)!`);
}

// ── Capsule tray ──────────────────────────────────────────────────────────────
let tray=null;
function showTray(caps) {
  if (tray) tray.remove();
  tray=document.createElement('div'); tray.id='cep-tray';
  tray.innerHTML='<div id="cep-th"><span>⬡ Capsules</span><button id="cep-tc">✕</button></div><div id="cep-tl"></div>';
  const st=document.createElement('style');
  st.textContent='#cep-tray{position:fixed;bottom:80px;right:20px;z-index:999999;width:270px;max-height:440px;background:#0f0f10;border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui,sans-serif;display:flex;flex-direction:column}#cep-th{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#1a1a1e;border-bottom:1px solid rgba(255,255,255,.08);font-size:12px;font-weight:600;color:#a99cf9}#cep-tc{background:none;border:none;color:#666;cursor:pointer;font-size:12px;border-radius:4px}#cep-tc:hover{color:#fff}#cep-tl{overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;flex:1}.cep-cap{background:#1a1a1e;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 12px;cursor:pointer;transition:all .15s}.cep-cap:hover{background:#232328;border-color:rgba(124,106,247,.4)}.cep-cn{font-size:12px;font-weight:600;color:#f0eff4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cep-cm{font-size:10px;color:#666;margin-top:3px;display:flex;gap:8px}.cep-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);color:#000;font-size:12px;font-weight:600;padding:8px 18px;border-radius:20px;z-index:9999999;animation:cepU 2.5s ease forwards;pointer-events:none}@keyframes cepU{0%{opacity:0;transform:translateX(-50%) translateY(10px)}20%{opacity:1;transform:translateX(-50%) translateY(0)}80%{opacity:1}100%{opacity:0}}';
  document.head.appendChild(st);
  const list=tray.querySelector('#cep-tl');
  if (!caps.length) { list.innerHTML='<div style="color:#555;font-size:12px;text-align:center;padding:20px">No capsules yet.</div>'; }
  else caps.forEach(cap=>{
    const el=document.createElement('div'); el.className='cep-cap';
    const ic=(cap.images||[]).filter(i=>i.dataUrl).length;
    const fc=(cap.files||[]).filter(f=>f.dataUrl).length;
    el.innerHTML=`<div class="cep-cn">💊 ${eh(cap.name||'Capsule')}</div><div class="cep-cm"><span>📝 ${cap.promptText?Math.ceil(cap.promptText.length/4)+'tok':'—'}</span>${ic?`<span>🖼 ${ic}</span>`:''}${fc?`<span>📎 ${fc}</span>`:''}</div>`;
    el.onclick=()=>{dropCapsule(cap);tray.remove();tray=null;};
    list.appendChild(el);
  });
  tray.querySelector('#cep-tc').onclick=()=>{tray.remove();tray=null;};
  document.body.appendChild(tray);
}

function toast(msg,err=false) {
  const t=document.createElement('div'); t.className='cep-toast';
  t.style.background=err?'#f87171':'#3ecf8e'; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2600);
}
function eh(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Check for pending transfer on load
async function checkPendingTransfer() {
  try {
    const r = await chrome.storage.local.get(["pending_transfer"]);
    if (!r.pending_transfer) return;
    const transfer = r.pending_transfer;

    // Limit to 2 minutes freshness
    if (Date.now() - transfer.timestamp > 120000) {
      await chrome.storage.local.remove(["pending_transfer"]);
      return;
    }

    const currentHost = location.hostname.toLowerCase();
    let match = false;
    if (transfer.targetPlatform === "claude" && currentHost.includes("claude.ai")) match = true;
    if (transfer.targetPlatform === "chatgpt" && (currentHost.includes("chatgpt.com") || currentHost.includes("chat.openai.com"))) match = true;
    if (transfer.targetPlatform === "gemini" && currentHost.includes("gemini.google.com")) match = true;
    if (transfer.targetPlatform === "grok" && currentHost.includes("grok.com")) match = true;

    if (!match) return;

    // Clear immediately to prevent loops or double injections
    await chrome.storage.local.remove(["pending_transfer"]);

    // Polling loop to wait for input element to be available
    let attempts = 0;
    const maxAttempts = 150; // 30 seconds (200ms intervals)
    const interval = setInterval(() => {
      const inputSel = (SEL[PLAT]||SEL.claude).input;
      const input = document.querySelector(inputSel);
      if (input) {
        // Focus the input textbox to trigger lazy loading of toolbar and file input components
        try { input.focus(); } catch(_) {}

        // If the capsule contains files, verify if we should wait for file input to appear
        const hasFiles = (transfer.capsule.images && transfer.capsule.images.length > 0) || 
                         (transfer.capsule.files && transfer.capsule.files.length > 0);
        if (hasFiles && !document.querySelector('input[type="file"]')) {
          attempts++;
          if (attempts >= 15) { // 3 seconds timeout (15 * 200ms) for file input to appear
            clearInterval(interval);
            console.warn("[CEP] Text input found, but file input not found after 3 seconds. Proceeding to drop capsule anyway.");
            dropCapsule(transfer.capsule);
          }
          return; // Keep waiting for file input
        }

        clearInterval(interval);
        console.log("[CEP] Pending transfer found, waiting 1.2s for editor to initialize event listeners...");
        setTimeout(() => {
          console.log("[CEP] Dropping capsule now...");
          dropCapsule(transfer.capsule);
        }, 1200);
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          console.warn("[CEP] Target input element not found after 30 seconds.");
        }
      }
    }, 200);
  } catch(e) {
    console.error("[CEP] Error in checkPendingTransfer:", e);
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req,_,send)=>{
  if (req.action==='ping')           {send({platform:PLAT,ready:true});return true;}
  if (req.action==='extract')        {extractAll().then(d=>send({success:true,data:d})).catch(e=>send({success:false,error:e.message}));return true;}
  if (req.action==='showCapsuleTray'){showTray(req.capsules||[]);send({ok:true});return true;}
  if (req.action==='dropCapsule')    {dropCapsule(req.capsule);send({ok:true});return true;}
  if (req.action==='hideCapsuleTray'){if(tray){tray.remove();tray=null;}send({ok:true});return true;}
});

// Run pending transfer check
checkPendingTransfer();
})();
