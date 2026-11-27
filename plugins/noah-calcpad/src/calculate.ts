import Decimal from "decimal.js";

const NumberValue = Decimal.clone({ precision: 34, maxE: 10_000, minE: -10_000 });
const tokenPattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|@[1-9]\d*|[a-z_]\w*|[+\-*/^()%=,]/iy;
const precedence = new Map([["+", 1], ["-", 1], ["*", 2], ["/", 2], ["^", 3], ["%", 4]]);
const functions = new Map<string, { arity: number; run: (values: Decimal[]) => Decimal }>([
  ["sqrt", { arity: 1, run: ([x]) => x.sqrt() }],
  ["abs", { arity: 1, run: ([x]) => x.abs() }],
  ["round", { arity: 1, run: ([x]) => x.round() }],
  ["floor", { arity: 1, run: ([x]) => x.floor() }],
  ["ceil", { arity: 1, run: ([x]) => x.ceil() }],
  ["min", { arity: 2, run: ([x, y]) => NumberValue.min(x, y) }],
  ["max", { arity: 2, run: ([x, y]) => NumberValue.max(x, y) }],
  ["mod", { arity: 2, run: ([x, y]) => x.mod(y) }],
]);

export type Row = {
  line: number;
  formula: string;
  note: string;
  value?: string;
  error?: string;
};

type Scope = {
  values: Map<string, Decimal>;
  lines: Map<string, Decimal>;
  answer?: Decimal;
};

function tokenize(source: string): string[] {
  const text = source.normalize("NFKC").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const tokens: string[] = [];
  for (let cursor = 0; cursor < text.length; ) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(text);
    if (!match) throw new Error("无法识别字符「" + text[cursor] + "」。");
    if (match[0].trim()) tokens.push(match[0]);
    cursor = tokenPattern.lastIndex;
  }
  return tokens;
}

function checked(value: Decimal): Decimal {
  if (value.isNaN()) throw new Error("这个算式没有实数结果。");
  if (!value.isFinite()) throw new Error("结果超出范围。");
  return value;
}

class Parser {
  private index = 0;

  constructor(private tokens: string[], private scope: Scope) {}

  private peek() {
    return this.tokens[this.index];
  }

  private need(expected: string) {
    if (this.peek() !== expected) throw new Error("缺少「" + expected + "」。");
    this.index++;
  }

  private operand(): Decimal {
    const token = this.tokens[this.index++];
    if (!token) throw new Error("算式未完成。");
    if (token === "+" || token === "-") {
      const value = this.expression(3);
      return token === "-" ? value.negated() : value;
    }
    if (token === "(") {
      const value = this.expression(1);
      this.need(")");
      return value;
    }
    if (/^[\d.]/.test(token)) return checked(new NumberValue(token).toSignificantDigits(34));
    if (token.startsWith("@")) {
      const value = this.scope.lines.get(token.slice(1));
      if (!value) throw new Error(token + " 必须引用前面一行的有效结果。");
      return value;
    }
    if (/^[a-z_]/i.test(token)) {
      if (this.peek() === "(") return this.call(token);
      const value = token === "ans" ? this.scope.answer : this.scope.values.get(token);
      if (!value) throw new Error("「" + token + "」还没有可用的值。");
      return value;
    }
    throw new Error("这里需要数字、变量或括号。");
  }

  private call(name: string): Decimal {
    const fn = functions.get(name);
    if (!fn) throw new Error("未知函数「" + name + "」。");
    this.need("(");
    const values = [this.expression(1)];
    if (fn.arity === 2) {
      this.need(",");
      values.push(this.expression(1));
    }
    this.need(")");
    if (name === "mod" && values[1].isZero()) throw new Error("除数不能为零。");
    return checked(fn.run(values));
  }

  private expression(minimum: number): Decimal {
    let left = this.operand();
    for (;;) {
      const operator = this.peek();
      const level = precedence.get(operator) ?? 0;
      if (level < minimum) return left;
      this.index++;
      if (operator === "%") {
        left = left.dividedBy(100);
      } else {
        const right = this.expression(operator === "^" ? level : level + 1);
        left = this.combine(left, operator, right);
      }
    }
  }

  private combine(left: Decimal, operator: string, right: Decimal): Decimal {
    switch (operator) {
      case "+": return checked(left.plus(right));
      case "-": return checked(left.minus(right));
      case "*": return checked(left.times(right));
      case "/":
        if (right.isZero()) throw new Error("除数不能为零。");
        return checked(left.dividedBy(right));
      case "^":
        if (right.abs().gt(10_000)) throw new Error("乘方指数的绝对值最多为 10,000。");
        return checked(left.pow(right));
      default: throw new Error("未知运算符。");
    }
  }

  parse(): Decimal {
    const value = this.expression(1);
    if (this.peek() !== undefined) throw new Error("多余的内容「" + this.peek() + "」。");
    return value;
  }
}

export function calculateSheet(source: string): Row[] {
  const scope: Scope = { values: new Map(), lines: new Map() };
  const rows: Row[] = [];
  const lines = source.split(/\r\n|\n|\r/);
  for (const [index, input] of lines.entries()) {
    const line = index + 1;
    const marker = input.search(/[#＃]/);
    const formula = (marker === -1 ? input : input.slice(0, marker)).trim();
    const note = marker === -1 ? "" : input.slice(marker + 1).trim();
    if (!formula && !note) continue;
    const row: Row = { line, formula, note };
    rows.push(row);
    if (!formula) continue;

    try {
      if (formula.length > 350) throw new Error("单行算式最多 350 个字符。");
      const tokens = tokenize(formula);
      const name = tokens[1] === "=" ? tokens[0] : undefined;
      if (name && (!/^[a-z_]\w*$/i.test(name) || name === "ans" || functions.has(name))) {
        throw new Error("变量名必须以字母或下划线开头，且不能是保留名称。");
      }
      const value = new Parser(name ? tokens.slice(2) : tokens, scope).parse();
      if (name) scope.values.set(name, value);
      scope.answer = value;
      scope.lines.set(String(line), value);
      row.value = value.toString();
    } catch (error) {
      row.error = error instanceof Error ? error.message : "无法计算此行。";
    }
  }
  return rows;
}
