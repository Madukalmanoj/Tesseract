// OmniExtract — Page-context hook (MAIN world, document_start)
(function() {
  if (window.__cep) return;
  const IS_CLAUDE = window.location.hostname.includes('claude.ai');
  const IS_GEMINI = window.location.hostname.includes('gemini.google.com');

  window.__cep = {
    files: {},      // lcName → {dataUrl,mimeType,filename,url}
    urlMap: {},     // downloadUrl → filename (set from /download JSON)
    idMap:  {},     // fileId → filename
    downloadUrlMap: {}, // fileId → downloadUrl (to fetch via background if CORS fails)
    extractedContentMap: {}, // fileId → extracted_content text fallback
    filePathMap: {}, // fileId → server-side path (e.g. /mnt/user-data/uploads/file.zip)
    orgId:  null,
    authHeader: null,
    oaiHeaders: {},
    claudeHeaders: {},
    lastConvId: null,
    interceptedDownloads: []
  };

  // Hook setRequestHeader to capture Authorization and OAI headers in XHR
  const _xsetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header) {
      const hl = header.toLowerCase();
      if (hl === 'authorization') {
        window.__cep.authHeader = value;
        console.log("[CEP] Captured XHR Authorization header:", value.slice(0, 20) + "...");
      } else if (hl.startsWith('oai-')) {
        window.__cep.oaiHeaders[hl] = value;
        console.log("[CEP] Captured XHR OAI header:", header, value);
      } else if (IS_CLAUDE) {
        if (hl.startsWith('anthropic-') || hl === 'organization-id' || hl === 'custom-agent-id') {
          window.__cep.claudeHeaders[header] = value;
          console.log("[CEP] Captured XHR Claude header:", header, value);
        }
      }
    }
    return _xsetHeader.apply(this, [header, value]);
  };

  function toDataUrl(bufferOrBlob, ct) {
    return new Promise((ok, fail) => {
      try {
        let blob;
        if (bufferOrBlob instanceof Blob) {
          blob = bufferOrBlob;
        } else if (bufferOrBlob instanceof ArrayBuffer) {
          blob = new Blob([bufferOrBlob], { type: ct || 'application/octet-stream' });
        } else if (typeof bufferOrBlob === 'string') {
          const len = bufferOrBlob.length;
          const u8arr = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            u8arr[i] = bufferOrBlob.charCodeAt(i) & 0xff;
          }
          blob = new Blob([u8arr], { type: ct || 'application/octet-stream' });
        } else {
          fail(new Error('Unsupported type'));
          return;
        }

        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.onerror = () => fail(r.error);
        r.readAsDataURL(blob);
      } catch (e) {
        fail(e);
      }
    });
  }

  function findDownloadUrl(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.download_url && typeof obj.download_url === 'string') return obj.download_url;
    if (obj.downloadUrl && typeof obj.downloadUrl === 'string') return obj.downloadUrl;
    if (obj.url && typeof obj.url === 'string' && (obj.url.startsWith('http') || obj.url.startsWith('/'))) return obj.url;
    
    for (const v of Object.values(obj)) {
      if (typeof v === 'object') {
        const res = findDownloadUrl(v);
        if (res) return res;
      }
    }
    return null;
  }

  function save(name, dataUrl, mime, url) {
    if (!name || !dataUrl) return;
    
    // Clean timestamp prefix from name if present (e.g. 1781379147075_file.pdf -> file.pdf)
    name = name.replace(/^\d{10,13}_/, '');
    
    // If it's a fallback extracted content for binary file, append .txt
    const lowerName = name.toLowerCase();
    const binaryExts = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.zip', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (url === 'extracted-content' && binaryExts.some(ext => lowerName.endsWith(ext))) {
      name = name + '.txt';
    }
    
    const k = name.toLowerCase().trim();
    
    // Guard rail: prevent saving HTML/JSON response content as binary files (e.g. PDF, ZIP, DOCX, images, etc.)
    const ct = (mime || '').toLowerCase();
    const isHtmlOrJson = ct.includes('json') || ct.includes('html');
    if (isHtmlOrJson) {
      const ext = k.split('.').pop();
      const binaryExts = ['pdf', 'zip', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bin'];
      if (binaryExts.includes(ext)) {
        console.warn(`[CEP] Refusing to save HTML/JSON response as binary file: ${name} (MIME: ${mime}, URL: ${url})`);
        return;
      }
    }

    const e = {dataUrl, mimeType: mime||'application/octet-stream', filename: name, url};
    window.__cep.files[k] = e;
    const noext = k.replace(/\.[^.]+$/,'');
    if (noext !== k) window.__cep.files[noext] = e;
    
    // Debug logging
    const base64Part = dataUrl.split(',')[1] || '';
    const size = Math.round(base64Part.length * 0.75);
    console.log(`[CEP] Stored binary file: ${name} | MIME: ${mime || 'unknown'} | Size: ${size} bytes`);
    
    window.dispatchEvent(new CustomEvent('__cepStored', {detail:{name,mime,url}}));
  }

  // ── Gemini: Capture files via prototype hooks ───────────────────────────────
  // Gemini's file picker may use showOpenFilePicker(), shadow DOM inputs, or other
  // mechanisms that DOM event listeners can't intercept. Instead, hook the
  // FileReader and Blob prototypes to catch ANY file being read by Gemini's code.
  if (IS_GEMINI) {
    const _geminiCapturedFiles = new Set(); // prevent duplicate captures
    
    function geminiCaptureFile(file, source) {
      if (!file || !(file instanceof File)) return;
      if (!file.name || file.size < 1) return;
      // Skip images — handled by image extraction
      if (file.type && file.type.startsWith('image/')) return;
      // Skip tiny files (likely metadata)
      if (file.size < 50) return;
      // Deduplicate by name+size
      const key = file.name + '|' + file.size;
      if (_geminiCapturedFiles.has(key)) return;
      _geminiCapturedFiles.add(key);
      
      console.log('[CEP] Gemini prototype hook (' + source + '): detected file:', file.name, file.type, file.size, 'bytes');
      
      // Queue the pending filename — the legacy blob interceptor will use this
      // to name the blob correctly when it catches the upload
      // (using a queue to handle multiple files uploaded at once)
      if (!window.__cep._geminiPendingNames) window.__cep._geminiPendingNames = [];
      window.__cep._geminiPendingNames.push({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        time: Date.now()
      });
      
      // Also try to read directly (may fail if File is consumed, but worth trying)
      try {
        const reader = new FileReader();
        reader.__cepInternal = true;
        reader.onload = function() {
          if (reader.result) {
            save(file.name, reader.result, file.type || 'application/octet-stream', 'gemini-' + source);
            console.log('[CEP] Gemini: direct FileReader capture succeeded for:', file.name);
          }
        };
        reader.onerror = function() {
          console.log('[CEP] Gemini: direct FileReader failed for:', file.name, '— relying on blob interceptor');
        };
        _origReadAsDataURL.call(reader, file);
      } catch(e) {
        console.log('[CEP] Gemini: FileReader exception for:', file.name, e.message);
      }
    }
    
    // 1. Hook FileReader.readAsArrayBuffer — Gemini likely reads files as ArrayBuffer
    const _origReadAsArrayBuffer = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function(blob) {
      if (!this.__cepInternal && blob instanceof File) {
        geminiCaptureFile(blob, 'readAsArrayBuffer');
      }
      return _origReadAsArrayBuffer.call(this, blob);
    };
    
    // 2. Hook FileReader.readAsDataURL
    const _origReadAsDataURL = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(blob) {
      if (!this.__cepInternal && blob instanceof File) {
        geminiCaptureFile(blob, 'readAsDataURL');
      }
      return _origReadAsDataURL.call(this, blob);
    };
    
    // 3. Hook Blob.arrayBuffer() — modern alternative to FileReader
    const _origBlobArrayBuffer = Blob.prototype.arrayBuffer;
    if (_origBlobArrayBuffer) {
      Blob.prototype.arrayBuffer = function() {
        if (this instanceof File && !this.__cepInternal) {
          geminiCaptureFile(this, 'blobArrayBuffer');
        }
        return _origBlobArrayBuffer.call(this);
      };
    }
    
    // 4. Hook Blob.text() — another modern API
    const _origBlobText = Blob.prototype.text;
    if (_origBlobText) {
      Blob.prototype.text = function() {
        if (this instanceof File && !this.__cepInternal) {
          geminiCaptureFile(this, 'blobText');
        }
        return _origBlobText.call(this);
      };
    }
    
    // 5. Fallback: DOM event listeners (may work for some file picker implementations)
    document.addEventListener('change', function(e) {
      if (e.target && e.target.type === 'file' && e.target.files) {
        for (const file of e.target.files) geminiCaptureFile(file, 'inputChange');
      }
    }, true);
    document.addEventListener('drop', function(e) {
      if (e.dataTransfer && e.dataTransfer.files) {
        for (const file of e.dataTransfer.files) geminiCaptureFile(file, 'drop');
      }
    }, true);

    // ── Clear store on Gemini SPA navigation (new chat) ──
    let lastGeminiPath = window.location.pathname;
    
    function getGeminiConvId(path) {
      const m = path.match(/\/app\/([a-zA-Z0-9_-]+)/);
      return m ? m[1] : '__new__';
    }
    
    function onGeminiNavigate() {
      const newPath = window.location.pathname;
      if (newPath === lastGeminiPath) return;
      const oldConv = getGeminiConvId(lastGeminiPath);
      const newConv = getGeminiConvId(newPath);
      lastGeminiPath = newPath;
      
      // Don't clear when going FROM new chat → conversation
      // (normal flow: user uploads file on /app, sends message, URL becomes /app/CONV_ID)
      if (oldConv === '__new__') {
        console.log('[CEP] Gemini: new chat became conversation', newConv, '— keeping store');
        return;
      }
      
      if (oldConv !== newConv) {
        console.log('[CEP] Gemini: switched conversation — clearing store');
        window.__cep.files = {};
        window.__cep.urlMap = {};
        window.__cep.idMap = {};
        window.__cep.lastUploadedFile = null;
        window.__cep._geminiPendingNames = [];
        window.__cep.interceptedDownloads = [];
        _geminiCapturedFiles.clear();
      }
    }
    
    const _pushState = history.pushState.bind(history);
    const _replaceState = history.replaceState.bind(history);
    history.pushState = function(...args) { const r = _pushState(...args); onGeminiNavigate(); return r; };
    history.replaceState = function(...args) { const r = _replaceState(...args); onGeminiNavigate(); return r; };
    window.addEventListener('popstate', onGeminiNavigate);

    // ── Gemini: Intercept and capture download URLs ──
    function captureDownloadUrl(url, filename = '') {
      if (!url) return;
      try {
        url = new URL(url, window.location.href).href;
      } catch(_) {}
      
      console.log('[CEP] Gemini: Intercepted download URL in hook:', url, 'filename:', filename);
      
      if (!window.__cep.interceptedDownloads) window.__cep.interceptedDownloads = [];
      window.__cep.interceptedDownloads.push({
        url: url,
        filename: filename,
        time: Date.now()
      });
    }

    // 1. Hook HTMLAnchorElement.prototype.click
    const _origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      const href = this.href || this.getAttribute('href');
      console.log('[CEP] Gemini debug: HTMLAnchorElement.prototype.click called, href:', href);
      if (href && (href.includes('usercontent.google.com') || href.includes('contribution.usercontent.google.com') || href.includes('drive.google.com/viewer') || href.includes('docs.google.com/viewer'))) {
        const filename = this.download || this.innerText || this.textContent || '';
        captureDownloadUrl(href, filename.trim());
        return; // block the actual download/navigation
      }
      return _origAnchorClick.apply(this, arguments);
    };

    // 2. Hook window.open
    const _origWindowOpen = window.open;
    window.open = function(url, ...args) {
      console.log('[CEP] Gemini debug: window.open called, url:', url);
      if (url && typeof url === 'string' && (url.includes('usercontent.google.com') || url.includes('contribution.usercontent.google.com') || url.includes('drive.google.com/viewer') || url.includes('docs.google.com/viewer'))) {
        captureDownloadUrl(url);
        return null; // block opening new window
      }
      return _origWindowOpen.apply(this, arguments);
    };

    // 3. Hook location.assign and replace
    const _origAssign = window.location.assign;
    if (_origAssign) {
      window.location.assign = function(url) {
        console.log('[CEP] Gemini debug: location.assign called, url:', url);
        if (url && typeof url === 'string' && (url.includes('usercontent.google.com') || url.includes('contribution.usercontent.google.com') || url.includes('drive.google.com/viewer') || url.includes('docs.google.com/viewer'))) {
          captureDownloadUrl(url);
          return; // block navigation
        }
        return _origAssign.apply(this, arguments);
      };
    }
    const _origReplace = window.location.replace;
    if (_origReplace) {
      window.location.replace = function(url) {
        console.log('[CEP] Gemini debug: location.replace called, url:', url);
        if (url && typeof url === 'string' && (url.includes('usercontent.google.com') || url.includes('contribution.usercontent.google.com') || url.includes('drive.google.com/viewer') || url.includes('docs.google.com/viewer'))) {
          captureDownloadUrl(url);
          return; // block navigation
        }
        return _origReplace.apply(this, arguments);
      };
    }

    // 4. Intercept clicks on links that are not handled programmatically
    window.addEventListener('click', function(e) {
      let target = e.target;
      console.log('[CEP] Gemini debug: Global window click listener caught click on:', target.tagName, 'class:', target.className);
      while (target) {
        if (target.tagName === 'A') {
          const href = target.href || target.getAttribute('href') || '';
          if (href && (href.includes('usercontent.google.com') || href.includes('contribution.usercontent.google.com') || href.includes('drive.google.com/viewer') || href.includes('docs.google.com/viewer'))) {
            const filename = target.download || target.innerText || target.textContent || '';
            captureDownloadUrl(href, filename.trim());
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        target = target.parentElement;
      }
    }, true);
    
    console.log('[CEP] Gemini file prototype hooks installed');
  }

  async function inspectRequestBodyLegacy(body, url) {
    if (!body) return;
    try {
      if (body instanceof FormData) {
        for (const [key, val] of body.entries()) {
          if (val instanceof File) {
            const name = val.name;
            const mime = val.type;
            const dataUrl = await toDataUrl(val, mime);
            console.log("[CEP] Intercepted FormData file upload request body (Legacy):", name, mime);
            save(name, dataUrl, mime, url);
          }
        }
      } else if (body instanceof File) {
        const name = body.name;
        const mime = body.type;
        const dataUrl = await toDataUrl(body, mime);
        console.log("[CEP] Intercepted File upload request body (Legacy):", name, mime);
        save(name, dataUrl, mime, url);
      } else if (body instanceof Blob) {
        let name = getName(url);
        let mime = body.type;
        
        // Gemini: find best matching pending filename from the queue
        if (IS_GEMINI && window.__cep._geminiPendingNames && window.__cep._geminiPendingNames.length > 0) {
          let bestIdx = -1, bestSizeDiff = Infinity;
          for (let i = 0; i < window.__cep._geminiPendingNames.length; i++) {
            const p = window.__cep._geminiPendingNames[i];
            const elapsed = Date.now() - p.time;
            if (elapsed > 30000) continue; // expired
            const sizeDiff = Math.abs(body.size - p.size);
            if (sizeDiff < 500 && sizeDiff < bestSizeDiff) {
              bestIdx = i;
              bestSizeDiff = sizeDiff;
            }
          }
          if (bestIdx >= 0) {
            const pending = window.__cep._geminiPendingNames.splice(bestIdx, 1)[0];
            name = pending.name;
            mime = pending.type || mime;
            console.log('[CEP] Gemini: matched blob to pending name:', name, '(size diff:', bestSizeDiff, ')');
          }
          // Clean up expired entries
          window.__cep._geminiPendingNames = window.__cep._geminiPendingNames.filter(p => Date.now() - p.time < 30000);
        }
        
        if (!name) {
          name = 'upload_' + Date.now() + '.' + mext(mime);
        }
        const dataUrl = await toDataUrl(body, mime);
        console.log("[CEP] Intercepted Blob upload request body (Legacy):", name, mime);
        save(name, dataUrl, mime, url);
      }
    } catch(e) {
      console.warn("[CEP] Failed to inspect request body:", e);
    }
  }

  async function inspectRequestBodyClaude(body, url) {
    if (!body) return;
    try {
      if (body instanceof FormData || (body && typeof body.entries === 'function')) {
        for (const [key, val] of body.entries()) {
          if (val && (val instanceof Blob || (val && typeof val.size === 'number'))) {
            const name = val.name || ('upload_' + Date.now() + '.' + mext(val.type));
            const mime = val.type;
            const dataUrl = await toDataUrl(val, mime);
            console.log("[CEP] Intercepted FormData file:", name, mime);
            save(name, dataUrl, mime, url);
            
            if (url && url.includes('/files')) {
              window.__cep.lastUploadedFile = { dataUrl, mime: mime || 'application/octet-stream', time: Date.now() };
            }
          }
        }
      } else if (body instanceof Blob || (body && typeof body.size === 'number' && typeof body.type === 'string')) {
        const name = body.name || getName(url) || ('upload_' + Date.now() + '.' + mext(body.type));
        const mime = body.type;
        const dataUrl = await toDataUrl(body, mime);
        console.log("[CEP] Intercepted Blob/File:", name, mime);
        save(name, dataUrl, mime, url);
        
        if (url && url.includes('/files')) {
          window.__cep.lastUploadedFile = { dataUrl, mime: mime || 'application/octet-stream', time: Date.now() };
        }
      }
    } catch(e) {
      console.warn("[CEP] Failed to inspect request body:", e);
    }
  }

  async function extractFileFromRequestBody(body) {
    if (!body) return null;
    try {
      if (body instanceof FormData || (body && typeof body.entries === 'function')) {
        for (const [key, val] of body.entries()) {
          if (val && (val instanceof Blob || (val && typeof val.size === 'number'))) {
            const mime = val.type || 'application/octet-stream';
            const dataUrl = await toDataUrl(val, mime);
            return { dataUrl, mime };
          }
        }
      } else if (body instanceof Blob || (body && typeof body.size === 'number' && typeof body.type === 'string')) {
        const mime = body.type || 'application/octet-stream';
        const dataUrl = await toDataUrl(body, mime);
        return { dataUrl, mime };
      }
    } catch(_) {}
    return null;
  }

  async function extractFileFromRequest(req, opts) {
    let body = opts.body;
    if (body) {
      return await extractFileFromRequestBody(body);
    }
    if (req instanceof Request) {
      try {
        try {
          const clonedForFD = req.clone();
          const fd = await clonedForFD.formData();
          const file = await extractFileFromRequestBody(fd);
          if (file) return file;
        } catch (_) {}

        try {
          const clonedForBlob = req.clone();
          const blob = await clonedForBlob.blob();
          const file = await extractFileFromRequestBody(blob);
          if (file) return file;
        } catch (_) {}
      } catch(_) {}
    }
    return null;
  }

  async function inspectRequest(req, opts, url) {
    let method = 'GET';
    if (opts.method) {
      method = opts.method.toUpperCase();
    } else if (req instanceof Request && req.method) {
      method = req.method.toUpperCase();
    }
    
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      return;
    }

    let body = opts.body;
    let contentType = '';
    
    const getHeader = (headers, name) => {
      if (!headers) return null;
      if (typeof headers.get === 'function') return headers.get(name);
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === name.toLowerCase()) return v;
      }
      return null;
    };
    
    contentType = getHeader(opts.headers, 'content-type') || '';
    if (req instanceof Request) {
      if (!contentType) contentType = getHeader(req.headers, 'content-type') || '';
    }
    
    if (body) {
      await inspectRequestBodyClaude(body, url);
    } else if (req instanceof Request) {
      try {
        let parsed = false;
        // Try parsing Request body as formData first (in case it is FormData packed in Request without Content-Type header)
        try {
          const clonedForFD = req.clone();
          const fd = await clonedForFD.formData();
          await inspectRequestBodyClaude(fd, url);
          parsed = true;
        } catch (_) {}

        if (!parsed) {
          try {
            const clonedForBlob = req.clone();
            const blob = await clonedForBlob.blob();
            await inspectRequestBodyClaude(blob, url);
          } catch (_) {}
        }
      } catch(e) {
        console.warn("[CEP] Failed to clone/parse request body:", e);
      }
    }
  }

  function urlsMatchFile(url1, url2) {
    if (!url1 || !url2) return false;
    if (url1 === url2) return true;
    try {
      const u1 = new URL(url1, window.location.origin);
      const u2 = new URL(url2, window.location.origin);
      
      // 1. Compare sig parameter (unique signature query param)
      const sig1 = u1.searchParams.get('sig');
      const sig2 = u2.searchParams.get('sig');
      if (sig1 && sig2 && sig1 === sig2) return true;

      // 2. Compare file-XXXXXX or file_XXXXXX ID in path
      const id1 = u1.pathname.match(/file[-_][a-zA-Z0-9]{8,}/);
      const id2 = u2.pathname.match(/file[-_][a-zA-Z0-9]{8,}/);
      if (id1 && id2 && id1[0] === id2[0]) return true;

      // 3. Fallback: compare pathname if not a generic estuary path
      if (u1.pathname === u2.pathname && !u1.pathname.includes('estuary') && !u1.pathname.includes('content')) return true;
    } catch(_) {}
    return false;
  }

  function scanJsonForFiles(obj) {
    if (!obj || typeof obj !== 'object') return;
    
    // Helper to find all file-like IDs in a subtree
    function findIds(item, ids = []) {
      if (!item) return ids;
      const isChatGpt = window.location.hostname.includes('chatgpt.com');
      if (typeof item === 'string') {
        const isOaiFile = item.startsWith('file-') || item.startsWith('file_') || item.startsWith('libfile_');
        const isClaudeFile = !isChatGpt && /^[a-f0-9-]{36}$/.test(item);
        if (isOaiFile || isClaudeFile) {
          ids.push(item);
        }
      } else if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) findIds(item[i], ids);
      } else if (typeof item === 'object') {
        for (const v of Object.values(item)) findIds(v, ids);
      }
      return ids;
    }
    
    // Helper to find all filenames in a subtree
    const fileExts = ['pdf', 'zip', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bin', 'txt', 'csv', 'py', 'json', 'sh', 'js', 'html', 'css', 'md'];
    function findNames(item, names = []) {
      if (!item) return names;
      if (typeof item === 'string') {
        const clean = item.trim();
        if (clean.includes('.')) {
          const ext = clean.split('.').pop().toLowerCase();
          if (fileExts.includes(ext) && clean.length < 255) {
            names.push(clean);
          }
        }
      } else if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) findNames(item[i], names);
      } else if (typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) {
          if (k === 'url' || k === 'download_url' || k === 'downloadUrl') continue;
          findNames(v, names);
        }
      }
      return names;
    }

    // Recursively scan objects. If an object contains both IDs and filenames in its subtree, pair them!
    function processNode(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) processNode(node[i]);
        return;
      }
      
      const isChatGpt = window.location.hostname.includes('chatgpt.com');
      
      if (!isChatGpt) {
        // Claude: Pair ID and filename only if they are direct properties of this node
        let fileId = node.id || node.uuid || node.file_id || node.fileId;
        if (fileId && typeof fileId === 'string' && /^[a-f0-9-]{36}$/.test(fileId)) {
          let filename = node.file_name || node.filename || node.fileName;
          if (!filename && node.name && (node.file_size || node.fileSize || node.mime_type || node.mimeType || node.file_type || node.fileType)) {
            filename = node.name;
          }
          if (filename && typeof filename === 'string') {
            const clean = filename.trim().replace(/^\d{10,13}_/, '');
            if (clean.includes('.')) {
              const ext = clean.split('.').pop().toLowerCase();
              if (fileExts.includes(ext) && clean.length < 255) {
                window.__cep.idMap[fileId] = clean;
                
                if (node.extracted_content) {
                  window.__cep.extractedContentMap[fileId] = node.extracted_content;
                }
                
                let dlUrl = node.download_url || node.downloadUrl || node.url || null;
                if (dlUrl && typeof dlUrl === 'string') {
                  window.__cep.urlMap[dlUrl] = clean;
                  try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = clean; } catch(_) {}
                  window.__cep.downloadUrlMap[fileId] = dlUrl;
                }
              }
            }
          }
        }
      } else {
        // ChatGPT: Recursive subtree scanning
        const localIds = findIds(node);
        const localNames = findNames(node);
        
        if (localIds.length > 0 && localNames.length > 0) {
          for (const fileId of localIds) {
            const filename = localNames[0].replace(/^\d{10,13}_/, '');
            window.__cep.idMap[fileId] = filename;
            
            let dlUrl = node.download_url || node.downloadUrl || node.url || null;
            if (dlUrl && typeof dlUrl === 'string') {
              window.__cep.urlMap[dlUrl] = filename;
              try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = filename; } catch(_) {}
              window.__cep.downloadUrlMap[fileId] = dlUrl;
            }
          }
        }
      }
      
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          processNode(node[k]);
        }
      }
    }

    processNode(obj);
  }

  // ── Gemini-specific JSON scanner ──────────────────────────────────────────
  // Scans Gemini API responses for file metadata (file names, MIME types, URIs)
  // and pairs them with intercepted upload blobs
  function scanGeminiJson(obj, url) {
    if (!obj || typeof obj !== 'object') return;
    
    function processGeminiNode(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) processGeminiNode(item);
        return;
      }
      
      // Look for file metadata objects with name + mime_type
      const fileName = node.file_name || node.fileName || node.filename || 
                       node.display_name || node.displayName;
      const mimeType = node.mime_type || node.mimeType || node.content_type || node.contentType;
      const fileUri = node.file_uri || node.fileUri || node.uri || node.url;
      const fileId = node.name || node.id || node.file_id || node.fileId; // Gemini uses "name" field like "files/abc123"
      
      if (fileName && typeof fileName === 'string' && fileName.includes('.')) {
        const clean = fileName.trim().replace(/^\d{10,13}_/, '');
        if (clean.length < 255 && clean.length > 1) {
          console.log('[CEP] Gemini JSON: Found file metadata:', clean, 'mime:', mimeType, 'uri:', fileUri);
          
          // Map file ID to name
          if (fileId && typeof fileId === 'string') {
            window.__cep.idMap[fileId] = clean;
            if (fileUri) {
              window.__cep.urlMap[fileUri] = clean;
              window.__cep.downloadUrlMap[fileId] = fileUri;
            }
          }
          
          // Try to pair with the last uploaded file blob
          if (window.__cep.lastUploadedFile) {
            const elapsed = Date.now() - window.__cep.lastUploadedFile.time;
            if (elapsed < 30000) { // 30 second window for Gemini (can be slow)
              const { dataUrl, mime } = window.__cep.lastUploadedFile;
              save(clean, dataUrl, mime || mimeType || 'application/octet-stream', fileUri || url);
              console.log('[CEP] Gemini: Paired uploaded blob with metadata:', clean);
              window.__cep.lastUploadedFile = null; // consumed
            }
          }
        }
      }
      
      // Also look for inline_data with mime_type (base64 embedded files)
      if (node.inline_data && node.inline_data.mime_type && node.inline_data.data) {
        const mime = node.inline_data.mime_type;
        if (!mime.startsWith('image/')) { // images are handled separately
          const ext = mext(mime);
          const name = 'gemini_file_' + Date.now() + '.' + ext;
          const dataUrl = 'data:' + mime + ';base64,' + node.inline_data.data;
          save(name, dataUrl, mime, url);
          console.log('[CEP] Gemini: Found inline file data:', name, mime);
        }
      }
      
      // Recurse into child objects
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          processGeminiNode(node[k]);
        }
      }
    }
    
    processGeminiNode(obj);
  }

  function getName(url) {
    if (!url) return null;
    // 1. Exact match in urlMap
    if (window.__cep.urlMap[url]) return window.__cep.urlMap[url];
    try {
      const u = new URL(url, window.location.origin);
      if (window.__cep.urlMap[u.href]) return window.__cep.urlMap[u.href];
      
      // 2. Check file ID mapping from idMap
      for (const [fileId, name] of Object.entries(window.__cep.idMap)) {
        if (u.pathname.includes(fileId) || url.includes(fileId)) {
          return name;
        }
      }

      // 3. Try fuzzy signature or file ID mapping from urlMap
      for (const [dlUrl, name] of Object.entries(window.__cep.urlMap)) {
        if (urlsMatchFile(url, dlUrl)) return name;
      }

      // 4. rscd param
      const rscd = u.searchParams.get('rscd') || u.searchParams.get('response-content-disposition') || '';
      if (rscd) {
        const m = rscd.match(/filename[*]?=(?:UTF-8'')?["']?([^"';&\n\r]+)/i);
        if (m) return decodeURIComponent(m[1]).replace(/["']/g,'').trim();
      }
      
      // 5. Path segment
      const segs = u.pathname.split('/').filter(Boolean);
      for (let i = segs.length-1; i >= 0; i--) {
        const s = decodeURIComponent(segs[i]);
        if (s.includes('.') && s !== 'download' && s.length < 200 &&
            !/^[a-f0-9\-]{20,}$/.test(s) && !/^\d+$/.test(s)) return s;
      }
    } catch(_) {}
    return null;
  }

  function mext(mime) {
    const m = (mime||'').toLowerCase();
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('zip')) return 'zip';
    if (m.includes('wordprocessingml')||m.includes('msword')) return 'docx';
    if (m.includes('spreadsheetml')) return 'xlsx';
    if (m.includes('presentationml')) return 'pptx';
    if (m.includes('text/plain')) return 'txt';
    if (m.includes('csv')) return 'csv';
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg')||m.includes('jpg')) return 'jpg';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    return 'bin';
  }

  function isCapture(url, ct) {
    const u = url.toLowerCase(), c = (ct||'').toLowerCase();
    
    // Ignore API metadata/download JSON endpoints (not actual file binaries)
    if (u.includes('/backend-api/files/')) return false;

    // Ignore JSON/HTML response content-types for API endpoints
    if ((c.includes('json') || c.includes('html')) && (
      u.includes('/api/organizations/') || u.includes('/backend-api/') ||
      u.includes('generativelanguage.googleapis.com') || u.includes('gemini.google.com') ||
      u.includes('drive.google.com')
    )) {
      return false;
    }

    // Skip preview/thumbnail endpoints (these are document thumbnails, not the original files)
    if (/\/files\/[a-f0-9-]{36}\/(preview|thumbnail)\b/.test(u) || u.endsWith('/preview') || u.includes('/preview?') || u.endsWith('/thumbnail') || u.includes('/thumbnail?')) {
      return false;
    }

    // Skip Gemini document viewer page renders (these render pages as images, not original files)
    if (u.includes('drive.google.com/viewer/')) return false;

    const fileUrl = u.includes('oaiusercontent') || u.includes('estuary') ||
      u.includes('/files/') || u.includes('file-service') ||
      u.includes('blob.core.windows') || u.includes('storage.googleapis') ||
      u.includes('/api/organizations/') ||
      // Gemini-specific upload/storage endpoints (gated to avoid affecting ChatGPT)
      (IS_GEMINI && (
        u.includes('generativelanguage.googleapis.com') ||
        u.includes('upload.googleapis.com') ||
        u.includes('content-push.googleapis.com') ||
        u.includes('drivedl.googleapis.com')
      ));
    const fileMime = c.includes('pdf')||c.includes('zip')||c.includes('msword')||
      c.includes('officedocument')||c.includes('octet-stream')||
      c.includes('image/png')||c.includes('image/jpeg')||
      c.includes('image/gif')||c.includes('image/webp')||
      c.includes('text/plain')||c.includes('text/csv');
    return fileUrl || fileMime;
  }

  // ── Claude Counter Bridge Constants & Helpers (Claude Only) ────────────────
  const CC_MARKER = 'ClaudeCounter';

  function cc_post(type, payload) {
    window.postMessage({ cc: CC_MARKER, type, payload }, '*');
  }

  function toAbsoluteUrl(input) {
    if (typeof input === 'string') {
      if (input.startsWith('/')) return `https://claude.ai${input}`;
      return input;
    }
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    return '';
  }

  function getConversationMeta(url) {
    const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
    return match ? { orgId: match[1], conversationId: match[2] } : null;
  }

  async function handleConversationResponse({ orgId, conversationId }, response) {
    try {
      const cloned = response.clone();
      const data = await cloned.json();
      cc_post('cc:conversation', { orgId, conversationId, data });
    } catch {
      // ignore
    }
  }

  async function handleEventStream(response) {
    try {
      const cloned = response.clone();
      const reader = cloned.body?.getReader?.();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const json = JSON.parse(raw);
            if (json?.type === 'message_limit' && json.message_limit) {
              cc_post('cc:message_limit', json.message_limit);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Wrap history methods early to detect SPA navigation (Claude Only)
  if (IS_CLAUDE) {
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      const result = originalPushState(...args);
      window.dispatchEvent(new CustomEvent('cc:urlchange'));
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState(...args);
      window.dispatchEvent(new CustomEvent('cc:urlchange'));
      return result;
    };
  }

  // Fetch hook
  const _fetch = window.fetch;
  window.fetch = async function(...args) {
    const req = args[0];
    const opts = args[1] || {};
    const url = typeof req==='string'?req:(req instanceof Request?req.url:String(req));

    if (IS_CLAUDE) {
      // ── CLAUDE FETCH HOOK ──
      let method = 'GET';
      if (opts.method) {
        method = opts.method.toUpperCase();
      } else if (req instanceof Request && req.method) {
        method = req.method.toUpperCase();
      }
      
      let uploadFilePromise = null;
      if (url.includes('/files') && (method === 'POST' || method === 'PUT')) {
        uploadFilePromise = extractFileFromRequest(req, opts);
      }

      // Inspect request body (for capturing uploads, including Request objects)
      inspectRequest(req, opts, url).catch(_=>{});

      // Capture auth and Claude headers
      let auth = null;
      const claudeHeaders = {};
      if (opts.headers) {
        if (opts.headers instanceof Headers) {
          auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
          for (const [hk, hv] of opts.headers.entries()) {
            const hkl = hk.toLowerCase();
            if (hkl.startsWith('anthropic-') || hkl === 'organization-id' || hkl === 'custom-agent-id') {
              claudeHeaders[hk] = hv;
            }
          }
        } else {
          for (const [hk, hv] of Object.entries(opts.headers)) {
            const hkl = hk.toLowerCase();
            if (hkl === 'authorization') { auth = hv; }
            if (hkl.startsWith('anthropic-') || hkl === 'organization-id' || hkl === 'custom-agent-id') {
              claudeHeaders[hk] = hv;
            }
          }
        }
      }
      if (req instanceof Request && req.headers) {
        if (req.headers instanceof Headers) {
          if (!auth) auth = req.headers.get('Authorization') || req.headers.get('authorization');
          for (const [hk, hv] of req.headers.entries()) {
            const hkl = hk.toLowerCase();
            if (hkl.startsWith('anthropic-') || hkl === 'organization-id' || hkl === 'custom-agent-id') {
              claudeHeaders[hk] = hv;
            }
          }
        } else {
          for (const [hk, hv] of Object.entries(req.headers)) {
            const hkl = hk.toLowerCase();
            if (hkl === 'authorization') { if (!auth) auth = hv; }
            if (hkl.startsWith('anthropic-') || hkl === 'organization-id' || hkl === 'custom-agent-id') {
              claudeHeaders[hk] = hv;
            }
          }
        }
      }
      if (auth) {
        window.__cep.authHeader = auth;
        console.log("[CEP] Captured fetch Authorization header:", auth.slice(0, 20) + "...");
      }
      if (Object.keys(claudeHeaders).length > 0) {
        Object.assign(window.__cep.claudeHeaders, claudeHeaders);
        console.log("[CEP] Captured Claude headers:", Object.keys(claudeHeaders));
      }

      // org ID
      const om = url.match(/\/organizations\/([a-f0-9-]{36})\//);
      if (om) window.__cep.orgId = om[1];

      // Claude Counter generation start detection
      const absUrl = toAbsoluteUrl(url);
      if (absUrl && opts.method === 'POST' && (absUrl.includes('/completion') || absUrl.includes('/retry_completion'))) {
        cc_post('cc:generation_start', {});
      }

      const resp = await _fetch.apply(this, args);

      try {
        const absUrl = toAbsoluteUrl(url);
        if (absUrl) {
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('event-stream')) {
            handleEventStream(resp);
          }

          if (absUrl.includes('/chat_conversations/') && absUrl.includes('tree=')) {
            const meta = getConversationMeta(absUrl);
            if (meta) {
              handleConversationResponse(meta, resp);
            }
          }
        }
      } catch(_) {}

      try {
        const ct = resp.headers.get('content-type') || '';
        
        if (uploadFilePromise) {
          uploadFilePromise.then(uploadFile => {
            if (uploadFile && resp.ok && (resp.status === 200 || resp.status === 201)) {
              if (ct.includes('application/json')) {
                resp.clone().json().then(json => {
                  const fileId = json.uuid || json.id;
                  const filename = json.file_name || json.filename || json.name;
                  if (fileId && filename) {
                    save(filename, uploadFile.dataUrl, uploadFile.mime, url);
                    window.__cep.idMap[fileId] = filename.trim().replace(/^\d{10,13}_/, '');
                    console.log("[CEP] Direct fetch upload matched successfully:", filename, "to ID:", fileId);
                  }
                }).catch(_=>{});
              }
            }
          }).catch(_=>{});
        }

        // Intercept upload response to map real filename/ID to the last uploaded binary blob
        if (url.includes('/files') && ct.includes('application/json') && resp.ok && (resp.status === 200 || resp.status === 201)) {
          resp.clone().json().then(json => {
            const fileId = json.uuid || json.id;
            const filename = json.file_name || json.filename || json.name;
            if (fileId && filename && window.__cep.lastUploadedFile) {
              const elapsed = Date.now() - window.__cep.lastUploadedFile.time;
              if (elapsed < 15000) {
                const { dataUrl, mime } = window.__cep.lastUploadedFile;
                save(filename, dataUrl, mime, url);
                window.__cep.idMap[fileId] = filename.trim().replace(/^\d{10,13}_/, '');
                console.log("[CEP] Intercepted upload response and mapped file:", filename, "to ID:", fileId);
              }
            }
          }).catch(_=>{});
        }

        // Intercept conversation and messages JSON payloads to map file IDs to filenames
        if (ct.includes('application/json') && (url.includes('/backend-api/') || url.includes('/api/organizations/'))) {
          resp.clone().json().then(d => {
            scanJsonForFiles(d);
          }).catch(_=>{});
        }

        // Skip non-file responses
        if (!isCapture(url, ct)) return resp;

        // Capture arrayBuffer file content
        resp.clone().arrayBuffer().then(async buffer => {
          if (buffer.byteLength < 100) return;
          const dataUrl = await toDataUrl(buffer, ct);
          let name = getName(url);
          if (!name) {
            const idM = url.match(/file-([a-zA-Z0-9]{8})/);
            name = idM ? ('file_'+idM[1]+'.'+mext(ct)) : ('file.'+mext(ct));
          }
          save(name, dataUrl, ct, url);
        }).catch(_=>{});
      } catch(_) {}

      return resp;
    } else {
      // ── LEGACY CHATGPT / GEMINI / GROK FETCH HOOK ──
      // Inspect request body if present (for capturing uploads)
      if (IS_GEMINI) {
        // Gemini: comprehensive upload body capture (handles all body types)
        (async () => {
          try {
            let body = opts.body;
            let contentType = '';
            
            // Extract Content-Type from headers
            if (opts.headers) {
              if (opts.headers instanceof Headers) {
                contentType = opts.headers.get('Content-Type') || opts.headers.get('content-type') || '';
              } else if (typeof opts.headers === 'object') {
                for (const [k, v] of Object.entries(opts.headers)) {
                  if (k.toLowerCase() === 'content-type') { contentType = v; break; }
                }
              }
            }
            
            // Also try to get body from Request object
            if (!body && req instanceof Request) {
              try {
                contentType = contentType || req.headers.get('content-type') || '';
                body = await req.clone().blob();
              } catch(_) {}
            }
            
            if (!body) return;
            
            // Handle different body types
            let dataUrl = null, mime = '', fileName = '';
            
            if (body instanceof File) {
              fileName = body.name;
              mime = body.type;
              dataUrl = await toDataUrl(body, mime);
            } else if (body instanceof FormData) {
              for (const [key, val] of body.entries()) {
                if (val instanceof File || (val instanceof Blob && val.size > 100)) {
                  fileName = val.name || ('upload_' + Date.now() + '.' + mext(val.type));
                  mime = val.type;
                  dataUrl = await toDataUrl(val, mime);
                  break;
                }
              }
            } else if (body instanceof Blob && body.size > 100) {
              fileName = getName(url) || ('upload_' + Date.now() + '.' + mext(body.type || contentType));
              mime = body.type || contentType;
              dataUrl = await toDataUrl(body, mime);
            } else if (body instanceof ArrayBuffer && body.byteLength > 100) {
              mime = contentType || 'application/octet-stream';
              fileName = getName(url) || ('upload_' + Date.now() + '.' + mext(mime));
              dataUrl = await toDataUrl(body, mime);
            }
            
            if (dataUrl && dataUrl.length > 100) {
              save(fileName, dataUrl, mime, url);
              window.__cep.lastUploadedFile = { dataUrl, mime, time: Date.now() };
              console.log('[CEP] Gemini: Captured upload:', fileName, 'mime:', mime, 'size:', dataUrl.length);
            }
          } catch(_) {}
        })();
      }
      if (opts.body) {
        inspectRequestBodyLegacy(opts.body, url).catch(_=>{});
      }

      // Capture auth and OAI headers
      let auth = null;
      const oaiHeaders = {};
      if (opts.headers) {
        if (opts.headers instanceof Headers) {
          auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
          for (const [hk, hv] of opts.headers.entries()) {
            if (hk.toLowerCase().startsWith('oai-')) {
              oaiHeaders[hk.toLowerCase()] = hv;
            }
          }
        } else {
          for (const [hk, hv] of Object.entries(opts.headers)) {
            if (hk.toLowerCase() === 'authorization') { auth = hv; }
            if (hk.toLowerCase().startsWith('oai-')) {
              oaiHeaders[hk.toLowerCase()] = hv;
            }
          }
        }
      }
      if (req instanceof Request && req.headers) {
        if (req.headers instanceof Headers) {
          if (!auth) auth = req.headers.get('Authorization') || req.headers.get('authorization');
          for (const [hk, hv] of req.headers.entries()) {
            if (hk.toLowerCase().startsWith('oai-')) {
              oaiHeaders[hk.toLowerCase()] = hv;
            }
          }
        } else {
          for (const [hk, hv] of Object.entries(req.headers)) {
            if (hk.toLowerCase() === 'authorization') { if (!auth) auth = hv; }
            if (hk.toLowerCase().startsWith('oai-')) {
              oaiHeaders[hk.toLowerCase()] = hv;
            }
          }
        }
      }
      if (auth) {
        window.__cep.authHeader = auth;
        console.log("[CEP] Captured fetch Authorization header:", auth.slice(0, 20) + "...");
      }
      if (Object.keys(oaiHeaders).length > 0) {
        Object.assign(window.__cep.oaiHeaders, oaiHeaders);
        console.log("[CEP] Captured OAI headers:", Object.keys(oaiHeaders));
      }

      // org ID
      const om = url.match(/\/organizations\/([a-f0-9-]{36})\//);
      if (om) window.__cep.orgId = om[1];

      const resp = await _fetch.apply(this, args);

      try {
        const ct = resp.headers.get('content-type') || '';
        
        // ── Gemini-specific JSON interception ──
        if (IS_GEMINI && ct.includes('application/json')) {
          resp.clone().text().then(text => {
            try {
              // Gemini may return multiple JSON objects or arrays
              const data = JSON.parse(text);
              scanGeminiJson(data, url);
            } catch(_) {
              // Try parsing as JSONL (newline-delimited JSON)
              for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                  const d = JSON.parse(line.trim());
                  scanGeminiJson(d, url);
                } catch(_) {}
              }
            }
          }).catch(_=>{});
        }

        // 1. Intercept conversation and messages JSON payloads to map file IDs to filenames
        if (ct.includes('application/json') && (url.includes('/backend-api/') || url.includes('/api/organizations/'))) {
          resp.clone().json().then(d => {
            scanJsonForFiles(d);
          }).catch(_=>{});
        }

        // 2. Intercept ChatGPT /download metadata JSON (historical / explicit download trigger)
        if (/\/backend-api\/files\/[^/?]+\/download/.test(url)) {
          resp.clone().json().then(d => {
            const fname   = d.file_name || d.fileName || d.filename || d.name || null;
            const dlUrl   = d.download_url || d.downloadUrl || d.url || null;
            if (fname && dlUrl) {
              window.__cep.urlMap[dlUrl] = fname;
              try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = fname; } catch(_) {}
              
              // Check if we already captured a file for this download URL under a generic name
              for (const [k, v] of Object.entries(window.__cep.files)) {
                if (urlsMatchFile(v.url, dlUrl)) {
                  save(fname, v.dataUrl, v.mimeType, v.url);
                  delete window.__cep.files[k];
                  console.log("[CEP] Late-registered and renamed generic file to:", fname);
                }
              }
            }
          }).catch(_=>{});
          return resp; // don't capture this JSON as a file
        }

        // 3. Skip non-file responses
        if (!isCapture(url, ct)) return resp;

        // 4. Capture arrayBuffer file content
        resp.clone().arrayBuffer().then(async buffer => {
          if (buffer.byteLength < 100) return;
          const dataUrl = await toDataUrl(buffer, ct);
          let name = getName(url);
          if (!name) {
            const idM = url.match(/file-([a-zA-Z0-9]{8})/);
            name = idM ? ('file_'+idM[1]+'.'+mext(ct)) : ('file.'+mext(ct));
          }
          save(name, dataUrl, ct, url);
        }).catch(_=>{});
      } catch(_) {}

      return resp;
    }
  };

  // XHR hook
  const _xopen = XMLHttpRequest.prototype.open;
  const _xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u,...r) {
    this.__cepUrl = String(u||'');
    const om = this.__cepUrl.match(/\/organizations\/([a-f0-9-]{36})\//);
    if (om) window.__cep.orgId = om[1];
    return _xopen.apply(this,[m,u,...r]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const body = args[0];
    let uploadFilePromise = null;
    const url = this.__cepUrl || '';
    if (body) {
      if (IS_CLAUDE) {
        if (url.includes('/files')) {
          uploadFilePromise = extractFileFromRequestBody(body);
        }
        inspectRequestBodyClaude(body, this.__cepUrl).catch(_=>{});
      } else {
        inspectRequestBodyLegacy(body, this.__cepUrl).catch(_=>{});
      }
    }
    this.addEventListener('readystatechange', function() {
      if (this.readyState!==4||this.status<200||this.status>=300) return;
      try {
        const url = this.__cepUrl||'';
        let ct=''; try{ct=this.getResponseHeader('content-type')||'';}catch(_){}

        if (IS_CLAUDE) {
          if (uploadFilePromise && url.includes('/files') && ct.includes('application/json')) {
            uploadFilePromise.then(uploadFile => {
              if (uploadFile) {
                try {
                  const json = JSON.parse(this.responseText);
                  const fileId = json.uuid || json.id;
                  const filename = json.file_name || json.filename || json.name;
                  if (fileId && filename) {
                    save(filename, uploadFile.dataUrl, uploadFile.mime, url);
                    window.__cep.idMap[fileId] = filename.trim().replace(/^\d{10,13}_/, '');
                    console.log("[CEP] Direct XHR upload matched successfully:", filename, "to ID:", fileId);
                  }
                } catch(_) {}
              }
            }).catch(_=>{});
          }

          // Intercept upload response to map real filename/ID to the last uploaded binary blob via XHR
          if (url.includes('/files') && ct.includes('application/json')) {
            try {
              const json = JSON.parse(this.responseText);
              const fileId = json.uuid || json.id;
              const filename = json.file_name || json.filename || json.name;
              if (fileId && filename && window.__cep.lastUploadedFile) {
                const elapsed = Date.now() - window.__cep.lastUploadedFile.time;
                if (elapsed < 15000) {
                  const { dataUrl, mime } = window.__cep.lastUploadedFile;
                  save(filename, dataUrl, mime, url);
                  window.__cep.idMap[fileId] = filename.trim().replace(/^\d{10,13}_/, '');
                  console.log("[CEP] Intercepted XHR upload response and mapped file:", filename, "to ID:", fileId);
                }
              }
            } catch(_) {}
          }

          // Generic XHR JSON scanner to capture file ID metadata mappings
          if (ct.includes('application/json') && (url.includes('/backend-api/') || url.includes('/api/organizations/'))) {
            try {
              const d = JSON.parse(this.responseText);
              scanJsonForFiles(d);
            } catch(_) {}
          }

          if (!isCapture(url,ct)) return;
          const respData = this.response;
          if (!respData) return;
          toDataUrl(respData, ct).then(dataUrl => {
            const base64Part = dataUrl.split(',')[1] || '';
            if (base64Part.length < 100) return;
            let name = getName(url);
            if (!name) {
              const idM = url.match(/file[-_]([a-zA-Z0-9]{8})/);
              name = idM ? ('file_'+idM[1]+'.'+mext(ct)) : ('file.'+mext(ct));
            }
            save(name, dataUrl, ct, url);
          }).catch(_=>{});
        } else {
          // Gemini XHR JSON scanning
          if (IS_GEMINI && ct.includes('application/json')) {
            try {
              const d = JSON.parse(this.responseText);
              scanGeminiJson(d, url);
            } catch(_) {}
          }

          // Intercept ChatGPT /download metadata via XHR
          if (/\/backend-api\/files\/[^/?]+\/download/.test(url)) {
            try {
              const d = JSON.parse(this.responseText);
              const fname = d.file_name || d.fileName || d.filename || d.name || null;
              const dlUrl = d.download_url || d.downloadUrl || d.url || null;
              if (fname && dlUrl) {
                window.__cep.urlMap[dlUrl] = fname;
                try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = fname; } catch(_) {}
                
                // Late rename generic files
                for (const [k, v] of Object.entries(window.__cep.files)) {
                  if (urlsMatchFile(v.url, dlUrl)) {
                    save(fname, v.dataUrl, v.mimeType, v.url);
                    delete window.__cep.files[k];
                    console.log("[CEP] XHR late-registered and renamed generic file to:", fname);
                  }
                }
              }
            } catch(_) {}
            return;
          }

          // Generic XHR JSON scanner to capture file ID metadata mappings
          if (ct.includes('application/json') && (url.includes('/backend-api/') || url.includes('/api/organizations/'))) {
            try {
              const d = JSON.parse(this.responseText);
              scanJsonForFiles(d);
            } catch(_) {}
          }

          if (!isCapture(url,ct)) return;
          const respData = this.response;
          if (!respData) return;
          toDataUrl(respData, ct).then(dataUrl => {
            const base64Part = dataUrl.split(',')[1] || '';
            if (base64Part.length < 100) return;
            let name = getName(url);
            if (!name) {
              const idM = url.match(/file[-_]([a-zA-Z0-9]{8})/);
              name = idM ? ('file_'+idM[1]+'.'+mext(ct)) : ('file.'+mext(ct));
            }
            save(name, dataUrl, ct, url);
          }).catch(_=>{});
        }
      } catch(_) {}
    });
    return _xsend.apply(this,args);
  };

  // Event API
  window.addEventListener('__cepQuery', async () => {
    console.log("[CEP] __cepQuery event received. authHeader:", !!window.__cep.authHeader);
    
    try {
      // 1. Try to fetch conversation history if authHeader is available and we are on a chatgpt conversation page
    if (window.__cep.authHeader && window.location.hostname.includes('chatgpt.com')) {
      const match = window.location.pathname.match(/\/c\/([a-f0-9-]{36})/);
      const convId = match ? match[1] : null;

      // Clear store if we switched to a different conversation (or to a new chat)
      if (window.__cep.lastConvId !== convId) {
        console.log("[CEP] Conversation changed from", window.__cep.lastConvId, "to", convId, "- clearing file store.");
        window.__cep.files = {};
        window.__cep.idMap = {};
        window.__cep.urlMap = {};
        window.__cep.lastConvId = convId;
      }

      if (convId) {
        console.log("[CEP] __cepQuery: Fetching conversation tree for:", convId);
        try {
          const res = await _fetch(`/backend-api/conversation/${convId}`, {
            headers: {
              'Authorization': window.__cep.authHeader,
              'accept': 'application/json'
            }
          });
          console.log("[CEP] __cepQuery: Conversation tree fetch status:", res.status);
          if (res.ok) {
            const data = await res.json();
            scanJsonForFiles(data);
             
            console.log("[CEP] __cepQuery: Parsed tree. idMap size:", Object.keys(window.__cep.idMap).length);
            
            // On-demand fetch file binaries programmatically in parallel
            const _downloadEntries = Object.entries(window.__cep.idMap);
            await Promise.all(_downloadEntries.map(async ([fileId, filename]) => {
              const k = filename.toLowerCase().trim();
              // Only download valid OpenAI storage IDs (starting with file-, file_ or libfile_)
              const isOaiFile = typeof fileId === 'string' && (fileId.startsWith('file-') || fileId.startsWith('file_') || fileId.startsWith('libfile_'));
              if (!window.__cep.files[k] && isOaiFile) {
                console.log("[CEP] On-demand page-context fetching file:", filename, fileId);
                try {
                  const reqHeaders = {
                    'Authorization': window.__cep.authHeader,
                    'accept': 'application/json',
                    ...window.__cep.oaiHeaders
                  };
                  let dlRes = null;
                  let dlMeta = null;
                  let downloadUrl = null;
                  
                  const endpoints = [];
                  if (typeof fileId === 'string' && fileId.startsWith('libfile_')) {
                    endpoints.push(`/backend-api/files/library/${fileId}/download?conversation_id=${convId}`);
                    endpoints.push(`/backend-api/files/library/${fileId}?conversation_id=${convId}`);
                    endpoints.push(`/backend-api/files/${fileId}/download?conversation_id=${convId}`);
                  } else {
                    endpoints.push(`/backend-api/files/${fileId}/download?conversation_id=${convId}`);
                  }

                  let lastErrorPayload = null;
                  let lastStatus = 0;
                  
                  for (const endpoint of endpoints) {
                    try {
                      const tempRes = await _fetch(endpoint, {
                        headers: reqHeaders,
                        credentials: 'include'
                      });
                      lastStatus = tempRes.status;
                      if (tempRes.ok) {
                        const tempMeta = await tempRes.json();
                        const tempUrl = tempMeta.download_url || tempMeta.downloadUrl || tempMeta.url;
                        if (tempUrl) {
                          dlRes = tempRes;
                          dlMeta = tempMeta;
                          downloadUrl = tempUrl;
                          break;
                        } else {
                          lastErrorPayload = tempMeta;
                        }
                      } else {
                        try { lastErrorPayload = await tempRes.json(); } catch(_) { lastErrorPayload = null; }
                      }
                    } catch(err) {
                      console.warn("[CEP] On-demand download endpoint try failed for:", endpoint, err);
                    }
                  }

                  if (downloadUrl) {
                    console.log("[CEP] On-demand download URL resolved for:", filename);
                    const fileHeaders = { 'accept': '*/*' };
                    if (downloadUrl.includes('/backend-api/') && window.__cep.authHeader) {
                      fileHeaders['Authorization'] = window.__cep.authHeader;
                    }
                    const fileRes = await _fetch(downloadUrl, { headers: fileHeaders });
                    console.log("[CEP] On-demand content response for:", filename, fileRes.status);
                    if (fileRes.ok) {
                      const buffer = await fileRes.arrayBuffer();
                      const dataUrl = await toDataUrl(buffer, fileRes.headers.get('content-type'));
                      save(filename, dataUrl, fileRes.headers.get('content-type'), downloadUrl);
                      console.log("[CEP] On-demand successfully saved file:", filename);
                    } else {
                      console.warn("[CEP] On-demand content fetch failed for:", filename, "status:", fileRes.status);
                    }
                  } else {
                    console.log("[CEP] On-demand download URL not available/expired for:", filename, "Last status:", lastStatus, "Payload:", JSON.stringify(lastErrorPayload));
                  }
                } catch(e) {
                  console.warn("[CEP] Failed on-demand fetch for file:", filename, e);
                }
              }
            }));
          }
        } catch(e) {
          console.warn("[CEP] On-demand conversation fetch failed:", e);
        }
      } else {
        console.log("[CEP] __cepQuery: Path does not match conversation UUID:", window.location.pathname);
      }
    } else if (window.location.hostname.includes('claude.ai')) {
      const match = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/);
      const convId = match ? match[1] : null;

      // Extract Claude organization ID from window.__cep.orgId or lastActiveOrg cookie or document path
      let orgId = window.__cep.orgId;
      if (!orgId) {
        const m = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/);
        if (m) {
          orgId = m[1];
          window.__cep.orgId = orgId;
        }
      }
      if (!orgId) {
        for (const k of Object.keys(localStorage)) {
          try {
            const v = JSON.parse(localStorage.getItem(k));
            if (v?.uuid) { orgId = v.uuid; window.__cep.orgId = orgId; break; }
            if (v?.id && /^[a-f0-9-]{36}$/.test(v.id)) { orgId = v.id; window.__cep.orgId = orgId; break; }
          } catch(_) {}
        }
      }
      if (!orgId) {
        const pm = window.location.pathname.match(/\/([a-f0-9-]{36})\//);
        if (pm) {
          orgId = pm[1];
          window.__cep.orgId = orgId;
        }
      }

      // Clear store if we switched to a different conversation (or to a new chat)
      // Do not clear if we are transitioning from no conversation (null/new) to a new conversation
      const isTransitionFromNew = !window.__cep.lastConvId;
      if (window.__cep.lastConvId !== convId) {
        if (!isTransitionFromNew) {
          console.log("[CEP] Claude conversation changed from", window.__cep.lastConvId, "to", convId, "- clearing file store.");
          window.__cep.files = {};
          window.__cep.idMap = {};
          window.__cep.urlMap = {};
          window.__cep.filePathMap = {};
        }
        window.__cep.lastConvId = convId;
      }

      if (convId && orgId) {
        console.log("[CEP] __cepQuery (Claude): Fetching conversation tree for:", convId, "orgId:", orgId);
        try {
          const headers = {
            'accept': 'application/json',
            ...window.__cep.claudeHeaders
          };
          if (window.__cep.authHeader) {
            headers['Authorization'] = window.__cep.authHeader;
          }
          const res = await _fetch(`/api/organizations/${orgId}/chat_conversations/${convId}?tree=true&rendering_mode=messages&render_all_tools=true`, {
            headers,
            credentials: 'include'
          });
          console.log("[CEP] __cepQuery (Claude): Conversation tree fetch status:", res.status);
          if (res.ok) {
            const data = await res.json();
            console.log("[CEP] __cepQuery (Claude): Full tree data:", data);
            if (data && data.chat_messages) {
              data.chat_messages.forEach((msg, idx) => {
                console.log(`[CEP] Claude Message ${idx}:`, JSON.stringify(msg));
              });
            }
            scanJsonForFiles(data);

            // Extract file paths from tree for wiggle/download-file endpoint (for blob files like ZIPs)
            if (data && data.chat_messages) {
              for (const msg of data.chat_messages) {
                const fileEntries = [...(msg.files || []), ...(msg.attachments || [])];
                for (const f of fileEntries) {
                  const fId = f.file_uuid || f.uuid || f.id;
                  const fPath = f.path;
                  if (fId && fPath && typeof fPath === 'string' && fPath.startsWith('/mnt/')) {
                    window.__cep.filePathMap[fId] = fPath;
                  }
                }
              }
            }
             
            console.log("[CEP] __cepQuery (Claude): Parsed tree. idMap:", JSON.stringify(window.__cep.idMap), "filePathMap:", JSON.stringify(window.__cep.filePathMap));
            
            // On-demand fetch file binaries in PARALLEL (all files concurrently) to stay within getStore timeout
            const _downloadEntries = Object.entries(window.__cep.idMap);
            console.log("[CEP] On-demand: Starting parallel download for", _downloadEntries.length, "files");
            await Promise.all(_downloadEntries.map(async ([fileId, filename]) => {
              const k = filename.toLowerCase().trim();
              const isClaudeFile = typeof fileId === 'string' && /^[a-f0-9-]{36}$/.test(fileId);
              if (!window.__cep.files[k] && isClaudeFile) {
                // Try the wiggle/download-file endpoint FIRST for blob files (ZIPs, etc.)
                // This is the endpoint Claude's own UI uses for file downloads
                const filePath = window.__cep.filePathMap[fileId];
                if (filePath && convId) {
                  try {
                    const wiggleUrl = `/api/organizations/${orgId}/conversations/${convId}/wiggle/download-file?path=${encodeURIComponent(filePath)}`;
                    console.log("[CEP] Trying wiggle download for:", filename, wiggleUrl);
                    const wiggleRes = await _fetch(wiggleUrl, { credentials: 'include' });
                    if (wiggleRes.ok) {
                      const buffer = await wiggleRes.arrayBuffer();
                      const ct = wiggleRes.headers.get('content-type') || 'application/octet-stream';
                      const dataUrl = await toDataUrl(buffer, ct);
                      save(filename, dataUrl, ct, wiggleUrl);
                      console.log("[CEP] ✅ Wiggle download succeeded for:", filename, "size:", buffer.byteLength);
                      return; // Done — skip other endpoints
                    } else {
                      console.log("[CEP] Wiggle download failed for:", filename, "status:", wiggleRes.status);
                    }
                  } catch(err) {
                    console.warn("[CEP] Wiggle download error for:", filename, err);
                  }
                }

                const endpoints = [
                  `/api/${orgId}/files/${fileId}/content`,
                  `/api/${orgId}/files/${fileId}/document_pdf`,
                  `/api/${orgId}/files/${fileId}/download`,
                  `/api/organizations/${orgId}/files/${fileId}/download`,
                  `/api/${orgId}/files/${fileId}/preview`,
                  `/api/${orgId}/files/${fileId}`,
                  `/api/organizations/${orgId}/files/${fileId}/content`,
                  `/api/organizations/${orgId}/files/${fileId}`
                ];
                console.log("[CEP] On-demand page-context fetching Claude file:", filename, "fileId:", fileId);
                try {
                  let fileRes = null;
                  let lastStatus = 0;
                  
                  for (const endpoint of endpoints) {
                    try {
                      const headers = {
                        'accept': 'application/json',
                        ...window.__cep.claudeHeaders
                      };
                      if (window.__cep.authHeader) {
                        headers['Authorization'] = window.__cep.authHeader;
                      }
                      const tempRes = await _fetch(endpoint, {
                        headers,
                        credentials: 'include'
                      });
                      lastStatus = tempRes.status;
                      if (tempRes.ok) {
                        const ct = (tempRes.headers.get('content-type') || '').toLowerCase();
                        if (ct.includes('json')) {
                          try {
                            const json = await tempRes.json();
                            console.log("[CEP] Claude file metadata JSON resolved for:", filename, json);
                            const downloadUrl = findDownloadUrl(json);
                            if (downloadUrl) {
                              window.__cep.downloadUrlMap[fileId] = downloadUrl;
                              let fileHeaders = {};
                              if (downloadUrl.startsWith('/') || downloadUrl.includes('claude.ai')) {
                                fileHeaders = { ...window.__cep.claudeHeaders };
                                if (window.__cep.authHeader) {
                                  fileHeaders['Authorization'] = window.__cep.authHeader;
                                }
                              }
                              const fRes = await _fetch(downloadUrl, {
                                headers: fileHeaders,
                                credentials: 'include'
                              });
                              if (fRes.ok) {
                                fileRes = fRes;
                                break;
                              }
                            }
                          } catch(err) {
                            console.warn("[CEP] Failed to parse/fetch JSON metadata for:", filename, err);
                          }
                        } else {
                          fileRes = tempRes;
                          break;
                        }
                      }
                    } catch(err) {
                      console.warn("[CEP] On-demand Claude download endpoint try failed for:", endpoint, err);
                    }
                  }

                  if (fileRes) {
                    console.log("[CEP] On-demand Claude content response for:", filename, fileRes.status);
                    const buffer = await fileRes.arrayBuffer();
                    const ct = fileRes.headers.get('content-type');
                    const dataUrl = await toDataUrl(buffer, ct);
                    save(filename, dataUrl, ct, fileRes.url);
                    console.log("[CEP] On-demand successfully saved Claude file:", filename);
                  } else {
                    // Fallback to extracted_content if download failed
                    const extContent = window.__cep.extractedContentMap[fileId];
                    if (extContent) {
                      const base64 = btoa(unescape(encodeURIComponent(extContent)));
                      const dataUrl = 'data:text/plain;charset=utf-8;base64,' + base64;
                      save(filename, dataUrl, 'text/plain', 'extracted-content');
                      console.log("[CEP] On-demand successfully saved Claude file from extracted_content:", filename);
                    } else {
                      console.log("[CEP] Note: On-demand file content could not be fetched directly (expected for non-PDF/non-image attachments from previous sessions). Filename:", filename, "Status:", lastStatus);
                    }
                  }
                } catch(e) {
                  console.warn("[CEP] Failed on-demand Claude fetch for file:", filename, e);
                }
              }
            }));
          }
        } catch(e) {
          console.warn("[CEP] On-demand Claude conversation fetch failed:", e);
        }
      } else {
        console.log("[CEP] __cepQuery (Claude): Path does not match conversation UUID or orgId is missing. path:", window.location.pathname, "orgId:", orgId);
      }
    }
    } catch(err) {
      console.error("[CEP] Error during __cepQuery handling:", err);
    } finally {
      console.log("[CEP] __cepQuery: Dispatching __cepReply. Store files size:", Object.keys(window.__cep.files).length);
      window.dispatchEvent(new CustomEvent('__cepReply', {
        detail: {
          files: window.__cep.files,
          orgId: window.__cep.orgId,
          authHeader: window.__cep.authHeader,
          idMap: window.__cep.idMap,
          downloadUrlMap: window.__cep.downloadUrlMap || {},
          interceptedDownloads: window.__cep.interceptedDownloads || []
        }
      }));
    }
  });
  window.addEventListener('__cepStore', e => {
    const {filename,dataUrl,mimeType,url} = e.detail||{};
    if (filename&&dataUrl) save(filename,dataUrl,mimeType,url);
  });
  window.addEventListener('__cepRegName', e => {
    const {fileId,filename} = e.detail||{};
    if (!fileId||!filename) return;
    window.__cep.idMap[fileId] = filename;
    // Re-key any blob stored under the file-id
    for (const [k,v] of Object.entries(window.__cep.files)) {
      if (k.includes(fileId.slice(0,8).toLowerCase())) save(filename,v.dataUrl,v.mimeType,v.url);
    }
  });

  // Claude Counter Message API (Claude Only)
  if (IS_CLAUDE) {
    function postResponse(requestId, ok, payload, error) {
      window.postMessage(
        {
          cc: CC_MARKER,
          type: 'cc:response',
          requestId,
          ok,
          payload,
          error
        },
        '*'
      );
    }

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.cc !== CC_MARKER) return;
      if (data.type !== 'cc:request') return;

      const { requestId, kind, payload } = data;
      try {
        if (kind === 'hash') {
          const text = typeof payload?.text === 'string' ? payload.text : '';
          if (!text || !crypto?.subtle?.digest) {
            postResponse(requestId, false, null, 'Hash unavailable');
            return;
          }
          const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
          const bytes = new Uint8Array(buffer);
          const hash = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
          postResponse(requestId, true, { hash }, null);
          return;
        }

        if (kind === 'usage') {
          const orgId = payload?.orgId;
          if (!orgId) throw new Error('Missing orgId');
          const res = await _fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
            method: 'GET',
            credentials: 'include'
          });
          const json = await res.json();
          postResponse(requestId, true, json, null);
          return;
        }

        if (kind === 'conversation') {
          const orgId = payload?.orgId;
          const conversationId = payload?.conversationId;
          if (!orgId || !conversationId) throw new Error('Missing orgId/conversationId');

          const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
          const res = await _fetch(url, {
            method: 'GET',
            credentials: 'include'
          });
          const json = await res.json();
          cc_post('cc:conversation', { orgId, conversationId, data: json });
          postResponse(requestId, true, json, null);
          return;
        }

        throw new Error(`Unknown request kind: ${kind}`);
      } catch (e) {
        postResponse(requestId, false, null, e?.message || String(e));
      }
    });
  }
})();
