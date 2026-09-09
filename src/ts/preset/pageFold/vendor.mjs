// Adapted from user-provided PageFold 0.2.4. Original implementation retained.
const PDF_NEWLINE_MARKER_DIRECTIVE = "Inside the PDF text layer, every real line break is serialized as a literal \\n marker. Treat each \\n marker as one line break, and use real line breaks when responding.";
  function serializeTranscript(promptChat) {
    const messages = Array.isArray(promptChat) ? promptChat : [];
    return messages.map((message, index) => {
      const role = String(message?.role || "user").toUpperCase();
      const content = String(message?.content || "");
      return `===== ${role} ${index + 1} =====
${content}`;
    }).join("\n\n");
  }
  function mergeConsecutiveRoleMessages(messages) {
    const merged = [];
    for (const message of messages) {
      const role = String(message?.role || "user");
      const content = String(message?.content || "");
      const previous = merged.at(-1);
      if ((role === "system" || role === "user") && previous && previous.role === role) {
        previous.content = previous.content ? `${previous.content}

${content}` : content;
        continue;
      }
      merged.push({ role, content });
    }
    return merged;
  }
  function packagePrompt(promptChat, mode = "maximum", options = {}) {
    const source = Array.isArray(promptChat) ? promptChat : [];
    const messages = options.mergeConsecutiveRoles === true ? mergeConsecutiveRoleMessages(source) : source;
    const baselineText = messages.map((message) => String(message?.content || "")).join("\n");
    if (mode === "balanced") {
      const systemText = messages.filter((message) => message?.role === "system").map((message) => String(message?.content || "")).join("\n\n");
      const pdfMessages = messages.filter((message) => message?.role !== "system");
      return {
        mode,
        baselineText,
        pdfTranscript: serializeTranscript(pdfMessages),
        systemText: systemText ? `Use the attached PDF as the ordered conversation context and produce the next ASSISTANT response that follows from the full sequence. ${PDF_NEWLINE_MARKER_DIRECTIVE}

Follow the system instructions below.

${systemText}` : `Use the attached PDF as the ordered conversation context and produce the next ASSISTANT response that follows from the full sequence. ${PDF_NEWLINE_MARKER_DIRECTIVE}`,
        userText: ""
      };
    }
    return {
      mode: "maximum",
      baselineText,
      pdfTranscript: serializeTranscript(messages),
      systemText: [
        "The attached PDF contains the complete ordered prompt and conversation transcript.",
        "Interpret every section according to its role, follow all applicable SYSTEM and USER instructions, and produce the next ASSISTANT response that follows from the full sequence.",
        PDF_NEWLINE_MARKER_DIRECTIVE
      ].join(" "),
      userText: ""
    };
  }
  function estimateTextTokens(text) {
    const value = String(text || "");
    let cjk = 0;
    let other = 0;
    for (const char of value) {
      if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
      else other += 1;
    }
    return Math.ceil(cjk * 1.05 + other / 4);
  }
  function calculateSavings({ baselineTokens, optimizedTokens, inputPrice }) {
    const baseline = Math.max(0, Number(baselineTokens) || 0);
    const optimized = Math.max(0, Number(optimizedTokens) || 0);
    const savedTokens = Math.max(0, baseline - optimized);
    return {
      baselineTokens: baseline,
      optimizedTokens: optimized,
      savedTokens,
      savedUsd: savedTokens / 1e6 * Math.max(0, Number(inputPrice) || 0),
      reductionRate: baseline > 0 ? savedTokens / baseline : 0
    };
  }
  var PROTECTED_RESPONSE_REGION = /(`{3,}[\s\S]*?`{3,}|`{3,}[\s\S]*$|`[^`\n\r]*`)/g;
  function restoreResponseNewlines(value) {
    const source = String(value ?? "");
    if (!source.includes("\\")) return source;
    const segments = [];
    let cursor = 0;
    for (const match of source.matchAll(PROTECTED_RESPONSE_REGION)) {
      if (match.index > cursor) segments.push({ protect: false, text: source.slice(cursor, match.index) });
      segments.push({ protect: true, text: match[0] });
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) segments.push({ protect: false, text: source.slice(cursor) });
    return segments.map((segment) => segment.protect ? segment.text : segment.text.replaceAll(/(?<!\\)\\r\\n/gu, "\n").replaceAll(/(?<!\\)\\n/gu, "\n")).join("");
  }
  // src/pdf.js
  var PAGE_WIDTH = 595.28;
  var PAGE_HEIGHT = 841.89;
  var DEFAULT_FONT_SIZE = 1;
  var DEFAULT_MARGIN = 0;
  var GLYPH_WIDTH = 0.5;
  var encoder = new TextEncoder();
  function bytes(value) {
    return encoder.encode(value);
  }
  function concat(chunks) {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  function pdfNumber(value) {
    return Number(value.toFixed(6)).toString();
  }
  function calculatePageGrid(fontSize, margin) {
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      throw new RangeError("fontSize must be a positive finite number");
    }
    if (!Number.isFinite(margin) || margin < 0) {
      throw new RangeError("margin must be a non-negative finite number");
    }
    const columns = Math.floor((PAGE_WIDTH - margin * 2) / (fontSize * GLYPH_WIDTH));
    const rows = Math.floor((PAGE_HEIGHT - margin * 2) / fontSize);
    if (columns < 1 || rows < 1) {
      throw new RangeError("fontSize and margin leave no usable page area");
    }
    return { columns, rows };
  }
  function hex(value) {
    return value.toString(16).toUpperCase().padStart(4, "0");
  }
  function unicodeHex(value) {
    return Array.from(value, (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 65535) return hex(codePoint);
      const supplementary = codePoint - 65536;
      return hex(55296 + (supplementary >> 10)) + hex(56320 + (supplementary & 1023));
    }).join("");
  }
  function wrapText(text, columns) {
    const lines = [];
    for (const hardLine of String(text || "").replaceAll(/\r\n?/g, "\n").split("\n")) {
      const characters = Array.from(hardLine);
      if (characters.length === 0) {
        lines.push("");
        continue;
      }
      for (let index = 0; index < characters.length; index += columns) {
        lines.push(characters.slice(index, index + columns).join(""));
      }
    }
    return lines.map((line) => Array.from(line));
  }
  function escapeTranscriptNewlines(value) {
    return String(value || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\\n");
  }
  function isRtlCharacter(character) {
    const codePoint = character.codePointAt(0);
    return codePoint >= 1424 && codePoint <= 2303 || codePoint >= 64285 && codePoint <= 65023 || codePoint >= 65136 && codePoint <= 65279 || codePoint >= 67584 && codePoint <= 69631 || codePoint >= 124928 && codePoint <= 126975;
  }
  function visualOrder(line) {
    const clusters = [];
    for (const character of line) {
      if (/\p{Mark}/u.test(character) && clusters.length > 0) clusters.at(-1).push(character);
      else clusters.push([character]);
    }
    const visual = [];
    for (let index = 0; index < clusters.length; ) {
      if (!isRtlCharacter(clusters[index][0])) {
        visual.push(...clusters[index]);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < clusters.length && isRtlCharacter(clusters[end][0])) end += 1;
      for (let cursor = end - 1; cursor >= index; cursor -= 1) visual.push(...clusters[cursor]);
      index = end;
    }
    return visual;
  }
  function createCharacterMap(lines) {
    const characters = /* @__PURE__ */ new Map();
    for (const line of lines) {
      for (const character of line) {
        if (characters.has(character)) continue;
        if (characters.size === 65535) {
          throw new RangeError("A PDF can contain at most 65,535 distinct characters");
        }
        characters.set(character, characters.size + 1);
      }
    }
    return characters;
  }
  function createToUnicodeCMap(characters) {
    const entries = Array.from(characters, ([character, cid]) => `<${hex(cid)}><${unicodeHex(character)}>`);
    const mappings = [];
    for (let index = 0; index < entries.length; index += 100) {
      const chunk = entries.slice(index, index + 100);
      mappings.push(`${chunk.length} beginbfchar
${chunk.join("\n")}
endbfchar`);
    }
    return bytes([
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /PMUnicode-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000><FFFF>",
      "endcodespacerange",
      ...mappings,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end"
    ].join("\n"));
  }
  function createPageContent(lines, characters, fontSize, margin) {
    const commands = [
      "BT",
      `/F0 ${pdfNumber(fontSize)} Tf`,
      `${pdfNumber(fontSize)} TL`,
      `1 0 0 1 ${pdfNumber(margin)} ${pdfNumber(PAGE_HEIGHT - margin - fontSize)} Tm`
    ];
    for (const [index, line] of lines.entries()) {
      const encoded = visualOrder(line).map((character) => hex(characters.get(character))).join("");
      commands.push(`<${encoded}> Tj`);
      if (index < lines.length - 1) commands.push("T*");
    }
    commands.push("ET");
    return bytes(commands.join("\n"));
  }
  async function streamObject(data) {
    const compressed = new Uint8Array(await new Response(
      new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))
    ).arrayBuffer());
    return concat([
      bytes(`<< /Length ${compressed.length} /Filter /FlateDecode >>
stream
`),
      compressed,
      bytes("\nendstream")
    ]);
  }
  function serialize(objects) {
    const chunks = [concat([bytes("%PDF-1.7\n%"), new Uint8Array([255, 255, 255, 255]), bytes("\n")])];
    const offsets = [0];
    let length = chunks[0].length;
    for (const [index, object] of objects.entries()) {
      offsets.push(length);
      const serialized = concat([bytes(`${index + 1} 0 obj
`), object, bytes("\nendobj\n")]);
      chunks.push(serialized);
      length += serialized.length;
    }
    const xrefOffset = length;
    chunks.push(bytes([
      `xref
0 ${objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
      "trailer",
      `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF"
    ].join("\n")));
    return concat(chunks);
  }
  async function generateTranscriptPdf(transcript, options = {}) {
    const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    const margin = options.margin ?? DEFAULT_MARGIN;
    const { columns, rows } = calculatePageGrid(fontSize, margin);
    const lines = wrapText(escapeTranscriptNewlines(transcript), columns);
    const pages = [];
    for (let index = 0; index < lines.length; index += rows) {
      pages.push(lines.slice(index, index + rows));
    }
    const characters = createCharacterMap(lines);
    const firstPageObject = 7;
    const pageIds = pages.map((_, index) => firstPageObject + index * 2);
    const objects = [
      bytes("<< /Type /Catalog /Pages 2 0 R >>"),
      bytes(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F0 3 0 R >> >> >>`),
      bytes("<< /Type /Font /Subtype /Type0 /BaseFont /PMUnicode /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>"),
      bytes("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /PMUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 500 /CIDToGIDMap /Identity >>"),
      bytes("<< /Type /FontDescriptor /FontName /PMUnicode /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 500 >>"),
      await streamObject(createToUnicodeCMap(characters))
    ];
    for (const [index, page] of pages.entries()) {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      objects.push(
        bytes(`<< /Type /Page /Parent 2 0 R /Contents ${contentId} 0 R >>`),
        await streamObject(createPageContent(page, characters, fontSize, margin))
      );
    }
    const pdf = serialize(objects);
    return {
      bytes: pdf,
      base64: base64(pdf),
      pageCount: pages.length,
      sourceCharacters: String(transcript || "").length,
      fontSize,
      lineHeight: fontSize,
      columnCount: 1
    };
  }
  function base64(value) {
    let binary = "";
    const chunkSize = 32768;
    for (let offset = 0; offset < value.length; offset += chunkSize) {
      binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function createStreamingNewlineRestorer() {
    let mode = "plain";
    let buffer = "";
    let lastPlainCharacter = "";
    const process = (final = false) => {
      let output = "";
      while (buffer) {
        if (mode === "plain") {
          if (buffer[0] === "`") {
            let run2 = 1;
            while (buffer[run2] === "`") run2 += 1;
            if (!final && run2 === buffer.length) break;
            output += buffer.slice(0, run2);
            buffer = buffer.slice(run2);
            lastPlainCharacter = "";
            if (run2 >= 3) mode = "fence";
            else if (run2 === 1) mode = "inline";
            continue;
          }
          if (buffer[0] === "\\") {
            if (!final && buffer.length < 2) break;
            if (buffer.startsWith("\\n") && lastPlainCharacter !== "\\") {
              output += "\n";
              buffer = buffer.slice(2);
              lastPlainCharacter = "\n";
              continue;
            }
            if (buffer.startsWith("\\r")) {
              if (!final && buffer.length < 4 && "\\r\\n".startsWith(buffer)) break;
              if (buffer.startsWith("\\r\\n") && lastPlainCharacter !== "\\") {
                output += "\n";
                buffer = buffer.slice(4);
                lastPlainCharacter = "\n";
                continue;
              }
            }
          }
          output += buffer[0];
          lastPlainCharacter = buffer[0];
          buffer = buffer.slice(1);
          continue;
        }
        if (buffer[0] !== "`") {
          output += buffer[0];
          buffer = buffer.slice(1);
          continue;
        }
        let run = 1;
        while (buffer[run] === "`") run += 1;
        if (!final && run === buffer.length) break;
        output += buffer.slice(0, run);
        buffer = buffer.slice(run);
        if (mode === "fence" && run >= 3 || mode === "inline" && run >= 1) {
          mode = "plain";
          lastPlainCharacter = "";
        }
      }
      return output;
    };
    return {
      push(value) {
        buffer += String(value ?? "");
        return process(false);
      },
      flush() {
        return process(true);
      }
    };
  }

export { generateTranscriptPdf, packagePrompt, estimateTextTokens, restoreResponseNewlines, createStreamingNewlineRestorer };
