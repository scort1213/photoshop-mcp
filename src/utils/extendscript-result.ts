/** Parse legacy toSource data without evaluating JavaScript. */
export function parseExtendScriptPayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    /* Legacy syntax. */
  }
  if (!/^[([{]/.test(text)) return text;
  let pos = 0;
  const ws = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };
  const fail = (): never => {
    throw new Error('invalid_data');
  };
  const string = (): string => {
    const quote = text[pos++];
    let value = '';
    while (pos < text.length) {
      let c = text[pos++];
      if (c === quote) return value;
      if (c === '\\') {
        c = text[pos++];
        const escapes: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          b: '\b',
          f: '\f',
          v: '\v',
          '0': '\0',
          '\\': '\\',
          '"': '"',
          "'": "'",
        };
        if (c === 'u' || c === 'x') {
          const count = c === 'u' ? 4 : 2;
          const hex = text.slice(pos, pos + count);
          if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) fail();
          value += String.fromCharCode(parseInt(hex, 16));
          pos += count;
        } else if (c in escapes) value += escapes[c];
        else fail();
      } else {
        if (c < ' ') fail();
        value += c;
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 100) fail();
    ws();
    const c = text[pos];
    if (c === '"' || c === "'") return string();
    if (c === '(') {
      pos++;
      const v = value(depth + 1);
      ws();
      if (text[pos++] !== ')') fail();
      return v;
    }
    if (c === '[' || c === '{') {
      pos++;
      const end = c === '[' ? ']' : '}';
      const array: unknown[] = [];
      const object: Record<string, unknown> = {};
      ws();
      while (text[pos] !== end) {
        if (c === '[') array.push(value(depth + 1));
        else {
          ws();
          let key: string;
          if (text[pos] === '"' || text[pos] === "'") key = string();
          else {
            const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(pos));
            if (!match) return fail();
            key = match[0];
            pos += key.length;
          }
          ws();
          if (text[pos++] !== ':') fail();
          Object.defineProperty(object, key, {
            value: value(depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        ws();
        if (text[pos] === end) break;
        if (text[pos++] !== ',') fail();
        ws();
      }
      pos++;
      return c === '[' ? array : object;
    }
    const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(pos));
    if (number) {
      pos += number[0].length;
      return Number(number[0]);
    }
    for (const [token, v] of [
      ['true', true],
      ['false', false],
      ['null', null],
      ['undefined', undefined],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
    ] as const) {
      if (text.startsWith(token, pos)) {
        pos += token.length;
        return v;
      }
    }
    return fail();
  };
  try {
    const result = value(0);
    ws();
    return pos === text.length ? result : text;
  } catch {
    return text;
  }
}
