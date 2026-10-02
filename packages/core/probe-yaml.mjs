import { parseDocument, parse } from "yaml";

const show = (label, raw, opts = {}) => {
  const doc = parseDocument(raw, opts);
  console.log(`--- ${label}`);
  console.log("errors:", doc.errors.map((e) => `${e.code}@${e.linePos?.[0]?.line}:${e.message.split("\n")[0]}`));
  console.log("warnings:", doc.warnings.map((w) => `${w.code}:${w.message.split("\n")[0]}`));
  console.log("contents:", doc.contents?.constructor?.name ?? String(doc.contents));
  console.log("toString:", JSON.stringify(doc.toString(opts.stringifyOpts ?? {})));
};

// 1. comments + indentless sequence + quoted scalars
const styled = `# top comment\ntools:            # inline comment on a key\n- read_file\n- write_file\n# comment before nested key\nmodel:\n  max_tokens: 4096   # inline\n  name: "quoted value"\n  bare: 'single'\n`;
show("styled (2-space, indentless seq)", styled);
show("styled with indent:4 stringify", styled, { stringifyOpts: { indent: 4 } });

// 2. 4-space indentation document
const four = `model:\n    max_tokens: 4096\n    thinking_level: "medium"\ntools:\n    - a\n    - b\n`;
show("four-space", four);
show("four-space indent:4", four, { stringifyOpts: { indent: 4 } });

// 3. duplicate keys
const dup = `name: first\nname: second\nmax_turns: 3\n`;
show("duplicate keys", dup);
try { parse(dup); console.log("parse(dup): ok"); } catch (e) { console.log("parse(dup) threw:", e.code ?? e.message.split("\n")[0]); }

// 4. malformed
const bad = `name: [unclosed\nmax_turns: 3\n`;
show("malformed", bad);
try { parse(bad); console.log("parse(bad): ok"); } catch (e) { console.log("parse(bad) threw:", e.code); }

// 5. root types
show("root sequence", `- a\n- b\n`);
show("root scalar", `just a string\n`);
show("empty file", ``);
show("comments only", `# nothing here\n`);

// 6. merge key / alias
const merged = `base: &base\n  max_tokens: 4096\n  name: from-base\nmodel:\n  <<: *base\n  name: override\n`;
show("merge key", merged);
show("merge key with merge:true", merged, { merge: true });
const mdoc = parseDocument(merged, { merge: true });
console.log("merged toJS:", JSON.stringify(mdoc.toJS()));

// 7. does setIn traverse an alias?
const anchored = `defaults: &d\n  a: 1\ncopy: *d\n`;
const adoc = parseDocument(anchored);
try { adoc.setIn(["copy", "b"], 2); console.log("setIn through alias ok:", JSON.stringify(adoc.toString())); }
catch (e) { console.log("setIn through alias threw:", e.message.split("\n")[0]); }
