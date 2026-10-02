import { parseDocument, parse } from "yaml";
const show = (label, raw, opts = {}) => {
  const doc = parseDocument(raw, opts);
  let out;
  try { out = doc.toString(opts.stringifyOpts ?? {}); } catch (e) { out = `THREW: ${e.message}`; }
  console.log(`--- ${label}\n errors: ${doc.errors.map((e) => `${e.code}@${e.linePos?.[0]?.line}`).join(",")}\n contents: ${doc.contents?.constructor?.name ?? String(doc.contents)}\n toString: ${JSON.stringify(out)}`);
};
show("duplicate keys", `name: first\nname: second\nmax_turns: 3\n`);
try { parse(`name: first\nname: second\n`); console.log("parse(dup): ok"); } catch (e) { console.log("parse(dup) threw:", e.code); }
show("malformed", `name: [unclosed\nmax_turns: 3\n`);
try { parse(`name: [unclosed\n`); console.log("parse(bad): ok"); } catch (e) { console.log("parse(bad) threw:", e.code); }
show("root sequence", `- a\n- b\n`);
show("root scalar", `just a string\n`);
show("empty file", ``);
show("comments only", `# nothing here\n`);
const mixed = `outer:\n  inner:\n    - deep\nindo:\n- one\n- two\nnested:\n  - a\n  - b\n`;
show("mixed seq styles default", mixed);
show("mixed seq styles indentSeq:false", mixed, { stringifyOpts: { indentSeq: false } });
const merged = `base: &base\n  max_tokens: 4096\n  name: from-base\nmodel:\n  <<: *base\n  name: override\n`;
show("merge key (no merge opt)", merged);
show("merge key (merge:true)", merged, { merge: true });
const anchored = `defaults: &d\n  a: 1\ncopy: *d\n`;
const adoc = parseDocument(anchored);
try { adoc.setIn(["copy", "b"], 2); console.log("setIn through alias ok:", JSON.stringify(adoc.toString())); }
catch (e) { console.log("setIn through alias threw:", e.message.split("\n")[0]); }
// indentation detection candidates
for (const [label, raw] of [["2-space", `a:\n  b:\n    c: 1\n`], ["4-space", `a:\n    b:\n        c: 1\n`], ["tab-indented", `a:\n\tb: 1\n`]]) {
  show(label, raw);
}
// does a doc with an error still allow setIn + a *safe* partial stringify? and can errors be cleared?
const d = parseDocument(`name: first\nname: second\n`);
console.log("dup keys array length:", d.contents.items.length, "errors:", d.errors.length);
