const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const app = express();

// 解析 JSON 请求体
app.use(express.json({ limit: "2mb" }));

// 支持命令行参数和环境变量配置
const args = process.argv.slice(2);
let customPort = null;
let customScanDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) {
    customPort = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--scan-dir" && args[i + 1]) {
    customScanDir = args[i + 1];
    i++;
  }
}

const PORT = customPort || parseInt(process.env.DOC_READER_PORT, 10) || 3456;

// 扫描目录：命令行参数 > 环境变量 > 默认值
let scanDir = path.resolve(
  customScanDir || process.env.DOC_READER_SCAN_DIR || path.join(__dirname, ".."),
);

// docRoots: { projectName: absolutePathToDocDir }
// 存储扫描结果，项目名 -> doc 目录的绝对路径
let docRoots = {};

// 初始扫描
scanForDocs(scanDir);

// 静态文件服务
app.use("/static", express.static(path.join(__dirname, "public")));

// API: 获取当前扫描目录
app.get("/api/config", (req, res) => {
  res.json({ scanDir });
});

// API: 设置扫描目录并重新扫描
app.post("/api/config", (req, res) => {
  const { scanDir: newDir } = req.body;
  if (!newDir || typeof newDir !== "string") {
    return res.status(400).json({ error: "Missing scanDir" });
  }
  const resolved = path.resolve(newDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: "目录不存在: " + resolved });
  }
  scanDir = resolved;
  scanForDocs(scanDir);
  res.json({ ok: true, scanDir, projects: Object.keys(docRoots) });
});

// API: 手动触发重新扫描
app.post("/api/scan", (req, res) => {
  try {
    scanForDocs(scanDir);
    res.json({ ok: true, scanDir, projects: Object.keys(docRoots) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 获取目录树（聚合所有 doc 项目）
app.get("/api/tree", (req, res) => {
  try {
    const projects = [];
    for (const [projectName, docPath] of Object.entries(docRoots)) {
      const tree = buildDocTree(docPath, projectName);
      projects.push(tree);
    }
    // 按项目名排序
    projects.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    res.json({ type: "root", children: projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: 获取文档内容（原始 Markdown）
app.get("/api/doc", (req, res) => {
  const relativePath = req.query.path;
  if (!relativePath) {
    return res.status(400).json({ error: "Missing path parameter" });
  }

  // 路径格式: projectKey/path/to/file.md
  // projectKey 可能包含 /（如 "clawdbot/Swabble"），需要匹配最长前缀
  let matchedProject = null;
  let docRelPath = null;

  // 按 key 长度降序排，优先匹配最长前缀
  const sortedKeys = Object.keys(docRoots).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (relativePath === key || relativePath.startsWith(key + "/")) {
      matchedProject = key;
      docRelPath = relativePath.slice(key.length + 1); // +1 for the "/"
      break;
    }
  }

  if (!matchedProject) {
    return res.status(404).json({ error: "项目不存在" });
  }

  const docRoot = docRoots[matchedProject];
  const fullPath = path.join(docRoot, docRelPath);

  // 安全检查：防止路径遍历
  if (!fullPath.startsWith(docRoot)) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  res.json({ content, path: relativePath });
});

// API: 搜索文档（所有项目）
app.get("/api/search", (req, res) => {
  const query = (req.query.q || "").toLowerCase().trim();
  if (!query) {
    return res.json([]);
  }

  const results = [];
  for (const [projectName, docPath] of Object.entries(docRoots)) {
    searchFiles(docPath, projectName, query, results);
  }
  res.json(results.slice(0, 50)); // 最多返回50条结果
});

// API: 翻译文档（英文 -> 中文）
// 支持多种翻译模式: api（在线API）、llm（本地大模型）
app.post("/api/translate", async (req, res) => {
  const { text, mode = "api" } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }

  try {
    let translated;
    if (mode === "llm") {
      translated = await translateWithLLM(text);
    } else {
      translated = await translateText(text, "en", "zh-CN");
    }
    res.json({ translated });
  } catch (err) {
    console.error("翻译失败:", err.message);
    res.status(500).json({ error: "翻译失败: " + err.message });
  }
});

// API: 检查本地 LLM 是否可用
app.get("/api/llm-status", async (req, res) => {
  try {
    const status = await checkLLMStatus();
    res.json(status);
  } catch (err) {
    res.json({ available: false, error: err.message });
  }
});

// API: 获取/设置 LLM 配置
let llmConfig = {
  baseUrl: process.env.LLM_BASE_URL || "http://192.168.31.173:1234/v1",
  apiKey: process.env.LLM_API_KEY || "lmstudio",
  model: process.env.LLM_MODEL || "", // 空字符串表示自动检测
};

app.get("/api/llm-config", (req, res) => {
  res.json(llmConfig);
});

app.post("/api/llm-config", (req, res) => {
  const { baseUrl, apiKey, model } = req.body;
  if (baseUrl) llmConfig.baseUrl = baseUrl;
  if (apiKey !== undefined) llmConfig.apiKey = apiKey;
  if (model !== undefined) llmConfig.model = model;
  res.json({ ok: true, config: llmConfig });
});

/**
 * 翻译文本：按段落分块翻译，保持 Markdown 结构
 */
async function translateText(text, from, to) {
  const MAX_CHUNK = 4500;
  const paragraphs = text.split(/(\n\s*\n)/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + para).length > MAX_CHUNK && current.length > 0) {
      chunks.push(current);
      current = para;
    } else {
      current += para;
    }
  }
  if (current) chunks.push(current);

  const translatedChunks = [];
  for (const chunk of chunks) {
    // 跳过纯空白/代码块等不需要翻译的内容
    if (!chunk.trim() || /^\s*$/.test(chunk)) {
      translatedChunks.push(chunk);
      continue;
    }
    const result = await translateChunkWithFallback(chunk, from, to);
    translatedChunks.push(result);
  }

  return translatedChunks.join("");
}

/**
 * 带 fallback 的翻译：依次尝试 MyMemory -> 简单正则替换
 */
async function translateChunkWithFallback(text, from, to) {
  // 方案1: MyMemory API（免费，国内可用, 每天限额）
  try {
    return await myMemoryTranslate(text, from, to);
  } catch (e) {
    console.warn("MyMemory 翻译失败:", e.message);
  }

  // 方案2: Google Translate（需要网络通畅）
  try {
    return await googleTranslateChunk(text, from, to);
  } catch (e) {
    console.warn("Google 翻译失败:", e.message);
  }

  // 都失败了
  throw new Error("所有翻译服务均不可用，请检查网络");
}

/**
 * 检查本地 LLM 服务状态
 */
function checkLLMStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL(llmConfig.baseUrl);
    const modelsUrl = `${url.protocol}//${url.host}/v1/models`;
    const client = url.protocol === "https:" ? https : http;

    const req = client.get(
      modelsUrl,
      {
        headers: {
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        timeout: 5000,
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            const json = JSON.parse(data);
            const models = (json.data || []).map((m) => m.id);
            resolve({
              available: true,
              baseUrl: llmConfig.baseUrl,
              models,
              currentModel: llmConfig.model || models[0] || "",
            });
          } catch (e) {
            reject(new Error("解析模型列表失败"));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error("LLM 服务不可用: " + err.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("LLM 服务连接超时"));
    });
  });
}

/**
 * 使用本地大模型翻译整篇文档
 * 分块发送，保持 Markdown 格式
 */
async function translateWithLLM(text) {
  // 先检查 LLM 可用性并获取模型
  const status = await checkLLMStatus();
  if (!status.available || status.models.length === 0) {
    throw new Error("本地 LLM 服务不可用，请确保 LM Studio 已启动");
  }

  const modelId = llmConfig.model || status.models[0];

  // 将文档分块（按段落），每块不超过 3000 字符以确保翻译质量
  const chunks = splitMarkdownForLLM(text, 3000);
  const translatedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.translatable) {
      translatedChunks.push(chunk.text);
      continue;
    }

    console.log(`[LLM翻译] 正在翻译第 ${i + 1}/${chunks.length} 块...`);
    const translated = await llmTranslateChunk(chunk.text, modelId);
    translatedChunks.push(translated);
  }

  return translatedChunks.join("");
}

/**
 * 将 Markdown 分块用于 LLM 翻译（代码块不翻译）
 */
function splitMarkdownForLLM(text, maxLen) {
  const chunks = [];
  // 分离代码块
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```")) {
      chunks.push({ text: part, translatable: false });
    } else if (!part.trim()) {
      chunks.push({ text: part, translatable: false });
    } else {
      // 按段落分割长文本
      const paragraphs = part.split(/(\n\s*\n)/);
      let current = "";
      for (const para of paragraphs) {
        if ((current + para).length > maxLen && current.length > 0) {
          chunks.push({ text: current, translatable: true });
          current = para;
        } else {
          current += para;
        }
      }
      if (current) {
        if (current.trim()) {
          chunks.push({ text: current, translatable: true });
        } else {
          chunks.push({ text: current, translatable: false });
        }
      }
    }
  }

  return chunks;
}

/**
 * 调用本地 LLM 翻译单个文本块
 */
function llmTranslateChunk(text, modelId) {
  return new Promise((resolve, reject) => {
    const url = new URL(llmConfig.baseUrl);
    const chatUrl = `${url.protocol}//${url.host}/v1/chat/completions`;
    const client = url.protocol === "https:" ? https : http;

    const requestBody = JSON.stringify({
      model: modelId,
      messages: [
        {
          role: "system",
          content:
            "你是一个专业的技术文档翻译专家。请将以下英文 Markdown 文档翻译成中文。规则：\n" +
            "1. 保持 Markdown 格式不变（标题、列表、链接、粗体、斜体等）\n" +
            "2. 代码块、代码片段、命令、文件路径、URL 保持原文不翻译\n" +
            "3. 技术术语（如 API、SDK、HTTP、JSON 等）保持英文\n" +
            "4. 翻译要自然流畅，符合中文技术文档习惯\n" +
            "5. 只输出翻译后的内容，不要添加任何解释或注释",
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const reqOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      timeout: 120000, // 本地大模型可能较慢
    };

    const req = client.request(chatUrl, reqOptions, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].message) {
            resolve(json.choices[0].message.content);
          } else if (json.error) {
            reject(
              new Error("LLM 返回错误: " + (json.error.message || JSON.stringify(json.error))),
            );
          } else {
            reject(new Error("LLM 返回格式异常: " + data.substring(0, 200)));
          }
        } catch (e) {
          reject(new Error("解析 LLM 响应失败: " + e.message));
        }
      });
    });

    req.on("error", (err) => reject(new Error("LLM 请求失败: " + err.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("LLM 翻译超时（120s）"));
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * MyMemory 翻译 API（免费，无需 API Key）
 */
function myMemoryTranslate(text, from, to) {
  return new Promise((resolve, reject) => {
    // MyMemory 单次最多 500 字符，需要分段
    const segments = splitForMyMemory(text, 500);
    const results = [];
    let completed = 0;

    if (segments.length === 0) {
      resolve(text);
      return;
    }

    const processNext = (index) => {
      if (index >= segments.length) {
        resolve(results.join(""));
        return;
      }

      const seg = segments[index];
      if (!seg.translatable) {
        results[index] = seg.text;
        processNext(index + 1);
        return;
      }

      const langPair = `${from}|${to === "zh-CN" ? "zh" : to}`;
      const params = new URLSearchParams({
        q: seg.text,
        langpair: langPair,
      });

      const url = `https://api.mymemory.translated.net/get?${params.toString()}`;

      https
        .get(url, { timeout: 10000 }, (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            try {
              const json = JSON.parse(data);
              if (json.responseStatus === 200 && json.responseData) {
                results[index] = json.responseData.translatedText;
              } else {
                results[index] = seg.text; // fallback to original
              }
            } catch (e) {
              results[index] = seg.text;
            }
            // 延时避免频率限制
            setTimeout(() => processNext(index + 1), 300);
          });
        })
        .on("error", (err) => {
          reject(new Error("MyMemory 请求失败: " + err.message));
        })
        .on("timeout", function () {
          this.destroy();
          reject(new Error("MyMemory 请求超时"));
        });
    };

    processNext(0);
  });
}

/**
 * 将文本分段用于 MyMemory（保留 Markdown 代码块不翻译）
 */
function splitForMyMemory(text, maxLen) {
  const segments = [];
  // 将代码块与普通文本分开
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```")) {
      // 代码块不翻译
      segments.push({ text: part, translatable: false });
    } else if (part.trim()) {
      // 普通文本进一步按长度分段
      const lines = part.split("\n");
      let current = "";
      for (const line of lines) {
        if ((current + "\n" + line).length > maxLen && current) {
          segments.push({ text: current, translatable: true });
          current = line;
        } else {
          current = current ? current + "\n" + line : line;
        }
      }
      if (current) {
        segments.push({ text: current, translatable: true });
      }
    } else {
      segments.push({ text: part, translatable: false });
    }
  }

  return segments;
}

function googleTranslateChunk(text, from, to) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client: "gtx",
      sl: from,
      tl: to,
      dt: "t",
      q: text,
    });

    const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;

    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        timeout: 10000,
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json && json[0]) {
              const translated = json[0]
                .filter((item) => item && item[0])
                .map((item) => item[0])
                .join("");
              resolve(translated);
            } else {
              reject(new Error("翻译返回格式异常"));
            }
          } catch (e) {
            reject(new Error("解析翻译结果失败: " + e.message));
          }
        });
      },
    );

    req.on("error", (err) => {
      reject(new Error("请求翻译服务失败: " + err.message));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Google 翻译请求超时"));
    });
  });
}

// 主页
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * 扫描给定目录，递归查找包含 doc 子目录的文件夹
 * 找到 doc 目录后，以其相对于扫描根目录的父路径作为项目标识
 */
function scanForDocs(baseDir) {
  docRoots = {};
  if (!fs.existsSync(baseDir)) {
    console.warn(`扫描目录不存在: ${baseDir}`);
    return;
  }
  _recursiveScan(baseDir, baseDir, 0);
  console.log(`📂 扫描完成，发现 ${Object.keys(docRoots).length} 个文档项目:`, Object.keys(docRoots));
}

function _recursiveScan(dir, baseDir, depth) {
  // 限制递归深度，避免扫描过深
  if (depth > 5) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // 无权限访问的目录跳过
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.name === "doc" || entry.name === "docs") {
      // 找到 doc/docs 目录，以其相对父路径作为项目名
      const relativeParent = path.relative(baseDir, dir);
      const projectKey = relativeParent || path.basename(dir);
      if (!docRoots[projectKey]) {
        docRoots[projectKey] = fullPath;
      }
      // 找到 doc 后不再递归该目录的子目录
      continue;
    }

    // 继续递归搜索子目录
    _recursiveScan(fullPath, baseDir, depth + 1);
  }
}

/**
 * 构建某个 doc 目录的文件树
 * @param {string} docPath - doc 目录的绝对路径
 * @param {string} projectKey - 项目标识（相对路径）
 */
function buildDocTree(docPath, projectKey) {
  const children = _buildTreeRecursive(docPath, projectKey);
  // 显示名：取最后一段路径作为名称
  const displayName = projectKey.includes("/") ? projectKey : projectKey;
  return {
    name: displayName,
    type: "folder",
    path: projectKey,
    children,
  };
}

function _buildTreeRecursive(dirPath, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = prefix + "/" + entry.name;

    if (entry.isDirectory()) {
      const children = _buildTreeRecursive(fullPath, relativePath);
      if (children.length > 0) {
        items.push({
          name: entry.name,
          type: "folder",
          path: relativePath,
          children,
        });
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      items.push({
        name: entry.name.replace(/\.md$/, ""),
        type: "file",
        path: relativePath,
      });
    }
  }

  // 文件夹排前面，再按名称排序
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });

  return items;
}

/**
 * 在某个 doc 目录中递归搜索文件内容
 */
function searchFiles(docPath, projectName, query, results) {
  _searchRecursive(docPath, projectName, query, results);
}

function _searchRecursive(dirPath, prefix, query, results) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = prefix + "/" + entry.name;

    if (entry.isDirectory()) {
      _searchRecursive(fullPath, relativePath, query, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lowerContent = content.toLowerCase();
      const index = lowerContent.indexOf(query);

      if (index !== -1) {
        const start = Math.max(0, index - 50);
        const end = Math.min(content.length, index + query.length + 50);
        const snippet =
          (start > 0 ? "..." : "") +
          content.substring(start, end) +
          (end < content.length ? "..." : "");

        results.push({
          path: relativePath,
          name: entry.name.replace(/\.md$/, ""),
          project: prefix.split("/")[0],
          snippet: snippet.replace(/\n/g, " "),
        });
      }
    }
  }
}

app.listen(PORT, () => {
  console.log(`📖 Doc Reader 启动成功！`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   扫描目录: ${scanDir}`);
  console.log(`   文档项目: ${Object.keys(docRoots).join(", ") || "无"}`);
});
