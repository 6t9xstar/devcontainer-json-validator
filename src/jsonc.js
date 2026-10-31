// A small JSONC (JSON with comments and trailing commas) parser that records
// the line of every property so findings can point at the exact location.

export class JsoncError extends Error {
  constructor(message, line, column) {
    super(`${message} (line ${line}, column ${column})`);
    this.line = line;
    this.column = column;
  }
}

/**
 * @returns {{value: any, lines: Map<string, number>, duplicates: {path: string, line: number}[]}}
 * `lines` maps a JSON pointer-like path ("features/ghcr.io~1x", "forwardPorts/0") to a 1-based line.
 */
export function parseJsonc(text) {
  let i = 0;
  let line = 1;
  let col = 1;
  const lines = new Map();
  const duplicates = [];
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const fail = (msg) => {
    throw new JsoncError(msg, line, col);
  };
  const advance = () => {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else col++;
    i++;
  };
  const skip = () => {
    for (;;) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') advance();
      else if (ch === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') advance();
      else if (ch === '/' && text[i + 1] === '*') {
        advance();
        advance();
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) advance();
        if (i >= text.length) fail('Unterminated block comment');
        advance();
        advance();
      } else return;
    }
  };

  const parseString = () => {
    advance(); // opening quote
    let out = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        advance();
        return out;
      }
      if (ch === '\n') fail('Unterminated string');
      if (ch === '\\') {
        advance();
        const esc = text[i];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc in map) {
          out += map[esc];
          advance();
        } else if (esc === 'u') {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Invalid unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          for (let k = 0; k < 5; k++) advance();
        } else fail(`Invalid escape "\\${esc}"`);
        continue;
      }
      out += ch;
      advance();
    }
    fail('Unterminated string');
  };

  const parseValue = (path) => {
    skip();
    const ch = text[i];
    if (ch === '{') return parseObject(path);
    if (ch === '[') return parseArray(path);
    if (ch === '"') return parseString();
    const m = text.slice(i).match(/^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
    if (!m) fail(i >= text.length ? 'Unexpected end of file' : `Unexpected character "${ch}"`);
    for (let k = 0; k < m[0].length; k++) advance();
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    if (m[0] === 'null') return null;
    return Number(m[0]);
  };

  const parseObject = (path) => {
    advance();
    const obj = {};
    skip();
    if (text[i] === '}') {
      advance();
      return obj;
    }
    for (;;) {
      skip();
      if (text[i] === '}') {
        advance(); // trailing comma
        return obj;
      }
      if (text[i] !== '"') fail('Expected a property name in double quotes');
      const keyLine = line;
      const key = parseString();
      const childPath = path === '' ? escapeKey(key) : `${path}/${escapeKey(key)}`;
      if (Object.prototype.hasOwnProperty.call(obj, key)) duplicates.push({ path: childPath, line: keyLine });
      lines.set(childPath, keyLine);
      skip();
      if (text[i] !== ':') fail(`Expected ":" after "${key}"`);
      advance();
      obj[key] = parseValue(childPath);
      skip();
      if (text[i] === ',') {
        advance();
        continue;
      }
      if (text[i] === '}') {
        advance();
        return obj;
      }
      fail('Expected "," or "}"');
    }
  };

  const parseArray = (path) => {
    advance();
    const arr = [];
    for (;;) {
      skip();
      if (text[i] === ']') {
        advance();
        return arr;
      }
      const childPath = `${path}/${arr.length}`;
      lines.set(childPath.replace(/^\//, ''), line);
      arr.push(parseValue(childPath.replace(/^\//, '')));
      skip();
      if (text[i] === ',') {
        advance();
        continue;
      }
      if (text[i] === ']') {
        advance();
        return arr;
      }
      fail('Expected "," or "]"');
    }
  };

  const value = parseValue('');
  skip();
  if (i < text.length) fail('Unexpected content after the end of the document');
  return { value, lines, duplicates };
}

export function escapeKey(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Line of the closest known ancestor of a path. */
export function lineOf(lines, path) {
  let p = path;
  for (;;) {
    if (lines.has(p)) return lines.get(p);
    const cut = p.lastIndexOf('/');
    if (cut === -1) return 1;
    p = p.slice(0, cut);
  }
}
