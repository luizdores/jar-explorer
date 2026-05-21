// src/extension.js
const vscode = require("vscode");
const cp = require("child_process");
const { execFile } = cp;
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// #4 - Map keyed by node id prevents duplicate entries on re-open and grows only as needed
const absolutePathMap = new Map();
// Maps a temp-extracted nested JAR path -> { rootJarPath, nestedJarEntry }
// Populated when expandNestedJar runs so we always know the full parentage
const nestedJarMap = new Map();
const bytecodeModeMap = new Map(); // Tracks whether a specific tab is showing Java or Bytecode
const liveEditMap = new Map(); // Tracks editable temp files back to their parent JAR
const liveEditReverseMap = new Map(); // jarPath+entryPath -> tempFile path, for O(1) dedup

// --- CACHE ENGINE SETUP ---
const CACHE_DIR = path.join(os.tmpdir(), "vscode-jar-explorer-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Stat cache: avoids repeated synchronous fs.statSync calls for the same JAR during a search/decompile pass
const _statCache = new Map();
function _getCachedStat(jarPath) {
  if (_statCache.has(jarPath)) return _statCache.get(jarPath);
  const stat = fs.statSync(jarPath);
  if (stat.isDirectory()) throw new Error(`Path is a directory, not a JAR: ${jarPath}`);
  _statCache.set(jarPath, stat);
  setTimeout(() => _statCache.delete(jarPath), 5000);
  return stat;
}

function getCacheKey(jarPath, entryPath, mode = 'java') {
  const stat = _getCachedStat(jarPath);
  const mtime = stat.mtimeMs;

  return crypto
    .createHash("md5")
    .update(jarPath + "::" + mtime + "::" + entryPath + "::" + mode)
    .digest("hex") + ".txt";
}

// Track which cache keys belong to which JAR path for per-JAR cache clearing
// Held in memory and flushed to disk on deactivate — avoids 200 read-write cycles during search
const CACHE_INDEX_FILE = path.join(os.tmpdir(), "vscode-jar-explorer-cache-index.json");
let _cacheIndexMemory = null;

function loadCacheIndex() {
  if (_cacheIndexMemory) return _cacheIndexMemory;
  try { _cacheIndexMemory = JSON.parse(fs.readFileSync(CACHE_INDEX_FILE, 'utf8')); }
  catch (_) { _cacheIndexMemory = {}; }
  return _cacheIndexMemory;
}
function saveCacheIndex(index) {
  _cacheIndexMemory = index;
  // Persist to disk (called only on deactivate or explicit clear)
  try { fs.writeFileSync(CACHE_INDEX_FILE, JSON.stringify(index), 'utf8'); } catch (_) {}
}
function flushCacheIndex() {
  if (_cacheIndexMemory) {
    try { fs.writeFileSync(CACHE_INDEX_FILE, JSON.stringify(_cacheIndexMemory), 'utf8'); } catch (_) {}
  }
}
function recordCacheKey(jarPath, cacheKey) {
  const index = loadCacheIndex();
  if (!index[jarPath]) index[jarPath] = [];
  if (!index[jarPath].includes(cacheKey)) index[jarPath].push(cacheKey);
  // Don't write to disk here — flush happens on deactivate
}

async function runJarToolCached(jarPath, entryPath, context) {
  try {
    const s = fs.statSync(jarPath);
    if (s.isDirectory()) return `Error: Path is a directory: ${jarPath}`;
  } catch (e) {
    return `Error: File not found: ${jarPath}`;
  }
  const cacheKey = getCacheKey(jarPath, entryPath, 'java');
  const cachePath = path.join(CACHE_DIR, cacheKey);
  try {
    return fs.readFileSync(cachePath, "utf8");
  } catch (_) { /* cache miss — fall through to decompile */ }

  let result;

  try {
    result = await runJarTool(jarPath, entryPath, context);
  } catch (err) {
    return `Error: ${err.message}`;
  }
  if (!result.startsWith("Error:") && !result.startsWith("Invalid") && !result.startsWith("No class")) {
    fs.writeFileSync(cachePath, result, "utf8");
    recordCacheKey(jarPath, cacheKey);
  }
  return result;
}

// --- NEW BYTECODE ENGINE ---
function runJavap(jarPath, className) {
  return new Promise((resolve) => {
    const javapPath = getJdkTool('javap');
    const args = ["-c", "-p", "-constants", "-cp", jarPath, className];
    const cmd = cp.spawn(javapPath, args);

    let output = "";
    let error = "";

    cmd.stdout.on("data", (data) => (output += data.toString()));
    cmd.stderr.on("data", (data) => (error += data.toString()));

    cmd.on("close", (code) => {
      if (code === 0) resolve(output);
      else resolve(`// Error running javap (Bytecode extraction failed)\n// Ensure JDK is correctly configured.\n\n${error}`);
    });
  });
}

async function runJavapCached(jarPath, entryPath) {
    const cacheKey = getCacheKey(jarPath, entryPath, 'bytecode');
    const cachePath = path.join(CACHE_DIR, cacheKey);
    try {
      return fs.readFileSync(cachePath, "utf8");
    } catch (_) { /* cache miss */ }

    const className = entryPath.replace(/\.class$/, '').replace(/\//g, '.');
    const result = await runJavap(jarPath, className);
    
    if (!result.startsWith("// Error")) {
      fs.writeFileSync(cachePath, result, "utf8");
      recordCacheKey(jarPath, cacheKey);
    }
    return result;
}
// -------------------------

class ClassNode extends vscode.TreeItem {
  constructor(label, fullPath, collapsibleState, jarRoot, classPath, isRoot = false) {
    super(label, collapsibleState);
    this.fullPath = fullPath;
    this.children = [];
    this.classPath = classPath;
    this.isRoot = isRoot;
    this.jarRoot = jarRoot; 

    this.id = jarRoot + "::" + label + "::" + classPath;
    this.resourceUri = vscode.Uri.parse(`jarExplorer:${fullPath}`);
    // #10 - Tooltip shows full entry path and root JAR so truncated labels are always readable
    this.tooltip = new vscode.MarkdownString(`**${label}**\n\n\`${classPath}\`\n\n*in* \`${path.basename(jarRoot)}\``);
    if (isRoot) {
      this.contextValue = "jarRoot";
    } else if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
      this.contextValue = "classFile";
    } else {
      this.contextValue = "folder";
    }

    if (collapsibleState === vscode.TreeItemCollapsibleState.None && !isRoot) {
      this.command = { command: "jarExplorer.openClassFile", title: "Open Class File", arguments: [jarRoot, classPath, label] };
      // #5 - File type icons so the tree is scannable at a glance
      const ext = label.split('.').pop().toLowerCase();
      const iconMap = {
        class: 'symbol-class', java: 'symbol-class',
        xml: 'code', html: 'code', htm: 'code',
        json: 'json', yaml: 'symbol-field', yml: 'symbol-field',
        properties: 'settings', conf: 'settings', config: 'settings', cfg: 'settings',
        txt: 'book', md: 'markdown',
        png: 'file-media', jpg: 'file-media', jpeg: 'file-media', gif: 'file-media', svg: 'file-media',
        sql: 'database', sh: 'terminal', bat: 'terminal', cmd: 'terminal',
        mf: 'info', sf: 'lock', rsa: 'lock', dsa: 'lock',
      };
      if (iconMap[ext]) this.iconPath = new vscode.ThemeIcon(iconMap[ext]);
    }
  }
  getId() { return this.id; }
  setChildren(parts, newNode) {
    let currentChildren = this.children;
    for (let i = 0; i < currentChildren.length; i++) {
      if (currentChildren[i].label === parts[0]) {
        if (parts.length === 1) {
          currentChildren[i].children = [...newNode.children];
          currentChildren[i].collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
          // Preserve nestedArchive contextValue so getTreeItem can show the green icon
          if (currentChildren[i].contextValue !== "nestedArchive") {
            currentChildren[i].contextValue = "folder";
          }
          currentChildren[i].wasLoaded = true;
          currentChildren[i].command = undefined;
          return currentChildren[i]; // return the node so caller can reveal it
        } else {
          return currentChildren[i].setChildren(parts.slice(1), newNode);
        }
      }
    }
    return null;
  }
  getIsRoot() { return this.isRoot; }
}

function buildTreeFromPaths(jarPath, classPaths) {
  const jarLabel = path.basename(jarPath);

  const rootNode = new ClassNode(
    jarLabel,
    "/",
    vscode.TreeItemCollapsibleState.Expanded,
    jarPath,
    "/",
    true
  );

  for (const classPath of classPaths) {
    const parts = classPath.split("/");

    let current = rootNode;
    let currentPath = jarPath;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (part === "") continue;

      currentPath = path.join(currentPath, part);

      let existing = current.children.find((c) => c.label === part);

      if (!existing) {
        const isLast = i === parts.length - 1;

        const isNestedArchive = /\.(jar|war|ear|zip|rar)$/i.test(part);

        const collapsibleState = (!isLast || isNestedArchive)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;

        existing = new ClassNode(
          part,
          currentPath,
          collapsibleState,
          jarPath,
          classPath
        );

        // Make nested archives expandable
        if (isLast && isNestedArchive) {
          existing.contextValue = "nestedArchive";
          existing.iconPath = new vscode.ThemeIcon("package");
          existing.command = {
            command: "jarExplorer.expandNestedJar",
            title: "Open Nested Archive",
            arguments: [jarPath, classPath, existing.id]
          };
        }

        current.children.push(existing);
      }

      current = existing;
    }
  }

  return rootNode;
}

// #1 - Cache the java path; invalidated when the user changes the JDK setting
let _cachedJavaPath = null;

function _invalidateJavaPathCache(e) {
  if (!e || e.affectsConfiguration('jarExplorer.jdkPath')) _cachedJavaPath = null;
}

function getJavaExecutable() {
  if (_cachedJavaPath) return _cachedJavaPath;
  const configuredPath = vscode.workspace.getConfiguration("jarExplorer").get("jdkPath");
  let result;
  if (!configuredPath || configuredPath.trim() === "") {
    result = "java";
  } else if (os.platform() === "win32" && !configuredPath.toLowerCase().endsWith(".exe")) {
    result = configuredPath + ".exe";
  } else {
    result = configuredPath;
  }
  return (_cachedJavaPath = result);
}

// #8 - Resolve any JDK sibling tool (javap, jar…) next to the configured java executable
function getJdkTool(toolName) {
  const javaPath = getJavaExecutable();
  if (javaPath === "java") return toolName;
  const ext = os.platform() === 'win32' ? '.exe' : '';
  return path.join(path.dirname(javaPath), toolName + ext);
}

// #2 - Unified fetcher: pass { withMetadata: true } to get full entry objects (with size etc.)
// instead of plain name strings — eliminates the old duplicate getJarEntriesWithMetadata function
function getJarEntries(jarPath, context, options) {
  var withMetadata = options && options.withMetadata;
  return new Promise((resolve, reject) => {
    const jarTool = path.join(context.extensionPath, "resources", "JarExplorerService.jar");
    execFile(getJavaExecutable(), ["-jar", jarTool, "JarView", jarPath], { maxBuffer: 1024 * 1024 * 100 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const res = JSON.parse(stdout);
        const entries = Array.isArray(res) ? res : res.fileList;
        resolve(withMetadata ? entries : entries.map((e) => e.name));
      } catch (e) { reject(new Error("Invalid JSON from data utility.")); }
    });
  });
}

// Pure-Node ZIP central directory reader — extracts uncompressed sizes for all entries.
// JARs are ZIP files; the central directory at the end of the file contains full metadata
// including uncompressed size, even when the Java tool doesn't return it.
function readZipEntrySizes(zipPath) {
  const sizes = new Map(); // entry name -> uncompressed size in bytes
  try {
    const fd = fs.openSync(zipPath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    // Read the last 65KB to find the End of Central Directory record (EOCD)
    const scanSize = Math.min(65536, fileSize);
    const tail = Buffer.allocUnsafe(scanSize);
    fs.readSync(fd, tail, 0, scanSize, fileSize - scanSize);

    // EOCD signature: 0x06054b50
    let eocdOffset = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i+1] === 0x4b && tail[i+2] === 0x05 && tail[i+3] === 0x06) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) { fs.closeSync(fd); return sizes; }

    const cdSize   = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);

    // Read the entire central directory
    const cd = Buffer.allocUnsafe(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    fs.closeSync(fd);

    // Walk central directory file headers (signature 0x02014b50)
    let pos = 0;
    while (pos + 46 <= cd.length) {
      if (cd[pos] !== 0x50 || cd[pos+1] !== 0x4b || cd[pos+2] !== 0x01 || cd[pos+3] !== 0x02) break;
      const uncompressedSize = cd.readUInt32LE(pos + 24);
      const fileNameLen      = cd.readUInt16LE(pos + 28);
      const extraLen         = cd.readUInt16LE(pos + 30);
      const commentLen       = cd.readUInt16LE(pos + 32);
      const name             = cd.toString('utf8', pos + 46, pos + 46 + fileNameLen);
      sizes.set(name, uncompressedSize);
      pos += 46 + fileNameLen + extraLen + commentLen;
    }
  } catch (_) { /* not a valid ZIP or file unreadable — return empty map */ }
  return sizes;
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Escape user-controlled strings before injecting into webview HTML to prevent XSS
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// --------------------------------------------------------------------------------------

async function searchInsideEntries(baseJarPath, entries, searchRegex, context, token, progress, displayPrefix = "") {
  const results = []; const filesToScan = []; const archivesToRecurse = [];

  for (const entryPath of entries) {
    const lower = entryPath.toLowerCase();
    if (lower.match(/\.(class|properties|xml|json|yml|yaml|txt|mf|conf)$/)) filesToScan.push(entryPath);
    else if (lower.match(/\.(jar|war|ear|zip)$/)) archivesToRecurse.push(entryPath);
  }

  let completed = 0; const totalFiles = filesToScan.length;

  const SEARCH_RESULT_LIMIT = 500;

  async function worker() {
    while (filesToScan.length > 0 && !token.isCancellationRequested) {
      if (results.length >= SEARCH_RESULT_LIMIT) break;
      const entryPath = filesToScan.shift();
      try {
        const result = await runJarToolCached(baseJarPath, entryPath, context);
        if (!result.startsWith("Error:") && !result.startsWith("Invalid") && !result.startsWith("No class")) {
          const decoded = decodeBase64Url(result);
          if (searchRegex.test(decoded)) {
            const lines = decoded.split(/\r?\n/);
            lines.forEach((line, lineIdx) => {
              if (line.match(searchRegex)) {
                const trimmed = line.trim();
                const fullPath = displayPrefix ? `${displayPrefix}/${entryPath}` : entryPath;
                results.push({
                  label: `$(search) ${trimmed.substring(0, 120)}`,
                  description: `line ${lineIdx + 1}`,
                  detail: `$(file-code)  ${fullPath}`,
                  entryPath, className: path.basename(entryPath), jarRoot: baseJarPath,
                  nodeId: baseJarPath + "::" + path.basename(entryPath) + "::" + entryPath
                });
              }
            });
          }
        }
      } catch (err) {
        console.error(`[JAR Explorer] Failed to scan entry "${entryPath}":`, err.message);
      }
      completed++;
      if (totalFiles > 0 && completed % 5 === 0) progress.report({ message: `Scanning files in ${path.basename(baseJarPath)}... (${completed}/${totalFiles})` });
    }
  }

  await Promise.all(Array(Math.min(5, Math.max(1, filesToScan.length))).fill(null).map(() => worker()));

  // Search nested archives after flat file pass completes
  for (const nestedArchive of archivesToRecurse) {
    if (token.isCancellationRequested) break;
    if (results.length >= SEARCH_RESULT_LIMIT) break;
    try {
      progress.report({ message: `Extracting nested archive: ${path.basename(nestedArchive)}...` });
      const cmarArr = ["-jar", path.join(context.extensionPath, "resources", "JarExplorerService.jar"), "InnerJar", baseJarPath, nestedArchive];
      const stdout = await new Promise((resolve, reject) => {
        execFile(getJavaExecutable(), cmarArr, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
      });

      const res = JSON.parse(stdout);
      const absPath = res.absolutePath;
      const flatPaths = Array.isArray(res) ? res.map((e) => e.name) : (res.fileList ? res.fileList.map((e) => e.name) : []);

      if (absPath) absolutePathMap.set(`search-temp-${absPath}`, [absPath]);
      const { results: nestedResults } = await searchInsideEntries(absPath, flatPaths, searchRegex, context, token, progress, displayPrefix ? `${displayPrefix}/${nestedArchive}` : nestedArchive);
      results.push(...nestedResults);
    } catch (err) {
      console.error(`[JAR Explorer] Failed to search nested archive "${nestedArchive}":`, err.message);
    }
  }

  return { results, truncated: results.length >= SEARCH_RESULT_LIMIT };
}

class JarTreeDataProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    // Wrap fire() to also invalidate the parent map cache
    const _originalFire = this._onDidChangeTreeData.fire.bind(this._onDidChangeTreeData);
    this._onDidChangeTreeData.fire = (...args) => {
      this._parentMap = null;
      _originalFire(...args);
    };
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.tree = [];
    this.loadingNodes = new Set();
    this.treeView = null;
    this.sortAlpha = context.globalState.get('jarExplorer.sortAlpha', false);
    this._parentMap = null; // #5 - cached parent map, invalidated on tree change
  }

  // Drag-and-drop: accept dropped JAR/ZIP/WAR/EAR files onto the tree view
  get dropMimeTypes() { return ['text/uri-list']; }
  get dragMimeTypes() { return []; }
  handleDrop(target, dataTransfer) {
    const uriList = dataTransfer.get('text/uri-list');
    if (!uriList) return;
    uriList.asString().then(raw => {
      raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).forEach(uriStr => {
        const uri = vscode.Uri.parse(uriStr);
        if (/\.(jar|war|ear|zip|vsix)$/i.test(uri.fsPath)) {
          this.setJarFile(uri.fsPath);
        }
      });
    });
  }
  handleDrag() {}

  // Walk the tree to find a node by id
  _findNode(nodes, id) {
    for (const node of nodes) {
      if (node.getId() === id) return node;
      const found = this._findNode(node.children, id);
      if (found) return found;
    }
    return null;
  }

  setJarFile(jarPath, entryPath, loadingNodeId) {
    // Show a spinning icon on the clicked node while loading
    if (loadingNodeId) {
      this.loadingNodes.add(loadingNodeId);
      this._onDidChangeTreeData.fire();
    }

    // #3 - For root JARs (not nested), add a placeholder node immediately so the tree
    // shows feedback instead of staying blank during slow loads
    let placeholderNode = null;
    if (!entryPath && !loadingNodeId) {
      const alreadyInTree = this.tree.some(e => e.getId() === jarPath + "::" + path.basename(jarPath) + "::/");
      if (!alreadyInTree) {
        placeholderNode = new ClassNode(`${path.basename(jarPath)}`, "/", vscode.TreeItemCollapsibleState.None, jarPath, "/", true);
        placeholderNode.description = "Loading…";
        placeholderNode.iconPath = new vscode.ThemeIcon("loading~spin");
        placeholderNode.contextValue = "loading";
        this.tree = [...this.tree, placeholderNode];
        this._onDidChangeTreeData.fire();
      }
    }

    vscode.commands.executeCommand("workbench.view.extension.jarExplorerEnhanced");
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Loading ${path.basename(entryPath || jarPath)}...`, cancellable: false }, async () => {
        return new Promise((resolve) => {
            let cmarArr = entryPath ? ["-jar", path.join(this.context.extensionPath, "resources", "JarExplorerService.jar"), "InnerJar", jarPath, entryPath] : ["-jar", path.join(this.context.extensionPath, "resources", "JarExplorerService.jar"), "JarView", jarPath];
            execFile(getJavaExecutable(), cmarArr, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout) => {
              // Always clear the loading state first
              if (loadingNodeId) {
                this.loadingNodes.delete(loadingNodeId);
              }

              if (err) {
                vscode.window.showErrorMessage(`Failed to load archive: ${err.message}`);
                if (placeholderNode) {
                  const pi = this.tree.findIndex(n => n === placeholderNode);
                  if (pi !== -1) this.tree.splice(pi, 1);
                }
                this._onDidChangeTreeData.fire();
                return resolve();
              }
              try {
                const res = JSON.parse(stdout); 
                const flatPaths = Array.isArray(res) ? res.map((e) => e.name) : res.fileList.map((e) => e.name);
                const absPath = Array.isArray(res) ? null : res.absolutePath;
                let effectiveRoot = absPath || jarPath;
                let newNode = buildTreeFromPaths(effectiveRoot, flatPaths);
                let newInnerNode = null;
                
                if (absPath) {
                  newInnerNode = buildTreeFromPaths(absPath, flatPaths);
                  const mapEntry = absolutePathMap.get(newNode.getId());
                  if (mapEntry) mapEntry.push(absPath);
                  else absolutePathMap.set(newNode.getId(), [absPath]);
                  // Record the parentage so live-edit can do the two-level repack
                  if (entryPath) nestedJarMap.set(absPath, { rootJarPath: jarPath, nestedJarEntry: entryPath });
                }
                
                // FIX: Remove placeholder BEFORE checking if the JAR is already in the tree
                if (placeholderNode) {
                  const pi = this.tree.findIndex(n => n === placeholderNode);
                  if (pi !== -1) this.tree.splice(pi, 1);
                }

                let arr = this.tree.filter((e) => e.getId() === jarPath + "::" + path.basename(jarPath) + "::/");
                if (newInnerNode && arr.length > 0) {
                  const loadedNode = arr[0].setChildren(entryPath.split("/"), newInnerNode);
                  this._onDidChangeTreeData.fire();

                  // Auto-reveal and expand the loaded node — use the direct reference from setChildren
                  if (this.treeView && loadedNode) {
                    setTimeout(() => {
                      this.treeView.reveal(loadedNode, { expand: true, focus: false, select: false });
                    }, 100);
                  }
                  return resolve();
                }
                if (arr.length > 0) return resolve();
                
                this.tree = [...this.tree, newNode];
                // Persist recent archives list (for "Reopen Recent") with timestamps
                const recent = this.context.globalState.get('jarExplorer.recentArchives', []);
                const existingEntry = recent.find(e => (typeof e === 'string' ? e : e.path) === jarPath);
                const updatedEntry = { path: jarPath, openedAt: Date.now() };
                const updated = [updatedEntry, ...recent.filter(e => (typeof e === 'string' ? e : e.path) !== jarPath)].slice(0, 10);
                this.context.globalState.update('jarExplorer.recentArchives', updated);
                // #2 - Persist current session so JARs reopen on VS Code restart
                this.context.globalState.update('jarExplorer.sessionJars', this.tree.map(n => n.jarRoot).filter(Boolean));
                this._onDidChangeTreeData.fire();
                // #9 - Update the badge count in the tree view title
                if (this.treeView) {
                  this.treeView.badge = this.tree.length > 0
                    ? { value: this.tree.length, tooltip: `${this.tree.length} archive${this.tree.length !== 1 ? 's' : ''} loaded` }
                    : undefined;
                }
                resolve();
              } catch (e) { 
                this._onDidChangeTreeData.fire();
                resolve(); 
              }
            });
        });
    });
  }

  // Build a child->parent lookup so getParent() can navigate up the tree
  // This is required by VS Code for treeView.reveal() to work
  _buildParentMap(nodes, parent, map) {
    for (const node of nodes) {
      map.set(node.getId(), parent);
      this._buildParentMap(node.children, node, map);
    }
  }

  getParent(item) {
    // #5 - Rebuild only when invalidated (tree changed), not on every call
    if (!this._parentMap) {
      this._parentMap = new Map();
      this._buildParentMap(this.tree, null, this._parentMap);
    }
    return this._parentMap.get(item.getId()) || null;
  }

  getTreeItem(item) {
    // Show a spinner on nodes that are currently being extracted
    if (this.loadingNodes.has(item.getId())) {
      const loadingItem = Object.assign(Object.create(Object.getPrototypeOf(item)), item);
      loadingItem.iconPath = new vscode.ThemeIcon("loading~spin");
      loadingItem.description = "Loading…";
      return loadingItem;
    }
    // Show a green check on nested archives that have been loaded
    if (item.contextValue === "nestedArchive" && item.wasLoaded) {
      const doneItem = Object.assign(Object.create(Object.getPrototypeOf(item)), item);
      doneItem.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
      doneItem.description = "";
      return doneItem;
    }
    return item;
  }
  getChildren(element) {
    const children = element ? element.children : this.tree;
    if (!this.sortAlpha) return children;
    return [...children].sort((a, b) => {
      // Folders before files, then alphabetically within each group
      const aIsFolder = a.children && a.children.length > 0 || a.collapsibleState !== vscode.TreeItemCollapsibleState.None;
      const bIsFolder = b.children && b.children.length > 0 || b.collapsibleState !== vscode.TreeItemCollapsibleState.None;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return String(a.label).localeCompare(String(b.label), undefined, { sensitivity: 'base' });
    });
  }
}

function runJarTool(jarPath, entryPath, context) {
  return new Promise((resolve, reject) => {
    const cmd = cp.spawn(getJavaExecutable(), ["-jar", path.join(context.extensionPath, "resources", "JarExplorerService.jar"), "classDecompile", jarPath, getJavaExecutable(), entryPath, path.join(context.extensionPath, "resources", "cfr-0.152.jar")]);
    let output = ""; let error = "";
    cmd.stdout.on("data", (data) => (output += data.toString().replace(/[\r\n]+/g, "")));
    cmd.stderr.on("data", (data) => (error += data.toString()));
    cmd.on("close", (code) => { if (code === 0) resolve(output); else reject(new Error(error || `Tool failed with exit code ${code}`)); });
  });
}

function decodeBase64Url(base64Url) {
  let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64").toString("utf8");
}
function decodeBase64UrlToBase64(base64Url) {
  let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return base64;
}

const providerEventEmitter = new vscode.EventEmitter();

// --- SEARCH RESULTS WEBVIEW BUILDERS ---

function buildSearchLoadingHtml(searchTerm, archiveName) {
  return `<!DOCTYPE html><html lang="en"><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
      body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
             color: var(--vscode-foreground); background: var(--vscode-editor-background);
             display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .spinner { width: 24px; height: 24px; border: 3px solid var(--vscode-focusBorder);
                 border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 12px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .msg { opacity: 0.8; }
    </style>
  </head><body>
    <div class="spinner"></div>
    <div class="msg">Searching for <strong>${escapeHtml(searchTerm)}</strong> in <strong>${escapeHtml(archiveName)}</strong>…</div>
  </body></html>`;
}

// Returns just the re-renderable inner payload (summary + results list) so re-searches
// can update the DOM in-place without resetting the webview (and losing scroll position).
function buildSearchResultsBodyHtml(searchTerm, jarRoot, results, searchRegex, opts = {}) {
  const truncated = opts.truncated || false;
  const byFile = new Map();
  results.forEach(r => {
    const key = r.detail.replace(/^\$\(file-code\)\s+/, '');
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(r);
  });
  const totalFiles = byFile.size;
  const totalMatches = results.length;

  let filesHtml = '';
  byFile.forEach((matches, filePath) => {
    const matchesHtml = matches.map(m => {
      const raw = m.label.replace(/^\$\(search\) /, '');
      const highlighted = raw.replace(searchRegex, match => `<mark>${escapeHtml(match)}</mark>`);
      const payload = escapeHtml(JSON.stringify({ jarRoot: m.jarRoot, entryPath: m.entryPath, className: m.className, nodeId: m.nodeId }));
      return `<div class="match" tabindex="0" data-payload="${payload}" onclick="openFile(this)" onkeydown="handleKey(event, this)">
        <span class="line-num">${escapeHtml(m.description)}</span>
        <span class="line-content">${highlighted}</span>
      </div>`;
    }).join('');
    filesHtml += `
      <div class="file-group" data-file="${escapeHtml(filePath.toLowerCase())}">
        <div class="file-header" onclick="toggle(this)">
          <span class="chevron">▾</span>
          <span class="file-name">${escapeHtml(path.basename(filePath))}</span>
          <span class="file-path">${escapeHtml(path.dirname(filePath))}</span>
          <span class="match-count">${matches.length}</span>
        </div>
        <div class="match-list">${matchesHtml}</div>
      </div>`;
  });

  // Return a plain object — caller sends it directly via postMessage (no JSON.stringify needed)
  return {
    term: searchTerm,
    summary: `<b>${totalMatches}</b> result${totalMatches !== 1 ? 's' : ''} in <b>${totalFiles}</b> file${totalFiles !== 1 ? 's' : ''}`
      + (truncated ? ` <span style="color:var(--vscode-inputValidation-warningForeground,#cca700);margin-left:8px;">⚠ Showing first 500 results — refine your search to see more</span>` : '')
      + `<span class="hidden-count" id="hiddenCount"></span>`, // <-- ADD THIS LINE
    filesHtml: totalMatches === 0
      ? `<div class="empty"><div>🔍</div><div>No results found for "<strong>${escapeHtml(searchTerm)}</strong>"</div></div>`
      : filesHtml
  };
}

function buildSearchResultsHtml(searchTerm, archiveName, jarRoot, results, searchRegex, opts = {}) {
  const caseSensitive = opts.caseSensitive || false;
  const useRegex = opts.useRegex || false;
  const truncated = opts.truncated || false;
  // Group results by file path
  const byFile = new Map();
  results.forEach(r => {
    const key = r.detail.replace(/^\$\(file-code\)\s+/, '');
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(r);
  });

  const totalFiles = byFile.size;
  const totalMatches = results.length;

  // Build per-file HTML — each file gets a data-file attribute for filter matching
  let filesHtml = '';
  byFile.forEach((matches, filePath) => {
    const matchesHtml = matches.map(m => {
      const raw = m.label.replace(/^\$\(search\) /, '');
      const highlighted = raw.replace(searchRegex, match => `<mark>${escapeHtml(match)}</mark>`);
      const payload = escapeHtml(JSON.stringify({ jarRoot: m.jarRoot, entryPath: m.entryPath, className: m.className, nodeId: m.nodeId }));
      return `<div class="match" tabindex="0" data-payload="${payload}" onclick="openFile(this)" onkeydown="handleKey(event, this)">
        <span class="line-num">${escapeHtml(m.description)}</span>
        <span class="line-content">${highlighted}</span>
      </div>`;
    }).join('');

    filesHtml += `
      <div class="file-group" data-file="${escapeHtml(filePath.toLowerCase())}">
        <div class="file-header" onclick="toggle(this)">
          <span class="chevron">▾</span>
          <span class="file-name">${escapeHtml(path.basename(filePath))}</span>
          <span class="file-path">${escapeHtml(path.dirname(filePath))}</span>
          <span class="match-count">${matches.length}</span>
        </div>
        <div class="match-list">${matchesHtml}</div>
      </div>`;
  });

  return `<!DOCTYPE html><html lang="en"><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: var(--vscode-font-family); font-size: 13px;
             color: var(--vscode-foreground); background: var(--vscode-editor-background);
             margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

      /* ── Toolbar ── */
      .toolbar { flex-shrink: 0; background: var(--vscode-sideBar-background);
                 border-bottom: 1px solid var(--vscode-panel-border);
                 padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
      .toolbar-row { display: flex; align-items: center; gap: 8px; }

      /* Search-again input (#1) */
      .search-input { flex: 1; background: var(--vscode-input-background);
                      color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
                      border-radius: 3px; padding: 4px 8px; font-family: inherit; font-size: 13px; outline: none; }
      .search-input:focus { border-color: var(--vscode-focusBorder); }
      .search-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                    border: none; border-radius: 3px; padding: 4px 12px; cursor: pointer; font-size: 12px; white-space: nowrap; }
      .search-btn:hover { background: var(--vscode-button-hoverBackground); }

      /* Filter box (#7) */
      .filter-input { flex: 1; background: var(--vscode-input-background);
                      color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
                      border-radius: 3px; padding: 3px 8px; font-family: inherit; font-size: 12px; outline: none; }
      .filter-input:focus { border-color: var(--vscode-focusBorder); }
      .filter-label { font-size: 11px; opacity: 0.6; white-space: nowrap; }

      /* Collapse/expand all buttons (#2) */
      .icon-btn { background: none; border: none; color: var(--vscode-foreground); opacity: 0.7;
                  cursor: pointer; padding: 3px 6px; border-radius: 3px; font-size: 12px; }
      .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }

      /* Search option toggles */
      .opt-btn { display: flex; align-items: center; gap: 4px; background: none;
                 border: 1px solid transparent; border-radius: 3px; padding: 2px 7px;
                 cursor: pointer; font-family: inherit; font-size: 11px;
                 color: var(--vscode-foreground); opacity: 0.7; white-space: nowrap; }
      .opt-btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
      .opt-btn.active { background: var(--vscode-inputOption-activeBackground, var(--vscode-focusBorder));
                        border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
                        color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
                        opacity: 1; }
      .regex-error { color: var(--vscode-inputValidation-errorForeground, #f48771);
                     font-size: 11px; padding: 2px 4px; display: none; }

      /* Summary */
      .summary { font-size: 11px; opacity: 0.65; padding: 4px 12px 2px;
                 flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border); }
      .summary b { opacity: 1; }
      .hidden-count { margin-left: 8px; color: var(--vscode-descriptionForeground); }

      /* Scrollable results */
      .results { flex: 1; overflow-y: auto; }

      /* File group */
      .file-group { border-bottom: 1px solid var(--vscode-panel-border); }
      .file-group.filtered-out { display: none; }
      .file-header { display: flex; align-items: center; gap: 6px; padding: 5px 12px;
                     cursor: pointer; user-select: none;
                     background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background)); }
      .file-header:hover { background: var(--vscode-list-hoverBackground); }
      .chevron { font-size: 11px; width: 12px; transition: transform 0.15s; opacity: 0.6; flex-shrink: 0; }
      .file-header.collapsed .chevron { transform: rotate(-90deg); }
      .file-name { font-weight: 600; white-space: nowrap; }
      .file-path { opacity: 0.5; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .match-count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
                     border-radius: 10px; padding: 1px 7px; font-size: 11px; white-space: nowrap; flex-shrink: 0; }

      /* Match rows */
      .match-list.hidden { display: none; }
      .match { display: flex; align-items: baseline; gap: 12px; padding: 3px 12px 3px 32px; cursor: pointer; }
      .match:hover { background: var(--vscode-list-hoverBackground); }
      .match:active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
      .line-num { font-size: 11px; opacity: 0.5; min-width: 40px; text-align: right; white-space: nowrap; flex-shrink: 0; }
      .line-content { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
      mark { background: var(--vscode-editor-findMatchHighlightBackground, #ffcc0066); color: inherit; border-radius: 2px; padding: 0 1px; }
      .match:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-focusBackground); }

      /* Empty state */
      .empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
               height: 200px; opacity: 0.6; gap: 8px; }
      .spinner-inline { width: 20px; height: 20px; border: 3px solid var(--vscode-focusBorder);
                        border-top-color: transparent; border-radius: 50%;
                        animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head><body>

    <div class="toolbar">
      <!-- Search row with option toggles -->
      <div class="toolbar-row">
        <input class="search-input" id="searchInput" type="text" value="${escapeHtml(searchTerm)}"
               placeholder="Search again…" onkeydown="if(event.key==='Enter') doSearch()" />
        <button id="btnCase" class="opt-btn ${caseSensitive ? 'active' : ''}" title="Case sensitive" onclick="toggleOpt('case')">Aa</button>
        <button id="btnRegex" class="opt-btn ${useRegex ? 'active' : ''}" title="Use regular expression" onclick="toggleOpt('regex')">.*</button>
        <button class="search-btn" onclick="doSearch()">Search</button>
      </div>
      <div class="toolbar-row">
        <span id="regexError" class="regex-error"></span>
      </div>
      <!-- Filter + Collapse/Expand all row -->
      <div class="toolbar-row">
        <span class="filter-label">Filter:</span>
        <input class="filter-input" id="filterInput" type="text" placeholder="Filter by filename or path…"
               oninput="doFilter(this.value)" />
        <button class="icon-btn" title="Expand all" onclick="setAllCollapsed(false)">⊞ All</button>
        <button class="icon-btn" title="Collapse all" onclick="setAllCollapsed(true)">⊟ All</button>
      </div>
    </div>

    <div class="summary" id="summary">
      <b>${totalMatches}</b> result${totalMatches !== 1 ? 's' : ''} in <b>${totalFiles}</b> file${totalFiles !== 1 ? 's' : ''}
      ${truncated ? `<span style="color:var(--vscode-inputValidation-warningForeground,#cca700);margin-left:8px;">⚠ Showing first 500 results — refine your search to see more</span>` : ''}
      <span class="hidden-count" id="hiddenCount"></span>
    </div>

    <div class="results" id="results">
      ${totalMatches === 0
        ? `<div class="empty"><div>🔍</div><div>No results found for "<strong>${escapeHtml(searchTerm)}</strong>"</div></div>`
        : filesHtml
      }
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const archiveName = ${JSON.stringify(archiveName)};
      const jarRoot = ${JSON.stringify(jarRoot)};

      // Option toggle state — initialised from server-side render
      let caseSensitive = ${caseSensitive ? 'true' : 'false'};
      let useRegex = ${useRegex ? 'true' : 'false'};

      function toggleOpt(opt) {
        if (opt === 'case')  { caseSensitive = !caseSensitive; document.getElementById('btnCase').classList.toggle('active', caseSensitive); }
        if (opt === 'regex') { useRegex = !useRegex;           document.getElementById('btnRegex').classList.toggle('active', useRegex); }
      }

      // Send search to extension with current option flags
      function doSearch() {
        const term = document.getElementById('searchInput').value.trim();
        if (!term) return;
        document.getElementById('regexError').style.display = 'none';
        vscode.postMessage({ command: 'search', term, caseSensitive, useRegex, archiveName, jarRoot });
      }

      // Receive messages from extension (e.g. regex error feedback, in-place results update)
      window.addEventListener('message', e => {
        if (e.data.command === 'regexError') {
          const el = document.getElementById('regexError');
          el.textContent = 'Invalid regex: ' + e.data.message;
          el.style.display = 'block';
        }
        if (e.data.command === 'setLoading') {
          document.getElementById('results').innerHTML =
            '<div class="empty"><div class="spinner-inline"></div><div>Searching for <strong>' + escapeInner(e.data.term) + '</strong>…</div></div>';
          document.getElementById('summary').innerHTML = 'Searching…';
        }
        if (e.data.command === 'updateResults') {
          const payload = e.data.payload;
          if (!payload) return;
          document.getElementById('searchInput').value = payload.term;
          document.getElementById('summary').innerHTML = payload.summary;
          document.getElementById('hiddenCount').textContent = '';
          document.getElementById('filterInput').value = '';
          document.getElementById('results').innerHTML = payload.filesHtml;
        }
      });

      function escapeInner(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }

      // Open a file and let the extension reveal it in the tree
      function openFile(el) {
        const payload = JSON.parse(el.getAttribute('data-payload'));
        vscode.postMessage({ command: 'open', ...payload });
      }

      // Toggle a single file group
      function toggle(header) {
        header.classList.toggle('collapsed');
        header.nextElementSibling.classList.toggle('hidden');
      }

      // #2 — Collapse or expand all visible file groups
      function setAllCollapsed(collapse) {
        document.querySelectorAll('.file-group:not(.filtered-out) .file-header').forEach(h => {
          const list = h.nextElementSibling;
          if (collapse) { h.classList.add('collapsed'); list.classList.add('hidden'); }
          else { h.classList.remove('collapsed'); list.classList.remove('hidden'); }
        });
      }

      // #7 — Filter results by filename/path substring
      function doFilter(term) {
        const q = term.toLowerCase();
        let hidden = 0;
        document.querySelectorAll('.file-group').forEach(g => {
          const filePath = g.getAttribute('data-file') || '';
          const match = !q || filePath.includes(q);
          g.classList.toggle('filtered-out', !match);
          if (!match) hidden++;
        });
        const span = document.getElementById('hiddenCount');
        span.textContent = hidden > 0 ? '(' + hidden + ' file' + (hidden !== 1 ? 's' : '') + ' hidden by filter)' : '';
      }

      // #7 — Keyboard navigation: arrow keys move between results, Enter opens
      function handleKey(e, el) {
        if (e.key === 'Enter') { openFile(el); return; }
        const all = Array.from(document.querySelectorAll('.match:not(.filtered-out)'));
        const idx = all.indexOf(el);
        if (e.key === 'ArrowDown' && idx < all.length - 1) { e.preventDefault(); all[idx + 1].focus(); }
        if (e.key === 'ArrowUp'   && idx > 0)              { e.preventDefault(); all[idx - 1].focus(); }
      }

      // Focus the search input on load for quick re-search
      document.getElementById('searchInput').select();
    </script>
  </body></html>`;
}

function validateJavaOnStartup() {
  const javaExe = getJavaExecutable();
  cp.execFile(javaExe, ['-version'], (err) => {
    if (err) {
      vscode.window.showErrorMessage(
        `JAR Explorer: Java not found at "${javaExe}". Decompilation and archive browsing will not work.`,
        'Configure JDK Path'
      ).then(selection => {
        if (selection === 'Configure JDK Path') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'jarExplorer.jdkPath');
        }
      });
    }
  });
}

function activate(context) {
  // Sweep leftover temp edit dirs from any previous session that didn't deactivate cleanly
  const editBase = path.join(os.tmpdir(), "jar-explorer-edit");
  deleteTempDirectory(editBase);

  // Validate Java is accessible; show an actionable error if not
  validateJavaOnStartup();

  // #1 - Invalidate cached java path when the user changes the JDK setting
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(_invalidateJavaPathCache));

  // #3 - Clean up liveEditMap entries when a tracked temp document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const entry = liveEditMap.get(doc.uri.fsPath);
      if (entry) liveEditReverseMap.delete(entry.jarPath + '::' + entry.entryPath);
      liveEditMap.delete(doc.uri.fsPath);
    })
  );

  const treeProvider = new JarTreeDataProvider(context);

  // #12 - Status bar item showing current cache size
  const cacheStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  cacheStatusBar.command = "jarExplorer.clearCache";
  cacheStatusBar.tooltip = "JAR Explorer cache — click to clear";
  function updateCacheStatusBar() {
    try {
      if (!fs.existsSync(CACHE_DIR)) { cacheStatusBar.hide(); return; }
      const files = fs.readdirSync(CACHE_DIR);
      if (files.length === 0) { cacheStatusBar.hide(); return; }
      const totalBytes = files.reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(CACHE_DIR, f)).size; } catch (_) { return sum; }
      }, 0);
      cacheStatusBar.text = `$(database) JAR Cache: ${formatBytes(totalBytes)}`;
      cacheStatusBar.show();
    } catch (_) { cacheStatusBar.hide(); }
  }
  // #12 - Delay the first update so it doesn't flash "0 Bytes" on startup
  setTimeout(updateCacheStatusBar, 2000);
  const cacheStatusInterval = setInterval(updateCacheStatusBar, 30000);
  context.subscriptions.push(cacheStatusBar);
  context.subscriptions.push({ dispose: () => clearInterval(cacheStatusInterval) });
  const treeView = vscode.window.createTreeView("jarExplorerView", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: treeProvider
  });
  treeProvider.treeView = treeView;
  context.subscriptions.push(treeView);

  // Nested archive expansion — single click triggers load, shows spinner, auto-expands when ready
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "jarExplorer.expandNestedJar",
      async (jarPath, entryPath, nodeId) => {
        treeProvider.setJarFile(jarPath, entryPath, nodeId);
      }
    )
  );

  // CHANGED: Smart Provider that pulls Data on-demand to prevent URI length limits
  const provider = new (class { 
    constructor() {
      this.onDidChange = providerEventEmitter.event;
    }
    async provideTextDocumentContent(uri) { 
      try {
        const params = JSON.parse(decodeURIComponent(uri.query));
        const mode = bytecodeModeMap.get(uri.toString()) || 'java';

        // Guard: if the JAR path no longer exists or is a directory (stale session restore), bail gracefully
        try {
          const s = fs.statSync(params.jarPath);
          if (s.isDirectory()) return `// This file was from a previous session and is no longer available.\n// Please reopen the archive.`;
        } catch (_) {
          return `// Archive no longer found at: ${params.jarPath}\n// Please reopen the archive.`;
        }

        if (params.isClass && mode === 'bytecode') {
          // Show loading placeholder while javap runs
          const cacheKey = getCacheKey(params.jarPath, params.entryPath, 'bytecode');
          try { fs.accessSync(path.join(CACHE_DIR, cacheKey)); }
          catch (_) { return `// ⏳ Extracting bytecode for ${path.basename(params.entryPath)}...\n// This tab will refresh automatically when done.`; }
          return await runJavapCached(params.jarPath, params.entryPath);
        } else {
          // Show loading placeholder while CFR decompiles
          const cacheKey = getCacheKey(params.jarPath, params.entryPath, 'java');
          try { fs.accessSync(path.join(CACHE_DIR, cacheKey)); }
          catch (_) { return `// ⏳ Decompiling ${path.basename(params.entryPath)}...\n// This tab will refresh automatically when done.`; }
          const result = await runJarToolCached(params.jarPath, params.entryPath, context);
          if (result.startsWith("Error:") || result.startsWith("Invalid") || result.startsWith("No class")) {
            return `// Error rendering file:\n${result}`;
          }
          return decodeBase64Url(result);
        }
      } catch (err) { return `// Extension Error:\n${err.message}`; }
    } 
  })();
  
  vscode.workspace.registerTextDocumentContentProvider("virtual", provider);

  // #2 - Restore JARs after a short delay so VS Code finishes restoring its own tabs first,
  // preventing race conditions between tab restoration and our session load
  setTimeout(() => {
    const sessionJars = context.globalState.get('jarExplorer.sessionJars', []);
    for (const jarPath of sessionJars) {
      if (fs.existsSync(jarPath)) {
        try {
          const s = fs.statSync(jarPath);
          if (!s.isDirectory()) treeProvider.setJarFile(jarPath);
        } catch (_) {}
      }
    }
    // Restore badge count now that tree is populated
    if (treeProvider.treeView && treeProvider.tree.length > 0) {
      treeProvider.treeView.badge = {
        value: treeProvider.tree.length,
        tooltip: `${treeProvider.tree.length} archive${treeProvider.tree.length !== 1 ? 's' : ''} loaded`
      };
    }
  }, 500);
  vscode.window.registerCustomEditorProvider(
    "jarExplorer.editor",
    {
      async openCustomDocument(uri) { return { uri, dispose: () => {} }; },
      async resolveCustomEditor(document, webviewPanel) {
        treeProvider.setJarFile(document.uri.fsPath);
        webviewPanel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body { font-family: var(--vscode-font-family); display: flex; justify-content: center; align-items: center; height: 100vh; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); } .container { text-align: center; } .icon { font-size: 48px; margin-bottom: 20px; }</style></head><body><div class="container"><div class="icon">☕</div><h2>JAR Explorer Enhanced</h2><p><b>${escapeHtml(path.basename(document.uri.fsPath))}</b> has been loaded into the JAR Explorer Enhanced sidebar.</p></div></body></html>`;
        // Close tab on the first tree data change (archive is loaded) or after 8s max
        const disposable = treeProvider.onDidChangeTreeData(() => {
          disposable.dispose();
          try { if (!webviewPanel.disposed) webviewPanel.dispose(); } catch (_) {}
        });
        setTimeout(() => {
          disposable.dispose();
          try { if (!webviewPanel.disposed) webviewPanel.dispose(); } catch (_) {}
        }, 8000);
      },
    }, { supportsMultipleEditorsPerDocument: false }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jarExplorer.openClassFile", async (jarPath, entryPath, className) => {
      // Prevent attempts to open the root directory as a file
      if (!entryPath || entryPath === "/") return;
      
      // 1. Handle Images (Extracted to temp folder, opened natively)
      if (className.match(/\.(png|jpg|jpeg|gif|svg)$/i)) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening Image...` }, async () => {
          const result = await runJarToolCached(jarPath, entryPath, context);
          const buffer = Buffer.from(decodeBase64UrlToBase64(result), "base64");
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jar-img-"));
          const tempFile = path.join(tempDir, className);
          fs.writeFileSync(tempFile, buffer);
          await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(tempFile));
          // #5 - Clean up temp image dir when the extension deactivates
          context.subscriptions.push({ dispose: () => deleteTempDirectory(tempDir) });
        });
      } 
      // 2. Handle Java Classes (Read-Only Virtual Document)
      else if (className.endsWith(".class")) {
        const virtualFileName = className.replace(/\.class$/, ".java");
        const queryObj = { jarPath, entryPath, isClass: true };
        const uri = vscode.Uri.parse(`virtual:/${virtualFileName}?${encodeURIComponent(JSON.stringify(queryObj))}`);

        // Open the tab immediately — provideTextDocumentContent will show a loading message
        // then we trigger a refresh once the decompile result is cached
        const previewMode = vscode.workspace.getConfiguration("jarExplorer").get("openInPreview", true);
        const doc = await vscode.workspace.openTextDocument(uri);
        vscode.languages.setTextDocumentLanguage(doc, "java");
        await vscode.window.showTextDocument(doc, { preview: previewMode });

        // If not cached yet, decompile in background and refresh when done
        const cacheKey = getCacheKey(jarPath, entryPath, 'java');
        const cachePath = path.join(CACHE_DIR, cacheKey);
        let alreadyCached = false;
        try { fs.accessSync(cachePath); alreadyCached = true; } catch (_) {}
        if (!alreadyCached) {
          runJarToolCached(jarPath, entryPath, context).then(() => {
            providerEventEmitter.fire(uri);
          }).catch(() => {
            providerEventEmitter.fire(uri);
          });
        }
      } 
      // 3. Handle Editable Text/Resource Files (Extracted to physical disk for editing)
      else {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${className}...` }, async () => {
          // Reuse existing temp file if this entry is already open, avoiding orphaned copies
          const reverseKey = jarPath + '::' + entryPath;
          const existingEntry = liveEditReverseMap.get(reverseKey) || null;
          const previewMode = vscode.workspace.getConfiguration("jarExplorer").get("openInPreview", true);
          if (existingEntry && fs.existsSync(existingEntry)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(existingEntry));
            await vscode.window.showTextDocument(doc, { preview: previewMode });
            return;
          }

          const result = await runJarToolCached(jarPath, entryPath, context);
          const buffer = Buffer.from(decodeBase64Url(result), "utf8");
          
          // Create a unique temp directory for this specific edit session
          const editDir = path.join(os.tmpdir(), "jar-explorer-edit", crypto.randomBytes(8).toString('hex'));
          fs.mkdirSync(editDir, { recursive: true });
          const tempFile = path.join(editDir, entryPath);
          fs.mkdirSync(path.dirname(tempFile), { recursive: true });
          
          fs.writeFileSync(tempFile, buffer);
          
          // Look up root JAR info directly from nestedJarMap, populated when the nested archive was expanded
          var rootJarPath = null;
          var nestedJarEntry = null;
          var nestedInfo = nestedJarMap.get(jarPath);
          if (nestedInfo) {
            rootJarPath = nestedInfo.rootJarPath;
            nestedJarEntry = nestedInfo.nestedJarEntry;
          }
          
          // FIX: Normalize the path using vscode.Uri to ensure drive letters match on Windows
          const normalizedTempFile = vscode.Uri.file(tempFile).fsPath;
          
          liveEditMap.set(normalizedTempFile, { jarPath, entryPath, rootJarPath, nestedJarEntry });
          liveEditReverseMap.set(jarPath + '::' + entryPath, normalizedTempFile);

          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tempFile));
          await vscode.window.showTextDocument(doc, { preview: previewMode });
        });
      }
    })
  );
  
  // NEW FEATURE: Toggle Bytecode
  context.subscriptions.push(
    vscode.commands.registerCommand("jarExplorer.toggleBytecode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "virtual") return;

      const uri = editor.document.uri;
      const uriStr = uri.toString();
      
      const currentMode = bytecodeModeMap.get(uriStr) || 'java';
      const newMode = currentMode === 'java' ? 'bytecode' : 'java';
      bytecodeModeMap.set(uriStr, newMode);

      // Force VS Code to reload the document content from the provider
      providerEventEmitter.fire(uri);
      vscode.window.showInformationMessage(`Switched to ${newMode === 'bytecode' ? 'JVM Bytecode' : 'Decompiled Source'}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jarExplorer.exportFile", async (node) => {
      if (!node || node.contextValue !== "classFile") return vscode.window.showInformationMessage("Please select a specific file to export.");
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

      // #10 - Ask whether to preserve the full package directory structure
      const exportMode = await vscode.window.showQuickPick([
        { label: "$(file) Single file", description: "Save just the file to a chosen location", value: "flat" },
        { label: "$(folder) Preserve directory structure", description: `Save with full path under a chosen folder (e.g. com/example/MyClass.java)`, value: "tree" }
      ], { title: "Export Mode" });
      if (!exportMode) return;

      let savePath;
      if (exportMode.value === "flat") {
        const defaultFileName = node.label.replace(/\.class$/, ".java");
        const saveUri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(workspaceFolder, defaultFileName)), title: "Export File" });
        if (!saveUri) return;
        savePath = saveUri.fsPath;
      } else {
        // Pick a root folder, then reconstruct the full path under it
        const folderUri = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: "Choose export root folder" });
        if (!folderUri || folderUri.length === 0) return;
        const entryExportPath = node.classPath.replace(/\.class$/, ".java");
        savePath = path.join(folderUri[0].fsPath, entryExportPath);
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
      }

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting...` }, async () => {
        try {
          const result = await runJarToolCached(node.jarRoot, node.classPath, context);
          const isImage = node.label.match(/\.(png|jpg|jpeg|gif|svg)$/i);
          const buffer = isImage
            ? Buffer.from(decodeBase64UrlToBase64(result), "base64")
            : (() => {
                const text = decodeBase64Url(result);
                // #8 - Prepend source comment so exported files carry their provenance
                const sourceComment = node.label.endsWith('.java') || node.classPath.endsWith('.class')
                  ? `// Exported from ${path.basename(node.jarRoot)} — ${node.classPath.replace(/\.class$/, '.java')}\n\n`
                  : `# Exported from ${path.basename(node.jarRoot)} — ${node.classPath}\n\n`;
                return Buffer.from(sourceComment + text, "utf8");
              })();
          fs.writeFileSync(savePath, buffer);
          // #11 - "Show in Explorer" and "Open File" buttons on the success notification
          const selection = await vscode.window.showInformationMessage(
            `Exported ${path.basename(savePath)}`,
            "Open File", "Show in Explorer"
          );
          if (selection === "Open File") await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(savePath)));
          if (selection === "Show in Explorer") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(savePath));
        } catch (err) { vscode.window.showErrorMessage("Export failed: " + err.message); }
      });
    })
  );

  // UPGRADED FEATURE: Smart Manifest & Fat JAR Bloat Visualizer
  context.subscriptions.push(
    vscode.commands.registerCommand("jarExplorer.analyzeArchive", async (node) => {
        if (!node || !node.isRoot) return;
        
        await vscode.window.withProgress({ 
            location: vscode.ProgressLocation.Notification, 
            title: `Analyzing Archive Structure...` 
        }, async () => {
            try {
                // Fetch full metadata objects to get file sizes
                const rawEntries = await getJarEntries(node.jarRoot, context, { withMetadata: true });

                // JarExplorerService doesn't include sizes in its JSON output, so we read them
                // directly from the ZIP central directory — fast, pure Node, no extra tools needed
                const zipSizes = readZipEntrySizes(node.jarRoot);

                const manifestEntry = rawEntries.find(e => e.name.toUpperCase() === "META-INF/MANIFEST.MF");
                
                // Find all nested archives anywhere in the JAR
                const dependencies = rawEntries
                    .filter(e => /\.(jar|war|ear|zip)$/i.test(e.name) && !e.name.endsWith('/'))
                    .map(e => ({
                        name: path.basename(e.name),
                        size: zipSizes.get(e.name) || 0,
                        path: e.name
                    }))
                    .sort((a, b) => b.size - a.size);

                let htmlContent = `<h2><span style="font-size: 24px;">📊</span> Archive Analysis: ${escapeHtml(path.basename(node.jarRoot))}</h2>`;

                // --- 1. MANIFEST OVERVIEW ---
                let decodedManifest = '';
                if (manifestEntry) {
                    const result = await runJarToolCached(node.jarRoot, manifestEntry.name, context);
                    decodedManifest = decodeBase64Url(result);
                    htmlContent += `<h3>Manifest Overview</h3><div class="card"><ul>`;
                    decodedManifest.split(/\r?\n/).forEach(line => {
                        if (line.includes(":")) {
                            const [key, ...vals] = line.split(":");
                            if (["Manifest-Version", "Created-By", "Build-Jdk", "Main-Class", "Start-Class", "Spring-Boot-Version", "Implementation-Title", "Implementation-Version"].includes(key.trim())) {
                                htmlContent += `<li><strong>${escapeHtml(key)}:</strong> <span class="highlight">${escapeHtml(vals.join(":").trim())}</span></li>`;
                            }
                        }
                    });
                    htmlContent += `</ul></div>`;
                }

                // --- 2. DEPENDENCY BLOAT VISUALIZER ---
                if (dependencies.length > 0) {
                    const totalSize = dependencies.reduce((acc, curr) => acc + curr.size, 0);
                    const hasValidSizes = totalSize > 0;

                    // If sizes are still all zero, the ZIP central directory may be non-standard
                    if (!hasValidSizes && rawEntries.length > 0) {
                        console.warn('[JAR Explorer] Could not read entry sizes from ZIP central directory.');
                    }

                    htmlContent += `<h3>📦 Dependency Bloat Visualizer</h3>`;
                    htmlContent += `<p>Found <b>${dependencies.length}</b> bundled libraries.</p>`;

                    if (hasValidSizes) {
                        htmlContent += `<p style="opacity: 0.8; font-size: 13px;">Total Library Payload: <b>${formatBytes(totalSize)}</b></p>`;
                        
                        // Prepare top-10 slice for the chart
                        const top10 = dependencies.slice(0, 10);
                        
                        // Inject Chart — data is passed via an inert JSON block, never interpolated into JS
                        htmlContent += `
                        <div class="card" style="display: flex; justify-content: center; background: var(--vscode-editor-background); padding: 20px;">
                            <div style="width: 100%; max-width: 500px;">
                                <canvas id="dependencyChart"></canvas>
                            </div>
                        </div>
                        <script type="application/json" id="chartPayload">${JSON.stringify({ labels: top10.map(d => d.name), data: top10.map(d => parseFloat((d.size / (1024*1024)).toFixed(2))) })}</script>
                        <script src="__CHART_JS_URI__"></script>
                        <script>
                            const payload = JSON.parse(document.getElementById('chartPayload').textContent);
                            Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-foreground') || '#cccccc';
                            Chart.defaults.font.family = 'var(--vscode-font-family)';
                            const ctx = document.getElementById('dependencyChart').getContext('2d');
                            new Chart(ctx, {
                                type: 'doughnut',
                                data: {
                                    labels: payload.labels,
                                    datasets: [{
                                        label: 'Size (MB)',
                                        data: payload.data,
                                        backgroundColor: [
                                            '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF',
                                            '#FF9F40', '#E7E9ED', '#8A2BE2', '#00FA9A', '#DC143C'
                                        ],
                                        borderWidth: 0
                                    }]
                                },
                                options: {
                                    responsive: true,
                                    plugins: {
                                        legend: { display: false },
                                        title: { display: true, text: 'Top 10 Largest Libraries (MB)', color: Chart.defaults.color }
                                    }
                                }
                            });
                        </script>`;
                    }

                    // Table of all dependencies
                    htmlContent += `
                    <h4 style="margin-top: 30px;">All Embedded Libraries</h4>
                    <div style="max-height: 350px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 6px;">
                        <table style="width: 100%; border-collapse: collapse; text-align: left;">
                            <thead style="background: var(--vscode-editorWidget-background); position: sticky; top: 0;">
                                <tr>
                                    <th style="padding: 10px; border-bottom: 1px solid var(--vscode-panel-border);">Library Name</th>
                                    <th style="padding: 10px; border-bottom: 1px solid var(--vscode-panel-border);">Size</th>
                                </tr>
                            </thead>
                            <tbody>`;
                    
                    dependencies.forEach(dep => {
                        htmlContent += `
                            <tr>
                                <td style="padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); font-size: 13px;">${escapeHtml(dep.name)}</td>
                                <td style="padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 13px; color: var(--vscode-textPreformat-foreground);">${hasValidSizes ? formatBytes(dep.size) : 'Unknown'}</td>
                            </tr>`;
                    });

                    htmlContent += `</tbody></table></div>`;
                }

                const panel = vscode.window.createWebviewPanel('jarAnalyzer', `Analysis: ${escapeHtml(path.basename(node.jarRoot))}`, vscode.ViewColumn.One, {
                  enableScripts: true,
                  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')],
                  retainContextWhenHidden: true  // Preserve scroll position when switching tabs
                });

                // Now that panel exists, resolve the chart.js webview URI and inject it
                const chartJsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'chart.umd.min.js'));
                htmlContent = htmlContent.replace('__CHART_JS_URI__', chartJsUri.toString());

                // Build export data for #11
                const exportData = {
                  archive: path.basename(node.jarRoot),
                  manifest: {},
                  dependencies: dependencies.map(d => ({ name: d.name, size: d.size, sizeFormatted: formatBytes(d.size) }))
                };
                if (decodedManifest) {
                  decodedManifest.split(/\r?\n/).forEach(line => {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx > 0) exportData.manifest[line.substring(0, colonIdx).trim()] = line.substring(colonIdx + 1).trim();
                  });
                }

                panel.webview.onDidReceiveMessage(async (msg) => {
                  if (msg.command === 'copyMarkdown') {
                    let md = `# Archive Analysis: ${exportData.archive}\n\n`;
                    md += `## Manifest\n`;
                    Object.entries(exportData.manifest).forEach(([k, v]) => { md += `- **${k}:** \`${v}\`\n`; });
                    md += `\n## Dependencies (${exportData.dependencies.length} libraries)\n`;
                    md += `| Library | Size |\n|---|---|\n`;
                    exportData.dependencies.forEach(d => { md += `| ${d.name} | ${d.sizeFormatted} |\n`; });
                    await vscode.env.clipboard.writeText(md);
                    vscode.window.setStatusBarMessage('$(clippy) Analysis copied as Markdown', 3000);
                  }
                  if (msg.command === 'exportJson') {
                    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${exportData.archive}-analysis.json`), filters: { 'JSON': ['json'] } });
                    if (uri) { fs.writeFileSync(uri.fsPath, JSON.stringify(exportData, null, 2), 'utf8'); vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`); }
                  }
                }, undefined, context.subscriptions);

                panel.webview.html = `
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${panel.webview.cspSource}; style-src 'unsafe-inline'; img-src data:;">
                        <style>
                            body { font-family: var(--vscode-font-family); padding: 30px; line-height: 1.6; max-width: 900px; margin: auto; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                            h2 { color: var(--vscode-textLink-foreground); border-bottom: 2px solid var(--vscode-panel-border); padding-bottom: 10px; margin-bottom: 20px;}
                            h3 { margin-top: 30px; opacity: 0.9; }
                            ul { list-style-type: none; padding-left: 0; }
                            li { margin: 8px 0; font-size: 14px; }
                            strong { color: var(--vscode-textPreformat-foreground); }
                            .highlight { background: var(--vscode-editor-selectionBackground); padding: 2px 6px; border-radius: 4px; }
                            .card { background: var(--vscode-editorWidget-background); padding: 15px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
                            table { font-family: var(--vscode-font-family); }
                            .export-bar { display: flex; gap: 8px; margin-bottom: 20px; }
                            .export-btn { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
                                          color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
                                          border: none; border-radius: 3px; padding: 5px 14px; cursor: pointer; font-size: 12px; }
                            .export-btn:hover { filter: brightness(1.15); }
                            ::-webkit-scrollbar { width: 10px; }
                            ::-webkit-scrollbar-track { background: transparent; }
                            ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; }
                            ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
                        </style>
                    </head>
                    <body>
                      <div class="export-bar">
                        <button class="export-btn" onclick="vscode.postMessage({command:'copyMarkdown'})">📋 Copy as Markdown</button>
                        <button class="export-btn" onclick="vscode.postMessage({command:'exportJson'})">💾 Export as JSON</button>
                      </div>
                      ${htmlContent}
                      <script>const vscode = acquireVsCodeApi();</script>
                    </body>
                    </html>
                `;
            } catch (err) {
                vscode.window.showErrorMessage("Analysis failed: " + err.message);
            }
        });
    })
  );

  // Helper: repack a single file into a JAR using the jar CLI
  async function repackFileIntoJar(jarPath, entryPath, content) {
    const jarCliPath = getJdkTool('jar');
    const tempRepackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-repack-'));
    try {
      const targetFilePath = path.join(tempRepackDir, entryPath);
      fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
      fs.writeFileSync(targetFilePath, content);
      await new Promise((resolve, reject) => {
        cp.execFile(jarCliPath, ["uf", jarPath, "-C", tempRepackDir, entryPath],
          (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve());
      });
    } finally {
      deleteTempDirectory(tempRepackDir);
    }
  }

  // Live Edit & Repack — with full nested JAR write-back
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const fsPath = document.uri.fsPath;
      if (!liveEditMap.has(fsPath)) return;

      try {
        const { jarPath, entryPath, rootJarPath, nestedJarEntry } = liveEditMap.get(fsPath);
        const isNested = !!(rootJarPath && nestedJarEntry);

        const confirmLabel = isNested
          ? `Repack into ${path.basename(nestedJarEntry)} and then into ${path.basename(rootJarPath)}?`
          : `Repack changes into ${path.basename(jarPath)}?`;

        const action = await vscode.window.showInformationMessage(confirmLabel, "Yes, Update JAR", "Cancel");
        if (action !== "Yes, Update JAR") return;

        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: isNested
            ? `Updating ${path.basename(entryPath)} and repacking nested archive...`
            : `Updating ${entryPath} inside Archive...`,
          cancellable: false
        }, async () => {
          const content = document.getText();

          // Step 1: write the edited file into the immediate (possibly temp) JAR
          await repackFileIntoJar(jarPath, entryPath, content);

          // Invalidate stat cache so getCacheKey picks up the new mtime after repack
          _statCache.delete(jarPath);
          if (isNested) _statCache.delete(rootJarPath);

          // Update cache for the immediate JAR
          const cacheKey = getCacheKey(jarPath, entryPath, 'java');
          fs.writeFileSync(path.join(CACHE_DIR, cacheKey), content, "utf8");

          // Step 2: if this was a nested JAR, repack that nested JAR back into the root JAR
          if (isNested) {
            await repackFileIntoJar(rootJarPath, nestedJarEntry, fs.readFileSync(jarPath));
            vscode.window.showInformationMessage(
              `Successfully repacked ${path.basename(entryPath)} into ${path.basename(nestedJarEntry)} and into ${path.basename(rootJarPath)}!`
            );
          } else {
            vscode.window.showInformationMessage(
              `Successfully repacked ${path.basename(entryPath)} into ${path.basename(jarPath)}!`
            );
          }
        });

      } catch (err) {
        vscode.window.showErrorMessage("Failed to repack file: " + err.message);
      }
    })
  );

  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.clearCache", () => {
      try {
        if (fs.existsSync(CACHE_DIR)) {
          const files = fs.readdirSync(CACHE_DIR);
          const totalBytes = files.reduce((sum, f) => {
            try { return sum + fs.statSync(path.join(CACHE_DIR, f)).size; } catch (_) { return sum; }
          }, 0);
          const sizeStr = formatBytes(totalBytes);
          for (const file of files) fs.unlinkSync(path.join(CACHE_DIR, file));
          // Refresh any open virtual (decompiled) documents so they don't show stale content
          vscode.workspace.textDocuments.forEach((doc) => {
            if (doc.uri.scheme === "virtual") providerEventEmitter.fire(doc.uri);
          });
          vscode.window.showInformationMessage(`Cleared ${files.length} cached items (${sizeStr}). Open files will reload.`);
          updateCacheStatusBar();
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to clear cache: ${err.message}`);
      }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand("jarExplorer.searchInJar", async (node) => {
      if (!node) return;

      // For nestedArchive nodes (already expanded), search inside the temp-extracted JAR path.
      // For jarRoot nodes, search the root JAR directly.
      // For folder nodes, search their parent root JAR.
      let searchRoot = node.jarRoot;

      if (node.contextValue === 'nestedArchive') {
        if (node.wasLoaded) {
          // Find the temp-extracted path in nestedJarMap by matching the nestedJarEntry
          for (const [absPath, info] of nestedJarMap.entries()) {
            if (info.nestedJarEntry === node.classPath && info.rootJarPath === node.jarRoot) {
              searchRoot = absPath;
              break;
            }
          }
        } else {
          // FIX: Extract unopened nested archives on-the-fly for searching
          try {
            await vscode.window.withProgress({
              location: vscode.ProgressLocation.Window,
              title: `Preparing ${node.label} for search...`
            }, async () => {
              const cmarArr = ["-jar", path.join(context.extensionPath, "resources", "JarExplorerService.jar"), "InnerJar", node.jarRoot, node.classPath];
              const stdout = await new Promise((resolve, reject) => {
                execFile(getJavaExecutable(), cmarArr, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout) => { 
                  if (err) reject(err); else resolve(stdout); 
                });
              });
              
              const res = JSON.parse(stdout);
              if (res.absolutePath) {
                searchRoot = res.absolutePath;
                // Add to maps so it gets cleaned up properly on deactivation
                absolutePathMap.set(`search-temp-${searchRoot}`, [searchRoot]);
                nestedJarMap.set(searchRoot, { rootJarPath: node.jarRoot, nestedJarEntry: node.classPath });
              } else {
                throw new Error("Invalid extraction path returned.");
              }
            });
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to prepare nested archive for search: ${err.message}`);
            return; // Abort the search if the extraction fails
          }
        }
      }

      const searchTerm = await vscode.window.showInputBox({
        title: `Search in ${path.basename(searchRoot)}`,
        prompt: "Search across all scannable entries in this archive",
        placeHolder: "e.g. DataSource, log4j, application.properties",
        validateInput: (v) => v.trim().length === 0 ? "Please enter a search term" : null
      });
      if (!searchTerm) return;

      // Default: case-insensitive literal search. Options can be changed in the results panel.
      let searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

      // Override node for the rest of the command to use the resolved searchRoot
      const searchNode = { ...node, jarRoot: searchRoot };

      // Open the results panel immediately so it's visible while searching
      const searchPanel = vscode.window.createWebviewPanel(
        'jarSearch',
        `Search "${searchTerm}" — ${path.basename(searchNode.jarRoot)}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
      );
      searchPanel.webview.html = buildSearchLoadingHtml(searchTerm, path.basename(searchNode.jarRoot));

      // Cache the entry list for this panel — avoids re-running the Java tool on every re-search
      let cachedEntries = null;

      // Handle clicks and search-again from the webview
      searchPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'open') {
          await vscode.commands.executeCommand("jarExplorer.openClassFile", msg.jarRoot, msg.entryPath, msg.className);
          const target = treeProvider._findNode(treeProvider.tree, msg.nodeId);
          if (target && treeProvider.treeView) {
            treeProvider.treeView.reveal(target, { select: true, focus: false, expand: true });
          }
        }
        if (msg.command === 'search') {
          const newTerm = msg.term;
          const flags = msg.caseSensitive ? '' : 'i';
          let newRegex;
          try {
            const pattern = msg.useRegex ? newTerm : newTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            newRegex = new RegExp(pattern, flags);
          } catch (e) {
            searchPanel.webview.postMessage({ command: 'regexError', message: e.message });
            return;
          }
          searchPanel.title = `Search "${newTerm}" — ${path.basename(searchNode.jarRoot)}`;
          // Show loading state in-place so the panel doesn't flash/scroll-reset
          searchPanel.webview.postMessage({ command: 'setLoading', term: newTerm });
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, cancellable: true, title: `Searching for "${newTerm}"...` }, async (progress, token) => {
            try {
              // Reuse the already-fetched entry list — no need to re-invoke Java
              if (!cachedEntries) cachedEntries = await getJarEntries(searchNode.jarRoot, context);
              const { results: newResults, truncated: newTruncated } = await searchInsideEntries(searchNode.jarRoot, cachedEntries, newRegex, context, token, progress);
              if (token.isCancellationRequested) {
                searchPanel.webview.postMessage({ command: 'updateResults', payload: buildSearchResultsBodyHtml(newTerm, searchNode.jarRoot, [], newRegex, { caseSensitive: msg.caseSensitive, useRegex: msg.useRegex, truncated: false }) });
                return;
              }
              searchPanel.webview.postMessage({
                command: 'updateResults',
                payload: buildSearchResultsBodyHtml(newTerm, searchNode.jarRoot, newResults, newRegex, { caseSensitive: msg.caseSensitive, useRegex: msg.useRegex, truncated: newTruncated })
              });
            } catch (err) {
              vscode.window.showErrorMessage(`Search failed: ${err.message}`);
            }
          });
        }
      }, undefined, context.subscriptions);

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, cancellable: true, title: `Searching for "${searchTerm}"...` }, async (progress, token) => {
        try {
          const allEntries = await getJarEntries(searchNode.jarRoot, context);
          cachedEntries = allEntries; // cache for re-searches
          const { results: searchResults, truncated } = await searchInsideEntries(searchNode.jarRoot, allEntries, searchRegex, context, token, progress);
          if (token.isCancellationRequested) { searchPanel.dispose(); return; }
          searchPanel.webview.html = buildSearchResultsHtml(searchTerm, path.basename(searchNode.jarRoot), searchNode.jarRoot, searchResults, searchRegex, { caseSensitive: false, useRegex: false, truncated });
        } catch (err) {
          vscode.window.showErrorMessage(`Search failed: ${err.message}`);
          searchPanel.dispose();
        }
      });
    })
  );

  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.openWithCustomEditor", async (uri) => await vscode.commands.executeCommand("vscode.openWith", uri, "jarExplorer.editor")));
  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.removeFile", async (node) => {
      const archiveName = path.basename(node.jarRoot);
      const answer = await vscode.window.showWarningMessage(
        `Remove "${archiveName}" from the explorer?`,
        { modal: true, detail: node.jarRoot },
        "Remove"
      );
      if (answer !== "Remove") return;
      const index = treeProvider.tree.findIndex((e) => e.getId() === node.getId());
      if (index !== -1) {
        treeProvider.tree.splice(index, 1);
        treeProvider._onDidChangeTreeData.fire();
        context.globalState.update('jarExplorer.sessionJars', treeProvider.tree.map(n => n.jarRoot).filter(Boolean));
        if (treeProvider.treeView) {
          treeProvider.treeView.badge = treeProvider.tree.length > 0
            ? { value: treeProvider.tree.length, tooltip: `${treeProvider.tree.length} archive${treeProvider.tree.length !== 1 ? 's' : ''} loaded` }
            : undefined;
        }
      }
  }));

  // #3 - Refresh: re-load a JAR from disk, clearing its cache entries first
  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.clearCacheForJar", async (node) => {
    if (!node || !node.jarRoot) return;
    _statCache.delete(node.jarRoot);
    const index = loadCacheIndex();
    const keys = index[node.jarRoot] || [];
    let cleared = 0;
    for (const key of keys) {
      try { fs.unlinkSync(path.join(CACHE_DIR, key)); cleared++; } catch (_) {}
    }
    delete index[node.jarRoot];
    saveCacheIndex(index);  // flush immediately since user explicitly cleared
    vscode.workspace.textDocuments.forEach(doc => {
      if (doc.uri.scheme === 'virtual') {
        try {
          const params = JSON.parse(decodeURIComponent(doc.uri.query));
          if (params.jarPath === node.jarRoot) providerEventEmitter.fire(doc.uri);
        } catch (_) {}
      }
    });
    updateCacheStatusBar();
    vscode.window.showInformationMessage(`Cleared ${cleared} cached entries for ${path.basename(node.jarRoot)}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.refreshJar", async (node) => {
    if (!node || !node.jarRoot) return;
    // Remove from tree so setJarFile re-adds it fresh
    const treeIndex = treeProvider.tree.findIndex(e => e.getId() === node.getId());
    if (treeIndex !== -1) treeProvider.tree.splice(treeIndex, 1);
    // Invalidate stat cache and only this JAR's decompile cache entries (not the whole cache)
    _statCache.delete(node.jarRoot);
    const cacheIdx = loadCacheIndex();
    const keys = cacheIdx[node.jarRoot] || [];
    for (const key of keys) {
      try { fs.unlinkSync(path.join(CACHE_DIR, key)); } catch (_) {}
    }
    delete cacheIdx[node.jarRoot];
    saveCacheIndex(cacheIdx);
    treeProvider.setJarFile(node.jarRoot);
    updateCacheStatusBar();
    vscode.window.setStatusBarMessage(`$(sync) Refreshed ${path.basename(node.jarRoot)}`, 3000);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.copyEntryPath", async (node) => {
    await vscode.env.clipboard.writeText(node.classPath);
    vscode.window.setStatusBarMessage(`$(clippy) Copied: ${node.classPath}`, 3000);
  }));

  // #6 - Copy fully qualified class name (e.g. com.example.MyClass)
  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.copyFQCN", async (node) => {
    const fqcn = node.classPath.replace(/\.class$/, '').replace(/\//g, '.');
    await vscode.env.clipboard.writeText(fqcn);
    vscode.window.setStatusBarMessage(`$(clippy) Copied: ${fqcn}`, 3000);
  }));

  // #5 - Toggle alphabetical sort
  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.toggleSort", () => {
    treeProvider.sortAlpha = !treeProvider.sortAlpha;
    context.globalState.update('jarExplorer.sortAlpha', treeProvider.sortAlpha);
    treeProvider._onDidChangeTreeData.fire();
    vscode.window.setStatusBarMessage(
      `$(list-ordered) JAR Explorer: ${treeProvider.sortAlpha ? 'Alphabetical' : 'Natural'} order`, 3000
    );
  }));

  // #12 - Reopen recent archives
  context.subscriptions.push(vscode.commands.registerCommand("jarExplorer.reopenRecent", async () => {
    const recent = context.globalState.get('jarExplorer.recentArchives', []);
    // Normalise: entries may be plain strings (old format) or { path, openedAt } objects (new format)
    const normalised = recent.map(e => typeof e === 'string' ? { path: e, openedAt: null } : e);
    // #11 - Remove entries that no longer exist on disk
    const valid = normalised.filter(e => { try { return fs.existsSync(e.path); } catch (_) { return false; } });
    if (valid.length !== recent.length) context.globalState.update('jarExplorer.recentArchives', valid);
    if (valid.length === 0) {
      vscode.window.showInformationMessage('No recently opened archives found.');
      return;
    }
    const items = valid.map(e => {
      const dateLabel = e.openedAt
        ? new Date(e.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
      return {
        label: `$(file-zip) ${path.basename(e.path)}`,
        description: path.dirname(e.path),
        detail: dateLabel ? `Last opened: ${dateLabel}` : undefined,
        fullPath: e.path
      };
    });
    const pick = await vscode.window.showQuickPick(items, { title: 'Reopen Recent Archive', placeHolder: 'Select an archive to reopen' });
    if (pick) treeProvider.setJarFile(pick.fullPath);
  }));
}

function deleteTempDirectory(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {}
}

exports.activate = activate;

function deactivate() {
  // Flush in-memory cache index to disk before shutdown
  flushCacheIndex();

  // Clean up all temp directories created during this session
  const editBase = path.join(os.tmpdir(), "jar-explorer-edit");
  deleteTempDirectory(editBase);

  // Clean up any temp nested JAR extractions tracked in nestedJarMap
  nestedJarMap.forEach(({ rootJarPath }, absPath) => {
    // absPath is the temp-extracted nested JAR file itself; delete its parent temp dir
    const tempParent = path.dirname(absPath);
    if (tempParent.startsWith(os.tmpdir())) deleteTempDirectory(tempParent);
  });
  nestedJarMap.clear();
  liveEditMap.clear();
}

exports.deactivate = deactivate;