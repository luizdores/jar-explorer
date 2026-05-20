# 📦 Changelog

All notable changes to this project will be documented here.

---

## [1.2.0] – 2025-08-10

### 🎉 JAR Explorer Enhanced (Major Fork Update)
This release represents a comprehensive overhaul, transforming the extension from a read-only viewer into a full-fledged enterprise archive manager.

**✏️ Editing & Write-Back**
- **Live editing** — Edit any text or resource file directly inside a JAR and save it back.
- **Full nested JAR write-back** — Edits inside nested archives (e.g., a `.properties` in a `.jar` in a `.war`) automatically repack through all levels to the root archive.

**🔍 Advanced Search & Navigation**
- **Rich Full-Text Search Webview** — Completely rewritten search UI. Search across all scannable entries with support for **Regex**, **Case Sensitivity**, and **Live Filtering**. Results are grouped by file with collapsible headers.
- **Session Persistence** — Open archives now survive VS Code restarts. Your workspace restores exactly as you left it.
- **Reopen Recent** — Added history tracking with a "Reopen Recent Archive" command.
- **Drag & Drop Support** — Drag `.jar`, `.war`, `.zip` files directly from your OS into the Explorer sidebar.
- **Tree Sorting & UI** — Toggle alphabetical sorting. Files now display proper VS Code file-type icons, and hovering over nodes reveals detailed Markdown tooltips.

**📊 Analysis & Export**
- **Offline Archive Analysis** — The dependency bloat chart now works completely offline (Chart.js is bundled natively). Added **Copy as Markdown** and **Export as JSON** buttons to the report.
- **Advanced Export** — Exporting files now allows you to choose between saving a flat file or **preserving the original directory structure**. Source code comments are automatically injected to show provenance.
- **Quick Copy Tools** — Right-click to quickly "Copy Entry Path" or "Copy Class Name (FQCN)".

**⚡ Performance & Caching**
- **Async Decompilation** — Opening a class file instantly opens a tab with a loading placeholder that auto-refreshes when CFR/javap finishes, preventing UI lockups.
- **Granular Cache Control** — Added a live Status Bar indicator for cache size. Added options to **Refresh Archive** or **Clear Cache for This Archive** without wiping the global cache.
- **O(1) Deduplication** — Opening the same editable file twice now focuses the existing temp document instantly instead of duplicating it on disk.

**🔒 Security & Cleanup**
- **Security Hardening** — Full XSS protection in webviews, Strict Content Security Policies, and isolated local resources.
- **Garbage Collection** — Automatic temp file cleanup on startup and shutdown to prevent OS temp directory bloat.
- **Safe Removal** — Added a confirmation dialog before removing a JAR from the tree.

---

## [1.1.0] – 2025-07-25

### 🆕 Archive Support Enhancements
- ✅ Added support for **`.war`**, **`.ear`**,**`.zip`** and **`.vsix`** files alongside `.jar`
- 🔁 Supports browsing **nested archives** (e.g. `.jar` inside `.war`, `.war` inside `.ear`, etc.)
- 📂 Improved tree view to reflect internal structure of multi-level archive files

### 🖼️ File Viewing Improvements
- 🖼️ Now you can **view embedded images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`
- 📜 Added syntax highlighting and viewing for `.xml`, `.json`, `.properties`, `.txt`

### 🔧 Decompilation Features
- 🧬 Enhanced `.class` file viewer with **decompiled Java output**
- ⏳ Shows **loading indicator** while decompiling large `.class` files
- 🚫 Added support for **decompilation cancellation** and timeout fallback
- ⚙️ Customizable path to your **Decompiler JAR** (e.g., CFR) and optional JDK

### 💡 UI and UX Enhancements
- 🧭 Introduced **dedicated Activity Bar icon** for quick access to the Jar Explorer
- 🧹 Clean and modern **WebView-based decompiled code viewer**
- ❌ **Remove file** option from Jar Explorer to manage open archives easily
- 📂 Support for **opening and exploring multiple archives** simultaneously

✅ **Upgrade now** to explore and decompile all your Java archives—even deeply nested ones—right inside VS Code!

---

## [1.0.0] – 2025-07-19

### 🚀 Added
- Support for opening non-`.class` files (e.g., `.xml`, `.properties`, `.txt`) directly from JARs
- Ability to open and manage **multiple JAR files** simultaneously in the Jar Explorer
- Improved file viewer handling with better error resilience and support for more file types

---

## [0.0.1] – 2025-07-18

### 🎉 Initial Release
- View `.class` files from `.jar` archives with syntax highlighting
- Basic tree view to explore archive structure