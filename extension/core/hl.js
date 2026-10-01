// MdReader syntax highlighter (shared by the app and the extension).
// Small rule-based tokenizer: each language is an ordered list of [sticky regex, token class]; at every position the
// first rule that matches wins, and anything unmatched is consumed as one identifier / whitespace run / character so a
// keyword can never match in the middle of a word. Output is escaped HTML with <span class="tk-…"> per token, one
// <span class="line"> per source line (so a gutter of line numbers can be drawn with CSS counters and copied text stays
// clean). Token classes: k keyword · t type/builtin · f function · s string · n number · c comment · a attribute/key ·
// v variable/identifier · o operator · p punctuation · d diff-added · x diff-removed · h heading/meta.
(function (global) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rx = (src, flags = '') => new RegExp(src, flags.includes('y') ? flags : flags + 'y');
  const kw = (list, flags = '') => rx('\\b(?:' + list.trim().split(/\s+/).join('|') + ')\\b', flags);

  const LINE_COMMENT = rx('//[^\\n]*');
  const HASH_COMMENT = rx('#[^\\n]*');
  const BLOCK_COMMENT = rx('/\\*[\\s\\S]*?(?:\\*/|$)');
  const DQ = rx('"(?:[^"\\\\\\n]|\\\\.)*"?');
  const SQ = rx("'(?:[^'\\\\\\n]|\\\\.)*'?");
  const TPL = rx('`(?:[^`\\\\]|\\\\.)*`?');
  const NUM = rx('(?<![\\w.])(?:0x[0-9a-f]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b', 'i');
  const FN = rx('\\b[A-Za-z_$][\\w$]*(?=\\s*\\()');
  const OP = rx('(?:=>|->|::|<=>|<>|!=|==|===|!==|<=|>=|\\|\\||&&|\\|>|[-+*/%<>=!&|^~?])');
  const PUNCT = rx('[()\\[\\]{},;.:]');
  const FALL = /[A-Za-z_$][\w$]*|[ \t]+|\n|./y;

  const langs = {};
  const def = (names, rules) => names.split(/\s+/).forEach((n) => { langs[n] = { name: names.split(/\s+/)[0], rules }; });

  def('sql athena presto trino hive mysql postgres postgresql psql sqlite', [
    [rx('--[^\\n]*'), 'c'], [BLOCK_COMMENT, 'c'], [SQ, 's'], [rx('"(?:[^"\\\\\\n]|\\\\.)*"?'), 'v'], [rx('`[^`\\n]*`?'), 'v'],
    [NUM, 'n'],
    [kw(`select from where and or not in is null as on join left right inner outer full cross group by order having
      limit offset with union all distinct case when then else end insert into values update set delete create table
      view drop alter add primary key foreign references index if exists between like ilike rlike regexp asc desc nulls
      first last over partition rows range unbounded preceding following current row window using natural lateral
      recursive except intersect fetch next only true false cast try_cast interval explain analyze unnest within filter
      external location stored partitioned tblproperties msck repair show describe grant revoke truncate merge matched
      temporary temp replace materialized schema database column constraint unique check default returning qualify
      pivot unpivot any some exclude escape collate cube rollup grouping sets tablesample`, 'i'), 'k'],
    [kw(`int integer bigint smallint tinyint varchar char string text boolean bool double float real decimal numeric date
      timestamp time datetime array map struct varbinary binary json uuid ipaddress hyperloglog current_date
      current_timestamp current_time localtime localtimestamp`, 'i'), 't'],
    [FN, 'f'], [OP, 'o'], [PUNCT, 'p'],
  ]);

  def('json json5 jsonc', [
    [LINE_COMMENT, 'c'], [BLOCK_COMMENT, 'c'],
    [rx('"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)'), 'a'], [DQ, 's'], [NUM, 'n'], [kw('true false null'), 'k'], [PUNCT, 'p'],
  ]);

  const JS_KW = `break case catch class const continue debugger default delete do else enum export extends finally for
    function if implements import in instanceof interface let new of package private protected public return static
    super switch throw try typeof var void while with yield async await from get set as declare namespace type readonly
    keyof abstract override satisfies`;
  def('javascript js jsx typescript ts tsx mjs cjs', [
    [LINE_COMMENT, 'c'], [BLOCK_COMMENT, 'c'], [DQ, 's'], [SQ, 's'], [TPL, 's'],
    [rx('/(?![/*])(?:\\\\.|\\[(?:\\\\.|[^\\]\\n])*\\]|[^/\\\\\\n])+/[gimsuyd]*(?=[\\s,;)\\].])'), 's'],
    [NUM, 'n'], [rx('@[A-Za-z_$][\\w$]*'), 'a'], [kw(JS_KW), 'k'],
    [kw('true false null undefined NaN Infinity this arguments'), 't'],
    [kw(`Array Object String Number Boolean Symbol Promise Map Set WeakMap WeakSet Date RegExp Error JSON Math console
      document window globalThis process require module exports`), 't'],
    [FN, 'f'], [OP, 'o'], [PUNCT, 'p'],
  ]);

  def('python py python3', [
    [HASH_COMMENT, 'c'], [rx('(?:[rbuf]{0,2})(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))', 'i'), 's'],
    [rx('(?:[rbuf]{0,2})"(?:[^"\\\\\\n]|\\\\.)*"?', 'i'), 's'], [rx("(?:[rbuf]{0,2})'(?:[^'\\\\\\n]|\\\\.)*'?", 'i'), 's'],
    [NUM, 'n'], [rx('@[\\w.]+'), 'a'],
    [kw(`and as assert async await break class continue def del elif else except finally for from global if import in is
      lambda nonlocal not or pass raise return try while with yield match case`), 'k'],
    [kw('True False None self cls'), 't'],
    [kw(`print len range str int float list dict set tuple bool type isinstance enumerate zip map filter sorted sum min max
      abs open input any all round repr hash id iter next super object bytes Exception ValueError KeyError TypeError`), 't'],
    [FN, 'f'], [OP, 'o'], [PUNCT, 'p'],
  ]);

  def('bash sh shell zsh console terminal shell-session', [
    [rx('^\\$ ', 'm'), 'h'], [rx('(?<![\\w$])#[^\\n]*'), 'c'], [DQ, 's'], [SQ, 's'],
    [rx('\\$\\{[^}\\n]*\\}|\\$\\(\\(|\\$\\(|\\$[A-Za-z_@#?!*$0-9][\\w]*'), 'v'],
    [rx('(?<=\\s|^)--?[A-Za-z][\\w-]*'), 'a'], [NUM, 'n'],
    [kw(`if then else elif fi for while until do done case esac in function select time coproc return exit break continue
      local export readonly declare typeset unset shift source alias eval exec set trap`), 'k'],
    [rx('(?<=^|[;&|]\\s*|\\$\\(\\s*|`\\s*|\\bsudo\\s+|\\bthen\\s+|\\bdo\\s+|\\belse\\s+)(?:[A-Za-z_][\\w.-]*)(?=\\s|$|[;&|)])', 'm'), 'f'],
    [rx('(?:\\|\\||&&|[|&;<>]+|[=~!])'), 'o'], [PUNCT, 'p'],
  ]);

  def('yaml yml', [
    [rx('(?<![\\w"\'])#[^\\n]*'), 'c'], [rx('^---|^\\.\\.\\.', 'm'), 'h'],
    [rx('^[ \\t]*-(?=\\s|$)', 'm'), 'p'], [rx('^[ \\t]*(?:-[ \\t]+)?[^\\s#:\\-][^\\n:]*?(?=:(?:\\s|$))', 'm'), 'a'],
    [DQ, 's'], [SQ, 's'], [rx('[&*][\\w-]+'), 'v'], [rx('![\\w!/]+'), 't'], [NUM, 'n'],
    [kw('true false null yes no on off ~', 'i'), 'k'], [rx('[|>][-+]?(?=\\s*$)', 'm'), 'o'], [rx('[:\\[\\]{},]'), 'p'],
  ]);

  def('diff patch', [
    [rx('^(?:diff |index |--- |\\+\\+\\+ )[^\\n]*', 'm'), 'h'], [rx('^@@[^\\n]*', 'm'), 'c'],
    [rx('^\\+[^\\n]*', 'm'), 'd'], [rx('^-[^\\n]*', 'm'), 'x'], [rx('^[^\\n]*', 'm'), null],
  ]);

  def('html xml svg vue', [
    [rx('<!--[\\s\\S]*?(?:-->|$)'), 'c'], [rx('<![^>]*>'), 'h'], [rx('</?[A-Za-z][\\w:.-]*|/?>'), 'k'],
    [rx('[A-Za-z_:][\\w:.-]*(?==)'), 'a'], [DQ, 's'], [SQ, 's'], [rx('&[#\\w]+;'), 'n'], [rx('='), 'o'],
  ]);

  def('css scss less', [
    [BLOCK_COMMENT, 'c'], [LINE_COMMENT, 'c'], [DQ, 's'], [SQ, 's'], [rx('@[\\w-]+'), 'k'], [rx('!important'), 'k'],
    [rx('#[0-9a-f]{3,8}\\b', 'i'), 'n'], [rx('(?<![\\w-])-?\\d[\\d.]*(?:%|[a-z]+)?', 'i'), 'n'],
    [rx('(?<=[{;\\n]\\s*)[\\w-]+(?=\\s*:)', 'm'), 'a'], [rx('--[\\w-]+'), 'v'], [rx('[.#]?[A-Za-z_-][\\w-]*(?=[\\s,{>+~:\\[]|$)', 'm'), 'v'],
    [FN, 'f'], [rx('[:;{}(),>+~*]'), 'p'],
  ]);

  def('java kotlin kt c cpp c++ h hpp cs csharp go golang rust rs swift scala groovy dart php', [
    [LINE_COMMENT, 'c'], [BLOCK_COMMENT, 'c'], [DQ, 's'], [SQ, 's'], [TPL, 's'], [NUM, 'n'], [rx('@[A-Za-z_][\\w.]*'), 'a'],
    [rx('#\\s*(?:include|define|ifdef|ifndef|endif|pragma|if|else|elif|undef)\\b[^\\n]*'), 'h'],
    [kw(`abstract as assert async await base break case catch chan class const continue crate default defer delete do dyn
      else enum event explicit export extends extern fallthrough final finally fn for foreach func function go goto if
      impl implements import in inline interface internal is lateinit let lock loop macro match mod module mut namespace
      native new object operator out override package params private protected pub public readonly record ref return
      sealed select self Self sizeof static struct super switch synchronized template this throw throws trait transient
      try type typealias typedef typeof union unsafe unsigned use using val var virtual void volatile when where while
      with yield`), 'k'],
    [kw(`true false null nil None undefined bool boolean byte char double float int int8 int16 int32 int64 uint u8 u16 u32
      u64 i8 i16 i32 i64 f32 f64 usize isize long short string String str Int Long Double Float Boolean Unit Any Nothing
      List Map Set Vec Option Result Box Arc Rc HashMap HashSet Integer Object System Math Optional Stream Exception
      RuntimeException Throwable size_t auto`), 't'],
    [FN, 'f'], [OP, 'o'], [PUNCT, 'p'],
  ]);

  def('markdown md', [
    [rx('^#{1,6}[^\\n]*', 'm'), 'h'], [rx('^>[^\\n]*', 'm'), 'c'], [rx('```[^\\n]*|~~~[^\\n]*'), 'k'],
    [rx('\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__'), 'k'], [rx('`[^`\\n]+`'), 's'], [rx('\\[[^\\]\\n]*\\]\\([^)\\n]*\\)'), 'a'],
    [rx('^[ \\t]*(?:[-*+]|\\d+\\.)(?=\\s)', 'm'), 'p'],
  ]);

  def('ini toml conf cfg properties dotenv env', [
    [rx('^[ \\t]*[#;][^\\n]*', 'm'), 'c'], [rx('^\\[[^\\]\\n]*\\]', 'm'), 'h'], [rx('^[ \\t]*[\\w.-]+(?=\\s*=)', 'm'), 'a'],
    [DQ, 's'], [SQ, 's'], [NUM, 'n'], [kw('true false', 'i'), 'k'], [rx('='), 'o'],
  ]);

  def('http', [
    [rx('^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\b[^\\n]*', 'm'), 'h'], [rx('^HTTP/[^\\n]*', 'm'), 'h'],
    [rx('^[A-Za-z-]+(?=:)', 'm'), 'a'], [NUM, 'n'],
  ]);

  function tokenize(code, rules) {
    const out = [];
    let i = 0;
    while (i < code.length) {
      let hit = null;
      for (const [re, cls] of rules) {
        re.lastIndex = i;
        const m = re.exec(code);
        if (m && m.index === i && m[0].length) { hit = [m[0], cls]; break; }
      }
      if (!hit) { FALL.lastIndex = i; const m = FALL.exec(code); hit = [m ? m[0] : code[i], null]; }
      out.push(hit);
      i += hit[0].length;
    }
    return out;
  }

  // Tokens -> HTML: one inline <span class="line"> per source line (its "\n" kept inside it), multi-line tokens split at
  // newlines so every token span stays inside its line. The block's DOM text therefore equals the source exactly, which
  // keeps Copy and the split view's selection mirror honest; the line spans exist for the CSS line-number gutter.
  function toHtml(tokens) {
    const lines = [''];
    const push = (text, cls) => {
      const parts = text.split('\n');
      parts.forEach((part, k) => {
        if (k) lines.push('');
        if (!part) return;
        lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
      });
    };
    tokens.forEach(([text, cls]) => push(text, cls));
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline of the fence
    return lines.map((l, i) => `<span class="line">${l}${i < lines.length - 1 ? '\n' : ''}</span>`).join('');
  }

  const alias = (lang) => { const k = String(lang || '').trim().toLowerCase(); return langs[k] ? langs[k].name : null; };

  function detect(code) {
    const head = code.slice(0, 4000);
    if (/^\s*[{[]/.test(head) && /[}\]]\s*$/.test(code.trimEnd()) && /"\s*:/.test(head)) return 'json';
    if (/^\s*(?:with|select|insert|update|delete|create|alter|drop|msck|show|describe|explain)\b/i.test(head)) return 'sql';
    if (/^(?:diff --git|--- |\+\+\+ |@@ )/m.test(head)) return 'diff';
    if (/^#!.*\b(?:ba|z|da)?sh\b/.test(head) || /^\$ /m.test(head)) return 'bash';
    if (/^\s*(?:def|class)\s+\w+.*:\s*$|^\s*from\s+[\w.]+\s+import\b|^\s*print\(/m.test(head)) return 'python';
    if (/^\s*<(?:!doctype|html|div|svg|\?xml)\b/i.test(head)) return 'html';
    if (/\b(?:const|let|var|function)\s+\w+|=>\s*[{(]|^\s*import .* from ['"]/m.test(head)) return 'javascript';
    if (/^\s*(?:cd|ls|grep|aws|brazil|brazil-build|git|npm|node|python3?|curl|export|echo|mkdir|rm|cp|mv|cat|ssh|kubectl|docker)\s/m.test(head)) return 'bash';
    if (/^[\w-]+:\s*(?:\S|$)/m.test(head) && /^\s+[\w-]+:\s/m.test(head) && !/[{};]/.test(head)) return 'yaml';
    return null;
  }

  // highlight(code, lang) -> { html, lang, lines } ; lang null -> plain (still wrapped in lines)
  function highlight(code, lang) {
    const src = String(code).replace(/\r\n/g, '\n');
    const name = alias(lang) || (lang && String(lang).trim() ? null : detect(src));
    if (name === 'sql' && global.SQLV) return SQLV.highlight(src); // role-based colouring, core/sql.js
    const tokens = name ? tokenize(src, langs[name].rules) : [[src, null]];
    const html = toHtml(tokens);
    return { html, lang: name, lines: src.replace(/\n$/, '').split('\n').length };
  }

  global.HL = { highlight, detect, alias, languages: () => Object.keys(langs) };
})(window);
