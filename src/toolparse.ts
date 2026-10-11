// ---------------------------------------------------------------------------
// DSML / tool-call parsing — точный порт FreeDeepseekAPI/server.js.
// Строгая структурная валидация тегов вместо «сырых» регулярок.
//
// ВАЖНО (окружение): конвейер аргументов декодирует HTML-сущности, поэтому
// амперсанд в исходнике не пишем буквально — собираем его из кода 38.
// ---------------------------------------------------------------------------

import { mylogDebug } from "./logger.js";

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface StructuralTag {
  name: string;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
  invalid?: boolean;
}

const AMP = String.fromCharCode(38);
const ENT_QUOT = AMP + "quot;";
const ENT_APOS = AMP + "apos;";
const ENT_LT = AMP + "lt;";
const ENT_GT = AMP + "gt;";
const ENT_AMP = AMP + "amp;";

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

const debugEnabled = !!process.env.HORIZON_DEBUG_TOOLPARSE;
function debug(msg: string): void {
  if (debugEnabled) mylogDebug("[toolparse]", msg);
}

// --- balanced JSON ---------------------------------------------------------

function extractBalancedJsonAt(text: string, startIndex: number): string | null {
  if (text[startIndex] !== "{") return null;
  let braceDepth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (braceDepth === 0) return text.substring(startIndex, i + 1);
      }
    }
  }
  return null;
}

function extractBalancedJsonObjects(text: string, maxObjects = MAX_TOOL_JSON_CANDIDATES): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start === -1) {
      if (ch === "{") { start = i; depth = 1; inString = false; escape = false; }
      continue;
    }
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        objects.push(text.substring(start, i + 1));
        if (objects.length >= maxObjects) return objects;
        start = -1;
      }
    }
  }
  return objects;
}

// --- JSON control-character repair -----------------------------------------

/**
 * Ремонт невалидного JSON: модель иногда встраивает литеральные control-символы
 * (перевод строки, таб) прямо внутрь JSON-строк вместо экранированных
 * последовательностей. JSON.parse на таком падает с "Bad control character in
 * string literal". Экранируем только символы ВНУТРИ строк — вне строк
 * control-символы легальны как разделители структуры.
 */
function escapeControlInJsonStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      const c = s.charCodeAt(i);
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      if (c < 0x20) { out += "\\u" + c.toString(16).padStart(4, "0"); continue; }
    }
    out += ch;
  }
  return out;
}

// --- tool-call construction / coercion -------------------------------------

function buildToolCall(name: unknown, args: unknown = {}): ParsedToolCall | null {
  const toolName = typeof name === "string" ? name.trim() : "";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
  let parsedArgs = args;
  if (typeof parsedArgs === "string") {
    if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    try {
      parsedArgs = JSON.parse(parsedArgs);
    } catch {
      try { parsedArgs = JSON.parse(escapeControlInJsonStrings(parsedArgs as string)); } catch { return null; }
    }
  }
  if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
  if (typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) return null;
  let serialized: string;
  try { serialized = JSON.stringify(parsedArgs); } catch { return null; }
  if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
  return { name: toolName, args: parsedArgs as Record<string, unknown> };
}

function coerceToolCallObject(obj: unknown, opts: { allowBare?: boolean } = {}): ParsedToolCall | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  let candidate: unknown = null;
  if (Object.prototype.hasOwnProperty.call(o, "tool_call")) {
    candidate = o.tool_call;
  } else if (Object.prototype.hasOwnProperty.call(o, "function_call")) {
    candidate = o.function_call;
  } else if (Object.prototype.hasOwnProperty.call(o, "tool_calls")) {
    if (!Array.isArray(o.tool_calls) || o.tool_calls.length !== 1) return null;
    candidate = o.tool_calls[0];
  } else if (opts.allowBare) {
    candidate = o;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const c = candidate as Record<string, unknown>;
  const fn = c.function && typeof c.function === "object" ? (c.function as Record<string, unknown>) : c;
  return buildToolCall(
    fn.name ?? c.name,
    fn.arguments ?? c.arguments ?? c.input ?? {},
  );
}

function parseJsonToolCandidate(raw: string | null, label = "json", opts: { allowBare?: boolean } = {}): ParsedToolCall | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const tc = coerceToolCallObject(parsed, opts);
    if (tc) { debug(`SUCCESS ${label}: ${tc.name}`); return tc; }
  } catch (e) {
    // Модель иногда кладёт литеральные control-символы внутрь JSON-строк —
    // пробуем починить перед тем, как сдаться.
    try {
      const repaired = JSON.parse(escapeControlInJsonStrings(raw));
      const tc2 = coerceToolCallObject(repaired, opts);
      if (tc2) { debug(`SUCCESS ${label} (control-repair): ${tc2.name}`); return tc2; }
    } catch { /* keep original failure logged below */ }
    debug(`${label} JSON.parse failed: ${(e as Error).message.substring(0, 100)}`);
  }
  return null;
}

// --- DSML tag canonicalization / scanning ----------------------------------

function canonicalizeToolMarkupTag(rawTag: string): string | null {
  let token = String(rawTag || "").trim()
    .replace(/\uFF5C/g, "|")
    .replace(/[\u201C\u201D\uFF02]/g, '"')
    .replace(/[\u2018\u2019\uFF07]/g, "'");
  let closing = false;
  if (token.startsWith("/")) { closing = true; token = token.substring(1).trim(); }
  const afterBars = token.replace(/^\|+\s*DSML\s*\|+\s*/i, "");
  const hadDsml = afterBars !== token;
  token = afterBars;
  if (token.startsWith("/")) { closing = true; token = token.substring(1).trim(); }
  const afterPrefix = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter|calls)\b)/i, "");
  const hadDsmlPrefix = afterPrefix !== token;
  token = afterPrefix;

  // Bare "calls" is a tool-call keyword only after a DSML marker;
  // without that context the word is not markup.
  if (hadDsml || hadDsmlPrefix) {
    if (/^calls\b/i.test(token)) {
      return `<${closing ? "/" : ""}tool_calls${closing ? "" : token.substring(5)}>`;
    }
  }

  if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

  const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter|direct)\b([\s\S]*)$/i);
  if (!semantic) return null;
  const localName = semantic[1].replace(/[\s_-]/g, "").toLowerCase();
  const canonicalName = localName === "toolcalls" || localName === "functioncalls" ? "tool_calls" : localName;
  // Модель иногда пишет ОТКРЫВАЮЩИЙ тег со слэшем
  // (</｜｜DSML｜｜parameter name="command" string="true">…</｜｜DSML｜｜parameter>).
  // Настоящий закрывающий тег атрибутов не несёт, поэтому name=/string=
  // — признак опечатки открытия: канонизируем как ОТКРЫВАЮЩИЙ, иначе
  // `closing ? "" : semantic[2]` вырежет атрибуты и вызов потеряется.
  const mistypedOpen = closing && /(?:^|\s)(?:name|string)\s*=/i.test(semantic[2] || "");
  const attrs = (closing && !mistypedOpen) ? "" : semantic[2];
  return `<${closing && !mistypedOpen ? "/" : ""}${canonicalName}${attrs}>`;
}

export function normalizeToolMarkupTags(text: string): string {
  const withAsciiAngles = String(text || "").replace(/\uFF1C/g, "<").replace(/\uFF1E/g, ">");
  return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
    const canonical = canonicalizeToolMarkupTag(rawTag);
    return canonical || whole;
  });
}

export function decodeDsmlValue(value: unknown): string {
  return String(value ?? "")
    .split(ENT_QUOT).join('"')
    .split(ENT_APOS).join("'")
    .split(ENT_LT).join("<")
    .split(ENT_GT).join(">")
    .split(ENT_AMP).join(AMP);
}

export function decodeDsmlParameterValue(value: unknown): string {
  const raw = String(value ?? "");
  const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs: string, attribute: string): string | null {
  const match = String(attrs || "").match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, "i"));
  return match ? match[2] : null;
}

function readDsmlTagAt(text: string, start: number): StructuralTag | null {
  if (text[start] !== "<") return null;
  const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart();
  if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix)) return null;
  let quote: string | null = null;
  let end = -1;
  const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
  for (let i = start + 1; i < scanEnd; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") { end = i; break; }
  }
  if (end === -1) return { name: "", attrs: "", closing: false, selfClosing: false, start, end: start, invalid: true };

  let token = text.substring(start + 1, end).trim();
  let closing = false;
  if (token.startsWith("/")) { closing = true; token = token.substring(1).trim(); }
  let selfClosing = false;
  if (!closing && token.endsWith("/")) { selfClosing = true; token = token.substring(0, token.length - 1).trim(); }
  const match = token.match(/^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    attrs: closing ? "" : match[2],
    closing,
    selfClosing,
    start,
    end: end + 1,
  };
}

function scanDsmlStructuralTags(text: string): StructuralTag[] | null {
  const tags: StructuralTag[] = [];
  const value = String(text || "");
  for (let i = 0; i < value.length;) {
    if (value.substring(i, i + 9).toUpperCase() === "<![CDATA[") {
      const cdataEnd = value.indexOf("]]>", i + 9);
      if (cdataEnd === -1) return null;
      i = cdataEnd + 3;
      continue;
    }
    if (value[i] !== "<") { i++; continue; }
    const tag = readDsmlTagAt(value, i);
    if (!tag) { i++; continue; }
    if (tag.invalid) return null;
    tags.push(tag);
    if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
    i = tag.end;
  }
  return tags;
}

const LOOSE_JSON_FAILED = Symbol("looseJsonFailed");

/**
 * Парсит JSON-значение параметра DSML. Терпит один-два лишних закрывающих
 * `}` в конце (модель иногда дублирует скобку: `...,"timeoutSeconds":90}}`),
 * но не «лечит» произвольный мусор: лишние скобки срезаются только если после
 * среза строка становится валидным JSON.
 */
function parseLooseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch { /* try repair */ }
  let candidate = trimmed;
  for (let i = 0; i < 4 && candidate.endsWith("}"); i++) {
    candidate = candidate.slice(0, -1).trimEnd();
    try { return JSON.parse(candidate); } catch { /* keep trimming */ }
  }
  // Последняя попытка: литеральные control-символы внутри строк.
  try { return JSON.parse(escapeControlInJsonStrings(trimmed)); } catch { /* give up */ }
  return LOOSE_JSON_FAILED;
}

function parseDsmlParameter(attrs: string, rawBody: string, args: Record<string, unknown>, seenNames: Set<string>): boolean {
  const parameterName = getMarkupAttribute(attrs, "name");
  if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
  seenNames.add(parameterName);
  const stringMode = getMarkupAttribute(attrs, "string");
  const rawValue = decodeDsmlParameterValue(rawBody);
  if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
  let value: unknown = rawValue;
  if (stringMode && stringMode.toLowerCase() === "false") {
    const parsed = parseLooseJson(rawValue);
    if (parsed === LOOSE_JSON_FAILED) return false;
    value = parsed;
  }
  args[parameterName] = value;
  return true;
}

function parseDsmlInvoke(name: string | null, body: string): ParsedToolCall | null {
  const structuralTags = scanDsmlStructuralTags(body);
  if (!structuralTags) return null;
  const parameterTags = structuralTags.filter((tag) => tag.name === "parameter");
  if (structuralTags.some((tag) => tag.name !== "parameter")) return null;

  const args: Record<string, unknown> = {};
  let parameterCount = 0;
  const seenNames = new Set<string>();
  let cursor = 0;
  // Терпимый проход: пары opening/closing идём по порядку, но самозакрывающиеся
  // <parameter .../> (модель часто так пишет дубль name, когда имя уже в invoke)
  // просто пропускаем — они не несут значения. Это устраняет падение на
  // <parameter name="name" string="exec"/>.
  let idx = 0;
  while (idx < parameterTags.length) {
    const tag = parameterTags[idx];
    if (!tag) { idx++; continue; }
    if (tag.closing) { idx++; continue; }
    if (!tag.closing && tag.selfClosing) {
      // если между курсором и тегом только пробелы — съедаем тег целиком
      if (!body.substring(cursor, tag.start).trim()) cursor = tag.end;
      idx++; continue;
    }
    const closing = parameterTags[idx + 1];
    if (!closing || !closing.closing) return null;
    if (body.substring(cursor, tag.start).trim()) return null;
    parameterCount++;
    if (parameterCount > MAX_DSML_PARAMETERS) return null;
    if (!parseDsmlParameter(tag.attrs, body.substring(tag.end, closing.start), args, seenNames)) return null;
    cursor = closing.end;
    idx += 2;
  }

  let toolName = name;
  if (parameterCount > 0) {
    if (body.substring(cursor).trim()) return null;
    if (typeof args.name === "string") {
      if (!toolName) toolName = args.name;
      delete args.name;
    }
    // DSML-форма DeepSeek: <parameter name="arguments" string="false">{...}</parameter>
    // плюс отдельный <parameter name="name">. Разворачиваем единственный
    // объектный параметр arguments, иначе exec получает {"arguments":{...}}
    // и падает. Разворачиваем только объект (не строку/массив).
    if (args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)) {
      const inner = args.arguments as Record<string, unknown>;
      delete args.arguments;
      return buildToolCall(toolName, { ...inner, ...args });
    }
    return buildToolCall(toolName, args);
  }

  const decodedBody = decodeDsmlValue(body).trim();
  if (!decodedBody) return buildToolCall(name, {});
  const objects = extractBalancedJsonObjects(decodedBody, 2);
  if (objects.length !== 1 || decodedBody !== objects[0]) return null;
  try { return buildToolCall(name, JSON.parse(objects[0])); } catch { return null; }
}

function extractToolCallScope(normalized: string): string | null {
  const tags = scanDsmlStructuralTags(normalized);
  if (!tags) return null;
  const wrappers = tags.filter((tag) => tag.name === "tool_calls");
  const openings = wrappers.filter((tag) => !tag.closing);
  const closings = wrappers.filter((tag) => tag.closing);
  if (openings.length > 0) {
    if (openings.length !== 1 || openings[0].selfClosing || closings.length === 0) return null;
    const opening = openings[0];
    const closing = closings[closings.length - 1];
    if (wrappers.some((tag) => tag.closing && tag.start < opening.end) || closing.start < opening.end) return null;
    if (tags.some((tag) => tag.name !== "tool_calls" && (tag.start < opening.end || tag.start >= closing.start))) return null;
    return normalized.substring(opening.end, closing.start);
  }
  // Узкий ремонт: отсутствие открывающей обёртки допустимо только при наличии
  // закрывающей. Голый invoke без этого маркера не исполняется.
  if (closings.length > 0) {
    const closing = closings[closings.length - 1];
    const invokeOpenings = tags.filter((tag) => tag.name === "invoke" && !tag.closing && tag.start < closing.start);
    if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
      if (tags.some((tag) => tag.name !== "tool_calls" && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null;
      return normalized.substring(invokeOpenings[0].start, closing.start);
    }
  }
  return null;
}

export function looksLikeToolCallMarkup(text: string): boolean {
  return /TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|[\uFF5C|]+\s*DSML\s*[\uFF5C|]+|[\uFF1C<]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i.test(String(text || ""));
}

// --- DSML: single + plural --------------------------------------------------

export function parseDsmlToolCall(text: string): ParsedToolCall | null {
  if (String(text || "").length > MAX_TOOL_MARKUP_CHARS) return null;
  const normalized = normalizeToolMarkupTags(text);
  const scope = extractToolCallScope(normalized);
  if (scope === null) return null;
  const tags = scanDsmlStructuralTags(scope);
  if (!tags || tags.length === 0) return null;
  const first = tags[0];
  if (scope.substring(0, first.start).trim()) return null;

  if (first.name === "invoke" && !first.closing && !first.selfClosing) {
    const invokeTags = tags.filter((tag) => tag.name === "invoke");
    if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null;
    const closing = invokeTags[1];
    if (scope.substring(closing.end).trim()) return null;
    if (tags.some((tag) => tag.name === "tool_calls" || tag.name === "direct")) return null;
    const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, "name"), scope.substring(first.end, closing.start));
    if (parsed) { debug(`SUCCESS dsml: ${parsed.name}`); return parsed; }
  }

  if (first.name === "direct" && !first.closing && !first.selfClosing) {
    if (tags.some((tag, index) => index > 0 && (tag.name === "direct" || tag.name === "invoke" || tag.name === "tool_calls"))) return null;
    const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, "name"), scope.substring(first.end));
    if (parsed) { debug(`SUCCESS dsml-direct: ${parsed.name}`); return parsed; }
  }
  return null;
}

/** Спаривание одноимённых тегов в порядке появления. */
function pairTags(tags: StructuralTag[], tagName: string): Array<[StructuralTag, StructuralTag]> | null {
  const sel = tags.filter((tag) => tag.name === tagName);
  const pairs: Array<[StructuralTag, StructuralTag]> = [];
  for (let i = 0; i < sel.length; i += 2) {
    const opening = sel[i];
    const closing = sel[i + 1];
    if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null;
    pairs.push([opening, closing]);
  }
  return pairs;
}

/**
 * Все DSML-вызовы из ответа, в порядке появления.
 * Поддерживает N последовательных <invoke> или <direct> внутри обёртки
 * <tool_calls>; иначе — fallback на строгий одиночный разбор.
 */
export function parseToolCallAllDsml(text: string): ParsedToolCall[] {
  if (String(text || "").length > MAX_TOOL_MARKUP_CHARS) return [];
  const normalized = normalizeToolMarkupTags(text);
  const scope = extractToolCallScope(normalized);
  if (scope === null) {
    const single = parseDsmlToolCall(text);
    return single ? [single] : [];
  }
  const tags = scanDsmlStructuralTags(scope);
  if (!tags || tags.length === 0) return [];

  for (const tagName of ["invoke", "direct"] as const) {
    const hasTag = tags.some((tag) => tag.name === tagName);
    if (!hasTag) continue;
    const pairs = pairTags(tags, tagName);
    if (pairs && pairs.length > 0) {
      const result: ParsedToolCall[] = [];
      let cursor = 0;
      let ok = true;
      for (const [opening, closing] of pairs) {
        if (scope.substring(cursor, opening.start).trim()) { ok = false; break; }
        const parsed = parseDsmlInvoke(getMarkupAttribute(opening.attrs, "name"), scope.substring(opening.end, closing.start));
        if (!parsed) { ok = false; break; }
        result.push(parsed);
        cursor = closing.end;
      }
      if (ok && result.length > 0 && !scope.substring(cursor).trim()) return result;
      // Множественная ветка не сложилась — не теряем одиночный случай.
      const single = parseDsmlToolCall(text);
      return single ? [single] : [];
    }
  }

  const single = parseDsmlToolCall(text);
  return single ? [single] : [];
}

// --- non-DSML branches (plural-aware) --------------------------------------

function parseXmlToolCalls(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  const re = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1];
    let name = (inner.match(/<name>\s*([^<]+?)\s*<\/name>/) || [])[1]?.trim();
    if (!name) name = (m[0].match(/\bname\s*=\s*["']([^"']+)["']/) || [])[1]?.trim();
    let argsRaw: string | null = (inner.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/) || [])[1] ?? null;
    if (!name || argsRaw === null) {
      const innerJson = inner.match(/\{[\s\S]*\}/);
      if (innerJson) {
        try {
          const p = JSON.parse(innerJson[0]) as Record<string, unknown>;
          const tc = (p.tool_call as Record<string, unknown>) || p;
          name = name || (tc.name as string);
          if (argsRaw === null) {
            const a = tc.arguments;
            argsRaw = typeof a === "string" ? a : JSON.stringify(a ?? {});
          }
        } catch { /* skip */ }
      }
    }
    if (!name) continue;
    let args: Record<string, unknown> = {};
    if (argsRaw) {
      try { args = JSON.parse(argsRaw); }
      catch { try { args = JSON.parse(`{"value":${argsRaw}}`); } catch { args = { value: argsRaw }; } }
    }
    const tc = buildToolCall(name, args);
    if (tc) out.push(tc);
  }
  return out;
}

function parseFencedToolCalls(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fence: RegExpExecArray | null;
  while ((fence = fenceRe.exec(text)) !== null) {
    const body = fence[1].trim();
    const objMatch = body.match(/\{[\s\S]*\}/);
    const raw = objMatch ? objMatch[0] : body;
    const tc = parseJsonToolCandidate(raw, "fenced", { allowBare: true });
    if (tc) out.push(tc);
  }
  return out;
}

function parseLegacyToolCalls(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  const re = /TOOL_CALL:\s*([\w-]+)\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const after = text.substring(m.index + m[0].length);
    const braceIdx = after.indexOf("{");
    if (braceIdx === -1) continue;
    const rawJson = extractBalancedJsonAt(after, braceIdx);
    if (!rawJson) continue;
    try {
      const tc = buildToolCall(name, JSON.parse(rawJson));
      if (tc) out.push(tc);
    } catch { /* skip malformed */ }
  }
  return out;
}

function parseInlineJsonToolCalls(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  for (const rawJson of extractBalancedJsonObjects(text)) {
    const tc = parseJsonToolCandidate(rawJson, "inline");
    if (tc) out.push(tc);
  }
  return out;
}

/**
 * Универсальный разбор всех tool call в ответе (DSML → XML → fenced → legacy →
 * inline JSON), в порядке приоритета веток как в server.js.
 */
export function parseToolCallAll(text: string): ParsedToolCall[] {
  if (!text || typeof text !== "string") return [];
  if (text.length > MAX_TOOL_MARKUP_CHARS) { debug(`refusing oversized markup (${text.length})`); return []; }

  if (/[\uFF5C|]+\s*DSML\s*[\uFF5C|]+|[\uFF1C<]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(text)) {
    const dsml = parseToolCallAllDsml(text);
    if (dsml.length > 0) return dsml;
  }

  const xml = parseXmlToolCalls(text);
  if (xml.length > 0) return xml;

  const fenced = parseFencedToolCalls(text);
  if (fenced.length > 0) return fenced;

  const legacy = parseLegacyToolCalls(text);
  if (legacy.length > 0) return legacy;

  const inline = parseInlineJsonToolCalls(text);
  if (inline.length > 0) return inline;

  debug(`no tool call match in ${text.length} chars`);
  return [];
}

/** Первый вызов (совместимость со старым parseToolCall). */
export function parseToolCallStrict(text: string): ParsedToolCall | null {
  const all = parseToolCallAll(text);
  return all.length > 0 ? all[0] : null;
}
